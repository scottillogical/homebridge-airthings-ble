import cbor from "cbor"
import { CONNECTIVITY_MODE, SensorMap } from "../const.js"
import type { LoggerLike } from "../commandDecode.js"
import { AtomRequestPath } from "./requestPath.js"

export type ConnectivityMode = "Not configured" | "Bluetooth" | "SmartLink" | "unknown"

export function connectivityModeFromAtomInt(value: number): ConnectivityMode {
  if (value === 0) return "Not configured"
  if (value === 1) return "SmartLink"
  if (value === 4) return "Bluetooth"
  return "unknown"
}

/**
 * reassembled atom payload header (not the 3-byte notification fragment header).
 * a single-fragment notification is `10 01 00` + this payload; that prefix is
 * stripped before parse. see AtomNotificationReceiver.
 */
const HEADER = Buffer.from("0345", "hex")

function mapGet(obj: unknown, key: number): unknown {
  if (obj instanceof Map) {
    return obj.get(key)
  }
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string | number, unknown>
    return rec[key] ?? rec[String(key)]
  }
  return undefined
}

function asSensorMap(data: unknown): SensorMap {
  if (data instanceof Map) {
    const out: SensorMap = {}
    for (const [k, v] of data.entries()) {
      out[String(k)] = v as SensorMap[string]
    }
    return out
  }
  if (data && typeof data === "object" && !Array.isArray(data) && !Buffer.isBuffer(data)) {
    return data as SensorMap
  }
  throw new Error("Invalid response data type")
}

export class AtomResponse {
  private readonly logger: LoggerLike
  private readonly response: Buffer
  private readonly randomBytes: Buffer
  private readonly path: AtomRequestPath

  constructor(
    logger: LoggerLike,
    response: Buffer | null,
    randomBytes: Buffer,
    path: AtomRequestPath,
  ) {
    this.logger = logger
    if (!response) {
      throw new Error("Response cannot be None")
    }
    this.response = response
    this.randomBytes = randomBytes
    this.path = path
  }

  parse(): SensorMap | null {
    if (this.response.length < 2 || !this.response.subarray(0, 2).equals(HEADER)) {
      this.logger.error(
        `Invalid response header, expected ${HEADER.toString("hex")}, but got ${this.response.subarray(0, Math.min(2, this.response.length)).toString("hex")}`,
      )
      throw new Error("Invalid response header")
    }

    if (this.response.length < 4 || !this.response.subarray(2, 4).equals(this.randomBytes)) {
      this.logger.debug(
        `Invalid response checksum, expected ${this.randomBytes.toString("hex")}, but got ${this.response.subarray(2, Math.min(4, this.response.length)).toString("hex")}`,
      )
      throw new Error("Invalid response checksum")
    }

    if (this.response.length < 6) {
      throw new Error("Response too short")
    }

    if (this.response[4] !== 0x81) {
      this.logger.debug(`Invalid response type, expected 81, but got ${this.response[4]}`)
      throw new Error("Invalid response type")
    }

    if (this.response[5] !== 0xa2) {
      this.logger.debug(`Invalid response array length, expected 2, but got ${this.response[5]}`)
      throw new Error("Invalid response array length")
    }

    const dataBytes = this.response.subarray(4)
    const decodedData = cbor.decodeFirstSync(dataBytes)

    if (!Array.isArray(decodedData)) {
      this.logger.debug(`Parsed data is not a list, but a ${typeof decodedData}`)
      throw new Error("Invalid response data type")
    }

    const first = decodedData[0]
    const path = mapGet(first, 0)
    if (path === undefined) {
      throw new Error("Response path missing")
    }
    if (path !== this.path) {
      this.logger.error(
        `Response path does not match request path, expected ${this.path} but got ${String(path)}`,
      )
      throw new Error("Response path does not match request path")
    }

    let data = mapGet(first, 2)
    if (data === undefined) {
      throw new Error("Response data missing")
    }

    if (this.path === AtomRequestPath.CONNECTIVITY_MODE && typeof data === "number") {
      return {
        [CONNECTIVITY_MODE]: connectivityModeFromAtomInt(data),
      }
    }

    if (this.path === AtomRequestPath.LATEST_VALUES) {
      if (Buffer.isBuffer(data)) {
        data = cbor.decodeFirstSync(data)
      }
      return asSensorMap(data)
    }

    this.logger.debug(`Response data: ${JSON.stringify(data)}`)
    throw new Error("Invalid response data type")
  }
}
