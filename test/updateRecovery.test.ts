import assert from "node:assert/strict"
import { rmSync } from "node:fs"
import { afterEach, describe, it } from "node:test"
import type { Logging } from "homebridge"
import { AirthingsClient, UnsupportedDeviceError } from "../src/airthings/client.js"
import { bleAdapterLockPath } from "../src/ble/adapterLock.js"
import { BleScanner } from "../src/ble/scanner.js"
import type { NodeBleDevice } from "../src/ble/nodeBle.js"

const silentLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function mockLog(): Logging {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as unknown as Logging
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * gatt device whose model characteristic is present but the read fails,
 * or returns a string that is not an airthings model.
 */
function modelOnlyDevice(model: string | null, readError?: Error): NodeBleDevice {
  const modelChar = {
    async readValue() {
      if (readError) throw readError
      return Buffer.from(model ?? "")
    },
    async startNotifications() { return undefined },
    async stopNotifications() { return undefined },
    on() { return modelChar },
    removeListener() { return modelChar },
  }
  return {
    async getName() { return "" },
    async getAddress() { return "AA:BB:CC:DD:EE:FF" },
    async isConnected() { return true },
    async connect() { return undefined },
    async disconnect() { return undefined },
    async gatt() {
      return {
        async services() { return ["info"] },
        async getPrimaryService() {
          return {
            async characteristics() { return ["00002a24-0000-1000-8000-00805f9b34fb"] },
            async getCharacteristic() { return modelChar },
          }
        },
      }
    },
  } as unknown as NodeBleDevice
}

describe("model read failures stay retryable", () => {
  it("does not treat a failed model read as an unsupported device", async () => {
    const client = new AirthingsClient({ logger: silentLogger, maxAttempts: 1 })
    await assert.rejects(
      () => client.updateDevice(modelOnlyDevice(null, new Error("read failed"))),
      (err: unknown) => {
        assert.equal(err instanceof UnsupportedDeviceError, false)
        assert.match(String(err), /Model number was not read/)
        return true
      },
    )
  })

  it("rejects a model string that is not a known airthings device", async () => {
    const client = new AirthingsClient({ logger: silentLogger, maxAttempts: 1 })
    await assert.rejects(
      () => client.updateDevice(modelOnlyDevice("9999")),
      (err: unknown) => err instanceof UnsupportedDeviceError && /9999/.test(String(err)),
    )
  })
})

describe("disconnect cleanup is bounded", () => {
  it("rejects instead of holding the adapter when disconnect never replies", async () => {
    const device = {
      async getName() { return "" },
      async isConnected() { return false },
      async connect() { throw new Error("connect failed") },
      disconnect() { return new Promise<void>(() => undefined) },
    } as unknown as NodeBleDevice
    const client = new AirthingsClient({ logger: silentLogger, maxAttempts: 1 })
    const outcome = await Promise.race([
      client.updateDevice(device).then(() => "resolved", (err: unknown) => err),
      sleep(7000).then(() => "hung"),
    ])
    assert.notEqual(outcome, "hung")
    assert.ok(outcome instanceof Error)
    assert.match(outcome.message, /connect failed/)
  })
})

const HCI_KEEP = 98
const HCI_DROP = 99

afterEach(() => {
  for (const id of [HCI_KEEP, HCI_DROP]) {
    rmSync(bleAdapterLockPath(id), { recursive: true, force: true })
  }
})

function seededScanner(hciDeviceId: number, update: () => Promise<unknown>): BleScanner {
  const scanner = new BleScanner(mockLog(), {
    scanDurationSec: 5,
    refreshIntervalSec: 300,
    isMetric: true,
    debug: false,
    devices: [],
    hciDeviceId,
  })
  const internal = scanner as unknown as {
    bus: { adapter: { isDiscovering: () => Promise<boolean> } }
    getBleDevice: (address: string) => Promise<unknown>
    client: { updateDevice: () => Promise<unknown> }
  }
  internal.bus = { adapter: { isDiscovering: async () => false } }
  internal.getBleDevice = async () => ({})
  internal.client.updateDevice = update
  scanner.seedKnownDevice({
    serialNumber: "3220001333",
    address: "b0:d2:78:60:5d:4f",
    displayName: "Wave Enhance",
  })
  return scanner
}

describe("poll keeps a device unless the model is unsupported", () => {
  it("leaves a cache-seeded wave enhance in the poll set after a transport error", async () => {
    const scanner = seededScanner(HCI_KEEP, async () => {
      throw new Error("Model number was not read")
    })
    await assert.rejects(() => scanner.pollDevice(scanner.getDiscovered()[0]), /Model number was not read/)
    assert.equal(scanner.getDiscovered().length, 1)
    assert.equal(scanner.getDiscovered()[0].serialNumber, "3220001333")
  })

  it("drops a device whose model string is not supported", async () => {
    const scanner = seededScanner(HCI_DROP, async () => {
      throw new UnsupportedDeviceError("Model 9999 is not supported")
    })
    const result = await scanner.pollDevice(scanner.getDiscovered()[0])
    assert.equal(result, null)
    assert.equal(scanner.getDiscovered().length, 0)
  })
})
