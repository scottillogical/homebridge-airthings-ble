import type { PlatformAccessory, Service } from "homebridge"
import type { AirthingsBlePlatform } from "./platform.js"
import { AirthingsDeviceType } from "./airthings/deviceType.js"

export const RADON_ALERT_SUBTYPE = "radon-alert"

/** Optional local binary alert. Never infer freshness from merged sensor values. */
export class RadonAlert {
  private service?: Service
  private state?: boolean
  private lastRead?: number
  private unavailable = true
  private timer?: ReturnType<typeof setTimeout>
  private readonly trigger?: number
  private readonly reset?: number
  readonly freshnessMs: number

  constructor(
    private readonly platform: AirthingsBlePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { radonAlertThreshold: trigger, radonAlertResetThreshold: reset } = platform.config
    this.freshnessMs = 2 * Math.max(300, platform.config.refreshInterval ?? 300) * 1000
    this.service = accessory.getServiceById(platform.Service.LeakSensor, RADON_ALERT_SUBTYPE)
    if (trigger !== undefined || reset !== undefined) {
      if (typeof trigger === "number" && Number.isFinite(trigger) && trigger > 0
        && typeof reset === "number" && Number.isFinite(reset) && reset > 0 && reset < trigger) {
        this.trigger = trigger
        this.reset = reset
      } else {
        platform.log.error(`${accessory.displayName}: invalid radonAlertThreshold/radonAlertResetThreshold; both must be finite positive Bq/m³ numbers, reset strictly below trigger. Radon alerts disabled.`)
      }
    }
    if (this.trigger === undefined) {
      if (this.service) {
        accessory.removeService(this.service)
        platform.api.updatePlatformAccessories([accessory])
      }
      this.service = undefined
      delete accessory.context.radonAlertState
      return
    }
    if (this.service) {
      const cached = accessory.context.radonAlertState
      const value = this.service.getCharacteristic(platform.Characteristic.LeakDetected).value
      this.state = typeof cached === "boolean" ? cached : value === 1 ? true : value === 0 ? false : undefined
      this.bind()
    }
    platform.api.on("shutdown", () => clearTimeout(this.timer))
  }

  update(raw: unknown, model: AirthingsDeviceType): void {
    if (this.trigger === undefined) return
    if (model === AirthingsDeviceType.WAVE_ENHANCE_EU || model === AirthingsDeviceType.WAVE_ENHANCE_US
      || model === AirthingsDeviceType.WAVE_MINI) {
      if (this.service) this.accessory.removeService(this.service)
      this.service = undefined
      clearTimeout(this.timer)
      delete this.accessory.context.radonAlertState
      return
    }
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      this.unavailable = true
      this.publishFault()
      return
    }
    if (!this.service) {
      this.service = this.accessory.addService(
        this.platform.Service.LeakSensor, `${this.accessory.displayName} High Radon`, RADON_ALERT_SUBTYPE,
      )
      this.bind()
    }
    const previous = this.state
    if (raw >= this.trigger) this.state = true
    else if (raw <= this.reset!) this.state = false
    // First-ever reading inside the band has no prior state: remain unknown.
    this.lastRead = Date.now()
    this.unavailable = false
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.publishFault(), this.freshnessMs)
    this.timer.unref()
    if (this.state !== undefined) {
      this.accessory.context.radonAlertState = this.state
      this.service.updateCharacteristic(this.platform.Characteristic.LeakDetected, this.state ? 1 : 0)
      this.platform.api.updatePlatformAccessories([this.accessory])
      if (previous !== this.state && (previous !== undefined || this.state)) {
        this.platform.log.info(`${this.accessory.displayName} High Radon: ${this.state ? "ALERT" : "recovered"} (${raw} Bq/m³ rolling average)`)
      }
    }
    this.publishFault()
  }

  private fault(): number {
    return this.unavailable || this.state === undefined || this.lastRead === undefined
      || Date.now() - this.lastRead >= this.freshnessMs ? 1 : 0
  }

  private publishFault(): void {
    this.service?.updateCharacteristic(this.platform.Characteristic.StatusFault, this.fault())
  }

  private bind(): void {
    const C = this.platform.Characteristic
    this.service!.getCharacteristic(C.LeakDetected).onGet(() => {
      if (this.state === undefined) {
        throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
      }
      return this.state ? 1 : 0
    })
    if (this.state === undefined) {
      this.service!.updateCharacteristic(C.LeakDetected,
        new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE))
    }
    this.service!.getCharacteristic(C.StatusFault).onGet(() => this.fault())
    this.publishFault()
  }
}
