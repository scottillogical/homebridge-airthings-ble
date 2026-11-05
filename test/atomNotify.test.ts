import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { AtomNotificationReceiver } from "../src/airthings/commandDecode.js"
import { AtomResponse } from "../src/airthings/atom/response.js"
import { AtomRequestPath } from "../src/airthings/atom/requestPath.js"
import { AirthingsClient } from "../src/airthings/client.js"
import { AirthingsDeviceType } from "../src/airthings/deviceType.js"
import {
  BATTERY,
  CHAR_UUID_FIRMWARE_REV,
  CHAR_UUID_MODEL_NUMBER_STRING,
  CO2,
  COMMAND_UUID_ATOM,
  COMMAND_UUID_ATOM_NOTIFY,
  HUMIDITY,
  LUX,
  NOISE,
  PRESSURE,
  TEMPERATURE,
  VOC,
} from "../src/airthings/const.js"
import type { NodeBleDevice, NodeBleGattCharacteristic } from "../src/ble/nodeBle.js"

const silentLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** official wave enhance latest-values payload, without the fragment header */
const WAVE_ENHANCE_PAYLOAD = Buffer.from(
  "0345a1b281a2006d32393939392f302f333130313202583ea9634e4f49"
  + "182763544d501972f06348554d190d2f63434f321902dc63564f43190115634c5"
  + "55801635052531a005f364663424154190b346354494d1876",
  "hex",
)

const CONNECT_PAYLOAD = Buffer.from(
  "03455f9381a2006a31372f302f33313130300204",
  "hex",
)

function atomFragments(response: Buffer, size = 20): Buffer[] {
  const step = size - 3
  const parts: Buffer[] = []
  for (let start = 0; start < response.length; start += step) {
    parts.push(response.subarray(start, start + step))
  }
  return [
    Buffer.concat([
      Buffer.from([0x10]),
      uint16(parts.length),
      parts[0],
    ]),
    ...parts.slice(1).map((part, index) => Buffer.concat([
      Buffer.from([0x00]),
      uint16(index + 2),
      part,
    ])),
  ]
}

function uint16(value: number): Buffer {
  const buf = Buffer.alloc(2)
  buf.writeUInt16LE(value)
  return buf
}

function feed(fragments: string[]): AtomNotificationReceiver {
  const receiver = new AtomNotificationReceiver()
  for (const fragment of fragments) {
    receiver.push(Buffer.from(fragment, "hex"))
  }
  return receiver
}

describe("atom notification reassembly", () => {
  const cases: Array<[string[], string]> = [
    [["100100aabbcc"], "aabbcc"],
    [["100300aa", "000200bb", "000300cc"], "aabbcc"],
    [["100300aa", "000300cc", "000200bb"], "aabbcc"],
    [["000300cc", "100300aa", "000200bb"], "aabbcc"],
    [["300200aa", "200200bb"], "aabb"],
    [["400200dd", "100200aa", "000200bb"], "aabb"],
    [["100200aa", "000100dd", "000200bb"], "aabb"],
    [["100200aa", "300100dd", "000200bb"], "aabb"],
  ]

  for (const [fragments, expected] of cases) {
    it(`joins ${fragments.join(" ")}`, () => {
      const receiver = feed(fragments)
      assert.equal(receiver.complete, true)
      assert.equal(receiver.message?.toString("hex"), expected)
    })
  }

  const incomplete = [
    ["100300aa", "000200bb"],
    ["000200bb", "000300cc"],
    ["100000aa"],
    [""],
    ["10"],
    ["1003"],
    ["110100aa"],
    ["100200aa", "200200bb"],
    ["100200aa", "000100bb"],
    ["100002aa", "000200bb"],
  ]

  for (const fragments of incomplete) {
    it(`waits when given ${fragments.join(" ") || "(empty)"}`, async () => {
      const receiver = feed(fragments)
      await assert.rejects(() => receiver.waitForMessage(0.02), /Timeout/)
      assert.equal(receiver.complete, false)
    })
  }

  it("keeps a response that finishes after the wait timed out", async () => {
    const receiver = new AtomNotificationReceiver()
    receiver.push(Buffer.from("100200aa", "hex"))
    await assert.rejects(() => receiver.waitForMessage(0.01), /Timeout/)
    receiver.push(Buffer.from("000200bb", "hex"))
    assert.equal(receiver.complete, true)
    assert.equal(receiver.message?.toString("hex"), "aabb")
  })

  it("ignores a late fragment after the response is complete", () => {
    const receiver = feed(["100100aa", "100100bb"])
    assert.equal(receiver.message?.toString("hex"), "aa")
  })

  it("parses a reassembled wave enhance payload and rejects the raw notification", () => {
    const wire = atomFragments(WAVE_ENHANCE_PAYLOAD, WAVE_ENHANCE_PAYLOAD.length + 3)
    assert.equal(wire.length, 1)
    assert.equal(wire[0].subarray(0, 3).toString("hex"), "100100")

    const raw = new AtomResponse(
      silentLogger,
      wire[0],
      WAVE_ENHANCE_PAYLOAD.subarray(2, 4),
      AtomRequestPath.LATEST_VALUES,
    )
    assert.throws(() => raw.parse(), /Invalid response header/)

    const receiver = new AtomNotificationReceiver()
    receiver.push(wire[0])
    assert.deepEqual(receiver.message, WAVE_ENHANCE_PAYLOAD)
    const parsed = new AtomResponse(
      silentLogger,
      receiver.message,
      WAVE_ENHANCE_PAYLOAD.subarray(2, 4),
      AtomRequestPath.LATEST_VALUES,
    ).parse()
    assert.equal(parsed?.TMP, 29424)
  })
})

interface FakeWave {
  device: NodeBleDevice
  notifications: Buffer[]
}

function fakeWaveEnhance(options?: {
  model?: string | null
  modelError?: Error
  fragmentSize?: number
  gapMs?: number
  stopNotifications?: () => Promise<void>
  disconnect?: () => Promise<void>
  connect?: () => Promise<void>
  connected?: boolean
}): FakeWave {
  const notifications: Buffer[] = []
  const listeners = new Set<(data: Buffer) => void>()
  const fragmentSize = options?.fragmentSize ?? 20
  const gapMs = options?.gapMs ?? 0
  const connected = options?.connected ?? true

  const chars = new Map<string, NodeBleGattCharacteristic>()
  chars.set(CHAR_UUID_MODEL_NUMBER_STRING, readable(async () => {
    if (options?.modelError) throw options.modelError
    if (!options?.model && options?.model !== undefined) return Buffer.alloc(0)
    return Buffer.from(options?.model ?? "3220")
  }))
  chars.set(CHAR_UUID_FIRMWARE_REV, readable(async () => Buffer.from("T-SUB-3.0.3-master+0")))

  const notify = characteristic({
    stopNotifications: options?.stopNotifications ?? (async () => undefined),
    on(_event, listener) {
      listeners.add(listener as (data: Buffer) => void)
      return notify
    },
    removeListener(_event, listener) {
      listeners.delete(listener as (data: Buffer) => void)
      return notify
    },
  })
  chars.set(COMMAND_UUID_ATOM_NOTIFY, notify)

  const write = characteristic({
    async writeValue(buffer: Buffer) {
      const random = buffer.subarray(2, 4)
      const latest = buffer.includes(Buffer.from("29999/0/31012"))
      const known = latest ? WAVE_ENHANCE_PAYLOAD : CONNECT_PAYLOAD
      const response = Buffer.concat([
        Buffer.from("0345", "hex"),
        random,
        known.subarray(4),
      ])
      const fragments = atomFragments(response, fragmentSize)
      fragments.forEach((fragment, index) => {
        const deliver = () => {
          const copy = Buffer.from(fragment)
          notifications.push(copy)
          for (const listener of listeners) listener(copy)
        }
        if (gapMs === 0) deliver()
        else setTimeout(deliver, index * gapMs)
      })
    },
  })
  chars.set(COMMAND_UUID_ATOM, write)

  const device = {
    async getName() {
      return ""
    },
    async getAddress() {
      return "AA:BB:CC:DD:EE:FF"
    },
    async isConnected() {
      return connected
    },
    connect: options?.connect ?? (async () => undefined),
    disconnect: options?.disconnect ?? (async () => undefined),
    async gatt() {
      return {
        async services() {
          return ["info", "atom"]
        },
        async getPrimaryService(service: string) {
          const ids = service === "atom"
            ? [COMMAND_UUID_ATOM, COMMAND_UUID_ATOM_NOTIFY]
            : [CHAR_UUID_MODEL_NUMBER_STRING, CHAR_UUID_FIRMWARE_REV]
          return {
            async characteristics() {
              return ids
            },
            async getCharacteristic(id: string) {
              const char = chars.get(id)
              if (!char) throw new Error(`missing ${id}`)
              return char
            },
          }
        },
      }
    },
  }

  return { device: device as unknown as NodeBleDevice, notifications }
}

function readable(readValue: () => Promise<Buffer>): NodeBleGattCharacteristic {
  return characteristic({ readValue })
}

function characteristic(
  impl: Partial<NodeBleGattCharacteristic>,
): NodeBleGattCharacteristic {
  const char = {
    async readValue() {
      return Buffer.alloc(0)
    },
    async writeValue() {
      return undefined
    },
    async startNotifications() {
      return undefined
    },
    async stopNotifications() {
      return undefined
    },
    on() {
      return char
    },
    removeListener() {
      return char
    },
    ...impl,
  }
  return char as NodeBleGattCharacteristic
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("wave enhance update over 20-byte notifications", () => {
  it("reads sensors when fragments arrive slower than the old settle window", async () => {
    const fake = fakeWaveEnhance({ gapMs: 180 })
    const client = new AirthingsClient({
      logger: silentLogger,
      isMetric: true,
      maxAttempts: 1,
    })
    const started = Date.now()
    const device = await Promise.race([
      client.updateDevice(fake.device),
      sleep(4000).then(() => {
        throw new Error("update hung")
      }),
    ])
    assert.ok(Date.now() - started < 4000)
    assert.equal(device.model, AirthingsDeviceType.WAVE_ENHANCE_US)
    assert.equal(device.sensors[TEMPERATURE], 21.09)
    assert.equal(device.sensors[HUMIDITY], 33.75)
    assert.equal(device.sensors[CO2], 732)
    assert.equal(device.sensors[VOC], 277)
    assert.equal(device.sensors[LUX], 1)
    assert.equal(device.sensors[NOISE], 39)
    assert.equal(device.sensors[BATTERY], 87)
    assert.ok(Math.abs(Number(device.sensors[PRESSURE]) - (6239814 / 6400)) < 1e-9)
    const heads = fake.notifications.filter((fragment) => fragment[0] & 0x10)
    assert.ok(heads.length >= 2)
    for (const head of heads) {
      assert.ok(head.readUInt16LE(1) > 1)
    }
  })

  it("returns the sample when stopping notifications never replies", async () => {
    const fake = fakeWaveEnhance({
      gapMs: 0,
      stopNotifications: () => new Promise(() => undefined),
    })
    const client = new AirthingsClient({
      logger: silentLogger,
      isMetric: true,
      maxAttempts: 1,
    })
    const started = Date.now()
    const device = await Promise.race([
      client.updateDevice(fake.device),
      sleep(8000).then(() => {
        throw new Error("update hung on stopNotifications")
      }),
    ])
    const elapsed = Date.now() - started
    assert.ok(elapsed < 8000, `elapsed ${elapsed}`)
    assert.equal(device.sensors[TEMPERATURE], 21.09)
  })
})
