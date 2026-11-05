import { BATTERY, COMMAND_UUID_WAVE_2, COMMAND_UUID_WAVE_MINI, COMMAND_UUID_WAVE_PLUS, SensorMap } from "./const.js"
import { AtomRequest } from "./atom/request.js"
import { AtomRequestPath } from "./atom/requestPath.js"
import { AtomResponse } from "./atom/response.js"

export type LoggerLike = {
  debug: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}

/** collect multi-packet notify payloads */
export class NotificationReceiver {
  message: Buffer | null = null
  private readonly messageSize: number
  private resolveWait: (() => void) | null = null
  private rejectWait: ((err: Error) => void) | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(messageSize: number) {
    this.messageSize = messageSize
  }

  private fullMessageReceived(): boolean {
    return this.message !== null && this.message.length >= this.messageSize
  }

  handle = (_data: Buffer, isNotification?: boolean): void => {
    // noble callback signature varies: (data) or (data, isNotification)
    void isNotification
    const data = _data
    if (this.message === null) {
      this.message = Buffer.from(data)
    } else if (!this.fullMessageReceived()) {
      this.message = Buffer.concat([this.message, data])
    }
    if (this.fullMessageReceived() && this.resolveWait) {
      this.clearTimer()
      const resolve = this.resolveWait
      this.resolveWait = null
      this.rejectWait = null
      resolve()
    }
  }

  // noble may call with (data) only
  asCallback = (data: Buffer): void => {
    this.handle(data)
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  waitForMessage(timeoutSec: number): Promise<void> {
    if (this.fullMessageReceived()) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      this.resolveWait = resolve
      this.rejectWait = reject
      this.timer = setTimeout(() => {
        this.resolveWait = null
        this.rejectWait = null
        reject(new Error("Timeout waiting for message"))
      }, timeoutSec * 1000)
    })
  }
}

const ATOM_FRAGMENT_HEADER_SIZE = 3

/**
 * reassemble an atom notify stream.
 *
 * every notification starts with a 3-byte fragment header. the low nibble of
 * the control byte is the fragmentation version, bit 4 marks the first
 * fragment, and the top three bits identify the response. the next two
 * little-endian bytes are the fragment count on the first fragment and the
 * 1-based position on the others.
 *
 * bluez's default att mtu is 23, so notifications are 20 bytes. wave enhance
 * latest-values replies do not fit in one of those.
 */
export class AtomNotificationReceiver {
  message: Buffer | null = null
  private readonly fragments = new Map<number, Map<number, Buffer>>()
  private fragmentCount = 0
  private objectId: number | null = null
  private resolveWait: (() => void) | null = null
  private timer: NodeJS.Timeout | null = null

  get complete(): boolean {
    return this.message !== null
  }

  push(data: Buffer): void {
    if (this.message !== null || data.length < ATOM_FRAGMENT_HEADER_SIZE) {
      return
    }
    const control = data[0]
    if (control & 0x0f) {
      return
    }
    const objectId = control & 0xe0
    if (this.objectId !== null && objectId !== this.objectId) {
      return
    }
    const number = data.readUInt16LE(1)
    let bucket = this.fragments.get(objectId)
    if (!bucket) {
      bucket = new Map()
      this.fragments.set(objectId, bucket)
    }
    const payload = Buffer.from(data.subarray(ATOM_FRAGMENT_HEADER_SIZE))
    if (control & 0x10) {
      this.objectId = objectId
      this.fragmentCount = number
      bucket.set(1, payload)
    } else if (number > 1) {
      bucket.set(number, payload)
    }
    if (this.objectId === null) {
      return
    }
    const parts = this.fragments.get(this.objectId)
    if (!parts || this.fragmentCount < 1) {
      return
    }
    const chunks: Buffer[] = []
    for (let position = 1; position <= this.fragmentCount; position++) {
      const chunk = parts.get(position)
      if (!chunk) {
        return
      }
      chunks.push(chunk)
    }
    this.message = Buffer.concat(chunks)
    if (this.resolveWait) {
      this.clearTimer()
      const resolve = this.resolveWait
      this.resolveWait = null
      resolve()
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  waitForMessage(timeoutSec: number): Promise<void> {
    if (this.complete) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      this.resolveWait = resolve
      this.timer = setTimeout(() => {
        this.resolveWait = null
        reject(new Error("Timeout waiting for message"))
      }, timeoutSec * 1000)
    })
  }
}

export abstract class CommandDecode {
  cmd: Buffer = Buffer.from([0x6d])
  formatTypeSize = 0

  abstract decodeData(logger: LoggerLike, raw: Buffer | null): SensorMap | null

  validateData(logger: LoggerLike, raw: Buffer | null): number[] | null {
    if (!raw) {
      logger.debug("Validate data: No data received")
      return null
    }
    const cmd = raw.subarray(0, 1)
    if (!cmd.equals(this.cmd)) {
      logger.warn(
        `Result for wrong command received, expected ${this.cmd.toString("hex")} got ${cmd.toString("hex")}`,
      )
      return null
    }
    // devices may append padding; require at least the packed payload size
    if (raw.length - 2 < this.formatTypeSize) {
      logger.warn(
        `Wrong length data received (${raw.length - 2}) versus expected (>=${this.formatTypeSize})`,
      )
      return null
    }
    return this.unpack(raw.subarray(2, 2 + this.formatTypeSize))
  }

  protected abstract unpack(body: Buffer): number[]

  makeDataReceiver(): NotificationReceiver {
    // wait for cmd byte + padding byte + packed body (full notify message)
    return new NotificationReceiver(this.formatTypeSize + 2)
  }
}

/** format <L2BH2B9H — battery at index 13 */
export class WaveRadonAndPlusCommandDecode extends CommandDecode {
  constructor() {
    super()
    // L(4) + 2B(2) + H(2) + 2B(2) + 9H(18) = 28... wait official is <L2BH2B9H
    // L=4, B=1,B=1, H=2, B=1,B=1, 9*H=18 → 4+1+1+2+1+1+18 = 28
    this.formatTypeSize = 4 + 1 + 1 + 2 + 1 + 1 + 18
  }

  protected unpack(body: Buffer): number[] {
    const vals: number[] = []
    let o = 0
    vals.push(body.readUInt32LE(o)); o += 4
    vals.push(body.readUInt8(o++)); vals.push(body.readUInt8(o++))
    vals.push(body.readUInt16LE(o)); o += 2
    vals.push(body.readUInt8(o++)); vals.push(body.readUInt8(o++))
    for (let i = 0; i < 9; i++) {
      vals.push(body.readUInt16LE(o)); o += 2
    }
    return vals
  }

  decodeData(logger: LoggerLike, raw: Buffer | null): SensorMap | null {
    const val = this.validateData(logger, raw)
    if (!val) {
      return null
    }
    return { [BATTERY]: val[13] / 1000.0 }
  }
}

/** format <2L4B2HL4HL — battery at index 11 */
export class WaveMiniCommandDecode extends CommandDecode {
  constructor() {
    super()
    // 2L(8) + 4B(4) + 2H(4) + L(4) + 4H(8) + L(4) = 32
    this.formatTypeSize = 8 + 4 + 4 + 4 + 8 + 4
  }

  protected unpack(body: Buffer): number[] {
    const vals: number[] = []
    let o = 0
    vals.push(body.readUInt32LE(o)); o += 4
    vals.push(body.readUInt32LE(o)); o += 4
    for (let i = 0; i < 4; i++) vals.push(body.readUInt8(o++))
    vals.push(body.readUInt16LE(o)); o += 2
    vals.push(body.readUInt16LE(o)); o += 2
    vals.push(body.readUInt32LE(o)); o += 4
    for (let i = 0; i < 4; i++) {
      vals.push(body.readUInt16LE(o)); o += 2
    }
    vals.push(body.readUInt32LE(o))
    return vals
  }

  decodeData(logger: LoggerLike, raw: Buffer | null): SensorMap | null {
    const val = this.validateData(logger, raw)
    if (!val) {
      return null
    }
    return { [BATTERY]: val[11] / 1000.0 }
  }
}

export class AtomCommandDecode extends CommandDecode {
  request: AtomRequest

  constructor(url: AtomRequestPath = AtomRequestPath.LATEST_VALUES) {
    super()
    this.formatTypeSize = 0
    this.request = new AtomRequest(url)
    this.cmd = this.request.asBytes()
  }

  setRequest(url: AtomRequestPath): void {
    this.request = new AtomRequest(url)
    this.cmd = this.request.asBytes()
  }

  protected unpack(_body: Buffer): number[] {
    return []
  }

  decodeData(logger: LoggerLike, raw: Buffer | null): SensorMap | null {
    try {
      const response = new AtomResponse(logger, raw, this.request.randomBytes, this.request.url)
      return response.parse()
    } catch (err) {
      logger.error(`Failed to decode atom command response: ${String(err)}`)
      return null
    }
  }
}

export const COMMAND_DECODERS: Record<string, () => CommandDecode> = {
  [COMMAND_UUID_WAVE_2]: () => new WaveRadonAndPlusCommandDecode(),
  [COMMAND_UUID_WAVE_PLUS]: () => new WaveRadonAndPlusCommandDecode(),
  [COMMAND_UUID_WAVE_MINI]: () => new WaveMiniCommandDecode(),
}

export function getCommandDecoder(uuid: string): CommandDecode | undefined {
  const key = uuid.toLowerCase()
  if (COMMAND_DECODERS[key]) {
    return COMMAND_DECODERS[key]()
  }
  const compact = key.replace(/-/g, "")
  for (const [k, factory] of Object.entries(COMMAND_DECODERS)) {
    if (k.replace(/-/g, "") === compact) {
      return factory()
    }
  }
  return undefined
}
