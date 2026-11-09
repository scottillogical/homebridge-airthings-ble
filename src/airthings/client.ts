import { RADON_1DAY_BQ } from "./const.js"
import {
  ATOM_BAT,
  ATOM_CO2,
  ATOM_HUMIDITY,
  ATOM_LUX,
  ATOM_NOISE,
  ATOM_PRESSURE,
  ATOM_RADON_1DAY_AVG,
  ATOM_RADON_MONTH_AVG,
  ATOM_RADON_MONTH_AVG_ALT,
  ATOM_RADON_WEEK_AVG,
  ATOM_RADON_YEAR_AVG,
  ATOM_TEMPERATURE,
  ATOM_VOC,
  BATTERY,
  BQ_TO_PCI_MULTIPLIER,
  CHAR_UUID_DEVICE_NAME,
  CHAR_UUID_FIRMWARE_REV,
  CHAR_UUID_HARDWARE_REV,
  CHAR_UUID_MANUFACTURER_NAME,
  CHAR_UUID_MODEL_NUMBER_STRING,
  CHAR_UUID_SERIAL_NUMBER_STRING,
  CHAR_UUID_WAVE_2_DATA,
  CHAR_UUID_WAVE_PLUS_DATA,
  CHAR_UUID_WAVEMINI_DATA,
  CHAR_UUID_DATETIME,
  CHAR_UUID_HUMIDITY,
  CHAR_UUID_ILLUMINANCE_ACCELEROMETER,
  CHAR_UUID_RADON_1DAYAVG,
  CHAR_UUID_RADON_LONG_TERM_AVG,
  CHAR_UUID_TEMPERATURE,
  CO2,
  COMMAND_TIMEOUT_MS,
  COMMAND_UUID_ATOM,
  COMMAND_UUID_ATOM_NOTIFY,
  COMMAND_UUID_WAVE_2,
  COMMAND_UUID_WAVE_MINI,
  COMMAND_UUID_WAVE_PLUS,
  DATE_TIME,
  DEFAULT_MAX_UPDATE_ATTEMPTS,
  HUMIDITY,
  ILLUMINANCE,
  LUX,
  NOISE,
  PRESSURE,
  RADON_1DAY_AVG,
  RADON_1DAY_LEVEL,
  RADON_LONGTERM_AVG,
  RADON_LONGTERM_LEVEL,
  RADON_MONTH_AVG,
  RADON_MONTH_LEVEL,
  RADON_WEEK_AVG,
  RADON_WEEK_LEVEL,
  RADON_YEAR_AVG,
  RADON_YEAR_LEVEL,
  SensorMap,
  TEMPERATURE,
  UPDATE_TIMEOUT_MS,
  VOC,
} from "./const.js"
import {
  AtomCommandDecode,
  AtomNotificationReceiver,
  getCommandDecoder,
  type LoggerLike,
} from "./commandDecode.js"
import { AtomRequestPath } from "./atom/requestPath.js"
import {
  AirthingsDeviceType,
  batteryPercentage,
  deviceTypeFromRaw,
  isAtomDevice,
  productName,
} from "./deviceType.js"
import {
  formatVersion,
  needsFirmwareUpgrade,
  parseFirmwareVersion,
  requiredFirmwareForModel,
} from "./firmware.js"
import { getRadonLevel } from "./radonLevel.js"
import { getSensorDecoder } from "./sensorDecoders.js"
import { AirthingsDevice, emptyDevice } from "./types.js"
import {
  mapAllCharacteristics,
  type NodeBleDevice,
  type NodeBleGattCharacteristic,
  uuidKey,
} from "../ble/nodeBle.js"

const SENSOR_CHAR_UUIDS = new Set(
  [
    CHAR_UUID_DATETIME,
    CHAR_UUID_TEMPERATURE,
    CHAR_UUID_HUMIDITY,
    CHAR_UUID_RADON_1DAYAVG,
    CHAR_UUID_RADON_LONG_TERM_AVG,
    CHAR_UUID_ILLUMINANCE_ACCELEROMETER,
    CHAR_UUID_WAVE_PLUS_DATA,
    CHAR_UUID_WAVE_2_DATA,
    CHAR_UUID_WAVEMINI_DATA,
    COMMAND_UUID_WAVE_2,
    COMMAND_UUID_WAVE_PLUS,
    COMMAND_UUID_WAVE_MINI,
  ].map((u) => uuidKey(u)),
)

const CONNECT_SETTLE_MS = 1_500
const POST_TIMEOUT_WORK_WAIT_MS = UPDATE_TIMEOUT_MS
/** match govee-ble so a hung bluez reply cannot hold the shared adapter lock */
const DISCONNECT_TIMEOUT_MS = 2_000
const STOP_NOTIFY_TIMEOUT_MS = 2_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function isConnected(device: NodeBleDevice): Promise<boolean> {
  try {
    const v = await device.isConnected()
    return v === true || v === "true"
  } catch {
    return false
  }
}

async function connectDevice(device: NodeBleDevice): Promise<void> {
  if (await isConnected(device)) {
    return
  }
  await device.connect()
  await sleep(CONNECT_SETTLE_MS)
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function disconnectDevice(device: NodeBleDevice): Promise<void> {
  // always try disconnect — cancels an in-progress bluez Connect that has not
  // flipped Connected=true yet (e.g. after a wall-clock timeout).
  // bound the wait: a wedged dbus reply must not hold the shared adapter lock.
  try {
    await withTimeout(
      device.disconnect(),
      DISCONNECT_TIMEOUT_MS,
      "disconnect timed out",
    )
  } catch {
    // ignore disconnect errors and hung bluez replies
  }
}

async function stopNotifications(char: NodeBleGattCharacteristic): Promise<void> {
  try {
    await withTimeout(
      char.stopNotifications(),
      STOP_NOTIFY_TIMEOUT_MS,
      "stop notifications timed out",
    )
  } catch {
    // ignore
  }
}

function hasPrimarySensors(sensors: SensorMap): boolean {
  const keys = [
    TEMPERATURE,
    HUMIDITY,
    RADON_1DAY_AVG,
    RADON_LONGTERM_AVG,
    BATTERY,
    CO2,
    VOC,
    PRESSURE,
    ILLUMINANCE,
    LUX,
  ]
  return keys.some((k) => sensors[k] !== undefined && sensors[k] !== null)
}

export class UnsupportedDeviceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsupportedDeviceError"
  }
}

export interface ClientOptions {
  logger: LoggerLike
  isMetric?: boolean
  maxAttempts?: number
}

/**
 * connect to an airthings device over node-ble/bluez and read sensor data.
 * protocol port of https://github.com/Airthings/airthings-ble
 */
export class AirthingsClient {
  private readonly logger: LoggerLike
  private readonly isMetric: boolean
  private readonly maxAttempts: number
  /** generation counter so timed-out attempts ignore late results */
  private updateGeneration = 0
  /** reuse gatt chars — remapping each poll stacks dbus PropertiesChanged listeners */
  private readonly charCache = new WeakMap<
    NodeBleDevice,
    Map<string, { uuid: string, char: NodeBleGattCharacteristic }>
  >()

  constructor(options: ClientOptions) {
    this.logger = options.logger
    this.isMetric = options.isMetric ?? true
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_UPDATE_ATTEMPTS
  }

  async updateDevice(device: NodeBleDevice, _displayName?: string): Promise<AirthingsDevice> {
    // use the ble advertisement/gatt name for model rejection — not a user label
    const name = await device.getName().catch(() => "") || ""
    if (name.includes("Renew") || name.includes("View")) {
      throw new UnsupportedDeviceError(`Model ${name} is not supported`)
    }

    let lastError: unknown
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const generation = ++this.updateGeneration
      try {
        return await this.updateOnceWithTimeout(device, generation)
      } catch (err) {
        lastError = err
        this.charCache.delete(device)
        this.logger.debug(`Update attempt ${attempt + 1} failed: ${String(err)}`)
        await disconnectDevice(device)
        await sleep(300)
        if (attempt < this.maxAttempts - 1) {
          await sleep(200)
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async updateOnceWithTimeout(
    device: NodeBleDevice,
    generation: number,
  ): Promise<AirthingsDevice> {
    let timer: NodeJS.Timeout | undefined
    let timedOut = false

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error(`device update timed out after ${UPDATE_TIMEOUT_MS}ms`))
      }, UPDATE_TIMEOUT_MS)
    })

    const work = this.updateOnce(device, generation)

    try {
      return await Promise.race([work, timeoutPromise])
    } catch (err) {
      if (timedOut) {
        if (this.updateGeneration === generation) {
          this.updateGeneration++
        }
        await disconnectDevice(device)
        await Promise.race([
          work.then(
            () => undefined,
            () => undefined,
          ),
          sleep(POST_TIMEOUT_WORK_WAIT_MS),
        ])
        await sleep(200)
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async updateOnce(
    device: NodeBleDevice,
    generation: number,
  ): Promise<AirthingsDevice> {
    this.assertGeneration(generation)
    await connectDevice(device)
    this.assertGeneration(generation)
    try {
      const byUuid = await this.characteristicsFor(device)
      this.assertGeneration(generation)

      const address = await device.getAddress().catch(() => "")
      const airthings = emptyDevice({ address })

      await this.readDeviceInfo(byUuid, airthings, generation)
      this.assertGeneration(generation)

      if (isAtomDevice(airthings.model)) {
        this.warnIfFirmwareOutdated(airthings)
        await this.readAtomSensors(byUuid, airthings, generation)
      } else {
        await this.readWaveSensors(byUuid, airthings, generation)
      }

      this.assertGeneration(generation)
      if (!hasPrimarySensors(airthings.sensors)) {
        throw new Error("No primary sensor values read from device")
      }
      airthings.lastUpdateAt = Date.now()
      if (!airthings.name) {
        airthings.name = `Airthings ${productName(airthings.model)}`
      }
      return airthings
    } finally {
      if (this.updateGeneration === generation) {
        await disconnectDevice(device)
      }
    }
  }

  private async characteristicsFor(
    device: NodeBleDevice,
  ): Promise<Map<string, { uuid: string, char: NodeBleGattCharacteristic }>> {
    const cached = this.charCache.get(device)
    if (cached && cached.size > 0) {
      return cached
    }
    const byUuid = await mapAllCharacteristics(device)
    this.charCache.set(device, byUuid)
    return byUuid
  }

  private assertGeneration(generation: number): void {
    if (this.updateGeneration !== generation) {
      throw new Error("stale device update attempt")
    }
  }

  private warnIfFirmwareOutdated(device: AirthingsDevice): void {
    const required = requiredFirmwareForModel(device.model)
    if (!required) {
      return
    }
    if (needsFirmwareUpgrade(device.swVersion, required)) {
      const current = parseFirmwareVersion(device.swVersion)
      this.logger.warn(
        `Firmware for ${device.address} is not up to date`
        + ` (current ${current ? formatVersion(current) : device.swVersion || "unknown"},`
        + ` need ${required} or newer). Update via the Airthings app.`,
      )
    }
  }

  private async readString(
    byUuid: Map<string, { uuid: string, char: NodeBleGattCharacteristic }>,
    uuid: string,
    generation: number,
  ): Promise<string | null> {
    this.assertGeneration(generation)
    const entry = byUuid.get(uuidKey(uuid))
    if (!entry) {
      return null
    }
    try {
      const data = await entry.char.readValue()
      this.assertGeneration(generation)
      return data.toString("utf-8").replace(/\0/g, "").trim()
    } catch (err) {
      this.assertGeneration(generation)
      this.logger.debug(`Failed reading ${uuid}: ${String(err)}`)
      return null
    }
  }

  private async readDeviceInfo(
    byUuid: Map<string, { uuid: string, char: NodeBleGattCharacteristic }>,
    device: AirthingsDevice,
    generation: number,
  ): Promise<void> {
    const modelRaw = await this.readString(byUuid, CHAR_UUID_MODEL_NUMBER_STRING, generation)
    // a missing read is a transport failure and must be retried. only a
    // present, unrecognized model string is an unsupported device — that
    // path removes the accessory from the poll set.
    if (!modelRaw) {
      throw new Error("Model number was not read")
    }
    device.model = deviceTypeFromRaw(modelRaw)
    if (device.model === AirthingsDeviceType.UNKNOWN) {
      throw new UnsupportedDeviceError(`Model ${modelRaw} is not supported`)
    }

    const manufacturer = await this.readString(byUuid, CHAR_UUID_MANUFACTURER_NAME, generation)
    if (manufacturer) device.manufacturer = manufacturer

    const serial = await this.readString(byUuid, CHAR_UUID_SERIAL_NUMBER_STRING, generation)
    if (serial && serial !== "Serial Number") {
      device.identifier = serial
    }

    const fw = await this.readString(byUuid, CHAR_UUID_FIRMWARE_REV, generation)
    if (fw) device.swVersion = fw

    const hw = await this.readString(byUuid, CHAR_UUID_HARDWARE_REV, generation)
    if (hw) device.hwVersion = hw

    const name = await this.readString(byUuid, CHAR_UUID_DEVICE_NAME, generation)
    if (name) device.name = name

    if (
      device.model === AirthingsDeviceType.WAVE_GEN_1
      && device.name
      && !device.identifier
    ) {
      const match = /#([0-9]{6})/.exec(device.name)
      if (match) {
        device.identifier = match[1]
      }
    }
  }

  private async readWaveSensors(
    byUuid: Map<string, { uuid: string, char: NodeBleGattCharacteristic }>,
    device: AirthingsDevice,
    generation: number,
  ): Promise<void> {
    const sensors: SensorMap = { ...device.sensors }

    for (const [key, entry] of byUuid) {
      this.assertGeneration(generation)
      if (!SENSOR_CHAR_UUIDS.has(key)) {
        continue
      }

      const decoder = getSensorDecoder(entry.uuid)
      if (decoder) {
        try {
          const data = await entry.char.readValue()
          this.assertGeneration(generation)
          const sensorData = decoder(data)
          delete sensorData[DATE_TIME]
          Object.assign(sensors, sensorData)
          this.applyRadonUnits(sensors, sensorData)
        } catch (err) {
          this.assertGeneration(generation)
          this.logger.debug(`Failed reading sensor ${entry.uuid}: ${String(err)}`)
        }
      }

      const commandDecoder = getCommandDecoder(entry.uuid)
      if (commandDecoder) {
        try {
          const batteryData = await this.runCommand(entry.char, commandDecoder, generation)
          if (batteryData?.[BATTERY] !== undefined && batteryData[BATTERY] !== null) {
            sensors[BATTERY] = batteryPercentage(device.model, Number(batteryData[BATTERY]))
          }
          if (batteryData?.[ILLUMINANCE] !== undefined) {
            sensors[ILLUMINANCE] = batteryData[ILLUMINANCE]
          }
        } catch (err) {
          this.assertGeneration(generation)
          this.logger.debug(`Failed command ${entry.uuid}: ${String(err)}`)
        }
      }
    }

    device.sensors = sensors
  }

  private async runCommand(
    char: NodeBleGattCharacteristic,
    decoder: NonNullable<ReturnType<typeof getCommandDecoder>>,
    generation: number,
  ): Promise<SensorMap | null> {
    this.assertGeneration(generation)
    const receiver = decoder.makeDataReceiver()
    const onData = (data: Buffer) => receiver.asCallback(data)

    char.on("valuechanged", onData)
    try {
      await char.startNotifications()
      this.assertGeneration(generation)
      await char.writeValue(decoder.cmd, { type: "request" })
      this.assertGeneration(generation)
      try {
        await receiver.waitForMessage(COMMAND_TIMEOUT_MS / 1000)
      } catch {
        this.logger.warn("Timeout getting command data.")
      }
      this.assertGeneration(generation)
      return decoder.decodeData(this.logger, receiver.message)
    } finally {
      char.removeListener("valuechanged", onData)
      await stopNotifications(char)
    }
  }

  private async readAtomSensors(
    byUuid: Map<string, { uuid: string, char: NodeBleGattCharacteristic }>,
    device: AirthingsDevice,
    generation: number,
  ): Promise<void> {
    const writeCharRef = byUuid.get(uuidKey(COMMAND_UUID_ATOM))
    const notifyCharRef = byUuid.get(uuidKey(COMMAND_UUID_ATOM_NOTIFY))
    if (!writeCharRef || !notifyCharRef) {
      throw new Error("Missing atom characteristics for device")
    }

    const sensors: SensorMap = { ...device.sensors }

    this.assertGeneration(generation)
    const connectivity = await this.fetchAtom(
      writeCharRef.char,
      notifyCharRef.char,
      AtomRequestPath.CONNECTIVITY_MODE,
      generation,
    )
    if (connectivity) {
      Object.assign(sensors, connectivity)
    }

    this.assertGeneration(generation)
    const latest = await this.fetchAtom(
      writeCharRef.char,
      notifyCharRef.char,
      AtomRequestPath.LATEST_VALUES,
      generation,
    )
    if (latest) {
      this.parseAtomSensorData(device.model, sensors, latest)
    }

    device.sensors = sensors
  }

  private async fetchAtom(
    writeCharRef: NodeBleGattCharacteristic,
    notifyCharRef: NodeBleGattCharacteristic,
    path: AtomRequestPath,
    generation: number,
  ): Promise<SensorMap | null> {
    this.assertGeneration(generation)
    const decoder = new AtomCommandDecode(path)
    const receiver = new AtomNotificationReceiver()
    const onData = (data: Buffer) => {
      receiver.push(data)
    }

    notifyCharRef.on("valuechanged", onData)
    try {
      await notifyCharRef.startNotifications()
      this.assertGeneration(generation)
      await writeCharRef.writeValue(decoder.cmd, { type: "request" })
      this.assertGeneration(generation)

      const deadline = Date.now() + COMMAND_TIMEOUT_MS
      while (Date.now() < deadline) {
        this.assertGeneration(generation)
        if (receiver.complete) {
          break
        }
        await sleep(40)
      }

      this.assertGeneration(generation)
      if (!receiver.message) {
        this.logger.warn("Timeout getting atom command data.")
        return null
      }
      return decoder.decodeData(this.logger, receiver.message)
    } finally {
      notifyCharRef.removeListener("valuechanged", onData)
      await stopNotifications(notifyCharRef)
    }
  }

  private parseAtomSensorData(
    model: AirthingsDeviceType,
    sensors: SensorMap,
    sensorData: SensorMap,
  ): void {
    const next: SensorMap = {}

    if (sensorData[ATOM_BAT] !== undefined && sensorData[ATOM_BAT] !== null) {
      next[BATTERY] = batteryPercentage(model, Number(sensorData[ATOM_BAT]) / 1000.0)
    }
    if (sensorData[ATOM_LUX] !== undefined) next[LUX] = sensorData[ATOM_LUX]
    if (sensorData[ATOM_CO2] !== undefined) next[CO2] = sensorData[ATOM_CO2]
    if (sensorData[ATOM_VOC] !== undefined) next[VOC] = sensorData[ATOM_VOC]
    if (sensorData[ATOM_HUMIDITY] !== undefined) {
      next[HUMIDITY] = Number(sensorData[ATOM_HUMIDITY]) / 100.0
    }
    if (sensorData[ATOM_TEMPERATURE] !== undefined) {
      next[TEMPERATURE] = Math.round((Number(sensorData[ATOM_TEMPERATURE]) / 100.0 - 273.15) * 100) / 100
    }
    if (sensorData[ATOM_NOISE] !== undefined) next[NOISE] = sensorData[ATOM_NOISE]
    if (sensorData[ATOM_PRESSURE] !== undefined) {
      next[PRESSURE] = Number(sensorData[ATOM_PRESSURE]) / (64 * 100)
    }

    this.mapAtomRadon(next, sensorData[ATOM_RADON_1DAY_AVG], RADON_1DAY_AVG, RADON_1DAY_LEVEL)
    this.mapAtomRadon(next, sensorData[ATOM_RADON_WEEK_AVG], RADON_WEEK_AVG, RADON_WEEK_LEVEL)
    const month = sensorData[ATOM_RADON_MONTH_AVG] ?? sensorData[ATOM_RADON_MONTH_AVG_ALT]
    this.mapAtomRadon(next, month, RADON_MONTH_AVG, RADON_MONTH_LEVEL)
    this.mapAtomRadon(next, sensorData[ATOM_RADON_YEAR_AVG], RADON_YEAR_AVG, RADON_YEAR_LEVEL)

    const longTermRaw =
      sensorData[ATOM_RADON_YEAR_AVG]
      ?? month
      ?? sensorData[ATOM_RADON_WEEK_AVG]
    this.mapAtomRadon(next, longTermRaw, RADON_LONGTERM_AVG, RADON_LONGTERM_LEVEL)

    this.logger.debug(`Atom sensor values: ${JSON.stringify(next)}`)
    Object.assign(sensors, next)
  }

  private mapAtomRadon(
    target: SensorMap,
    raw: unknown,
    avgKey: string,
    levelKey: string,
  ): void {
    if (raw === undefined || raw === null) {
      return
    }
    const bq = Number(raw)
    if (avgKey === RADON_1DAY_AVG) target[RADON_1DAY_BQ] = bq
    target[avgKey] = this.isMetric ? bq : bq * BQ_TO_PCI_MULTIPLIER
    target[levelKey] = getRadonLevel(bq)
  }

  private applyRadonUnits(sensors: SensorMap, sensorData: SensorMap): void {
    if (sensorData[RADON_1DAY_AVG] !== undefined && sensorData[RADON_1DAY_AVG] !== null) {
      const bq = Number(sensorData[RADON_1DAY_AVG])
      sensors[RADON_1DAY_BQ] = bq
      sensors[RADON_1DAY_LEVEL] = getRadonLevel(bq)
      if (!this.isMetric) {
        sensors[RADON_1DAY_AVG] = bq * BQ_TO_PCI_MULTIPLIER
      }
    }
    if (sensorData[RADON_LONGTERM_AVG] !== undefined && sensorData[RADON_LONGTERM_AVG] !== null) {
      const bq = Number(sensorData[RADON_LONGTERM_AVG])
      sensors[RADON_LONGTERM_LEVEL] = getRadonLevel(bq)
      if (!this.isMetric) {
        sensors[RADON_LONGTERM_AVG] = bq * BQ_TO_PCI_MULTIPLIER
      }
    }
  }
}
