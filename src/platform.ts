import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge"
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js"
import { resolveHciDeviceId } from "./ble/adapterLock.js"
import { normalizeBleAddress } from "./ble/nodeBle.js"
import {
  BleScanner,
  normalizeSerial,
  preferSerial,
  serialsReferToSameDevice,
  type DeviceFilter,
  type DiscoveredDevice,
  type ScannerConfig,
} from "./ble/scanner.js"
import { AirthingsPlatformAccessory } from "./platformAccessory.js"
import { createCustomCharacteristics, type CustomCharacteristics } from "./customCharacteristics.js"
import type { AirthingsDevice } from "./airthings/types.js"

interface AccessoryDeviceContext {
  serialNumber?: string
  address?: string
  displayName?: string
}

export interface AirthingsPlatformConfig extends PlatformConfig {
  name?: string
  refreshInterval?: number
  scanDuration?: number
  isMetric?: boolean
  /** ppm; CarbonDioxideDetected is abnormal at or above this (default 1000) */
  co2AlertThreshold?: number
  /** Optional alert thresholds, always Bq/m³; both are required. */
  radonAlertThreshold?: number
  radonAlertResetThreshold?: number
  /** noble hci adapter index (default 0); lock is shared per adapter with peer ble plugins */
  hciDeviceId?: number
  debug?: boolean
  devices?: DeviceFilter[]
}

export class AirthingsBlePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service
  public readonly Characteristic: typeof Characteristic
  public readonly custom: CustomCharacteristics

  public readonly accessories = new Map<string, PlatformAccessory>()
  private readonly handlers = new Map<string, AirthingsPlatformAccessory>()
  private readonly hciDeviceId: number
  private scanner?: BleScanner

  constructor(
    public readonly log: Logging,
    public readonly config: AirthingsPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic
    this.custom = createCustomCharacteristics(api, {
      isMetric: this.config.isMetric ?? true,
    })

    // explicit config wins; else NOBLE_HCI_DEVICE_ID env (legacy); else 0
    this.hciDeviceId = resolveHciDeviceId(this.config.hciDeviceId)

    this.log.debug("Finished initializing platform:", this.config.name ?? PLATFORM_NAME)

    this.api.on("didFinishLaunching", () => {
      void this.launch()
    })

    this.api.on("shutdown", () => {
      void this.scanner?.stop()
    })
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info("Loading accessory from cache:", accessory.displayName)
    this.accessories.set(accessory.UUID, accessory)
  }

  private async launch(): Promise<void> {
    const scannerConfig: ScannerConfig = {
      scanDurationSec: Math.max(5, this.config.scanDuration ?? 20),
      refreshIntervalSec: Math.max(300, this.config.refreshInterval ?? 300),
      isMetric: this.config.isMetric ?? true,
      debug: this.config.debug ?? false,
      devices: this.config.devices ?? [],
      hciDeviceId: this.hciDeviceId,
    }

    this.scanner = new BleScanner(this.log, scannerConfig)
    this.scanner.setUpdateHandler((id, device) => this.onDeviceUpdate(id, device))
    this.scanner.setDiscoveredHandler((device) => this.registerOrRestore(device))

    try {
      await this.scanner.init()
    } catch (err) {
      this.log.error(`Bluetooth init failed: ${String(err)}`)
      this.log.error(
        "Ensure BlueZ is running, the adapter is powered on, and D-Bus permissions allow the homebridge user to talk to org.bluez (node-ble).",
      )
      return
    }

    this.removeDuplicateAccessories()

    let discovered: DiscoveredDevice[] = []
    try {
      discovered = await this.scanner.discover()
    } catch (err) {
      this.log.error(`Device discovery failed: ${String(err)}`)
      this.log.warn("Continuing with cached accessories; will re-scan on the next poll cycle")
    }

    const seenUuids = new Set<string>()

    for (const device of discovered) {
      const uuid = this.registerOrRestore(device)
      seenUuids.add(uuid)
    }

    // never unregister accessories just because a scan missed them.
    // ble sensors are often offline or out of range at startup; removing them
    // would drop them from homekit without user action.
    // re-seed the scanner by address so poll can still connect without mfg ads.
    for (const [uuid, accessory] of this.accessories) {
      if (seenUuids.has(uuid)) {
        continue
      }

      const ctx = accessory.context.device as AccessoryDeviceContext
      const devicesConfigured = (this.config.devices ?? []).length > 0
      if (devicesConfigured && !this.isConfiguredDevice(ctx)) {
        this.log.warn(
          "Removing cached accessory that is not in the configured device list:",
          accessory.displayName,
          ctx.serialNumber ?? "?",
        )
        this.unregisterAccessory(accessory)
        continue
      }

      if (ctx.address && this.scanner) {
        const addr = normalizeBleAddress(ctx.address)
        const already = this.scanner.getDiscovered().some(
          (d) => normalizeBleAddress(d.address) === addr,
        )
        if (already) {
          this.log.warn(
            "Removing cached accessory with the same address as a discovered device:",
            accessory.displayName,
            ctx.serialNumber ?? "?",
          )
          this.unregisterAccessory(accessory)
          continue
        }
      }

      const configured = this.isConfiguredDevice(ctx)
      this.log.warn(
        configured
          ? "Configured device not seen during scan, keeping cached accessory:"
          : "Device not seen during scan, keeping cached accessory:",
        accessory.displayName,
      )

      if (ctx.serialNumber && ctx.address && this.scanner) {
        const seeded = this.scanner.seedKnownDevice({
          serialNumber: ctx.serialNumber,
          address: ctx.address,
          displayName: ctx.displayName ?? accessory.displayName,
        })
        this.log.info(
          `Seeded ${seeded.displayName} sn=${seeded.serialNumber} address=${seeded.address} for poll`,
        )
      }

      const key = this.accessoryHandlerKey(ctx)
      if (key && !this.handlers.has(key)) {
        this.handlers.set(key, new AirthingsPlatformAccessory(this, accessory))
      }
    }

    // skip first re-scan when we already have devices to poll (from ads or cache seed)
    const haveDevices = this.scanner.getDiscovered().length > 0
    this.scanner.startPolling({
      skipInitialRescan: haveDevices,
    })
  }

  /** register a newly discovered device or restore from homebridge cache */
  private registerOrRestore(device: DiscoveredDevice): string {
    const uuid = this.api.hap.uuid.generate(`airthings-ble:${device.serialNumber}`)
    const existing = this.accessories.get(uuid) ?? this.findAccessoryForDevice(device)

    if (existing) {
      if (!this.handlers.has(device.serialNumber)) {
        this.log.info("Restoring accessory:", existing.displayName)
        existing.context.device = {
          serialNumber: device.serialNumber,
          displayName: device.displayName,
          address: device.address,
        }
        this.api.updatePlatformAccessories([existing])
        this.handlers.set(device.serialNumber, new AirthingsPlatformAccessory(this, existing))
      } else {
        // refresh context address if peripheral moved
        existing.context.device = {
          ...existing.context.device,
          serialNumber: device.serialNumber,
          address: device.address,
          displayName: device.displayName,
        }
      }
      return existing.UUID
    }

    this.log.info("Adding accessory:", device.displayName)
    const accessory = new this.api.platformAccessory(device.displayName, uuid)
    accessory.context.device = {
      serialNumber: device.serialNumber,
      displayName: device.displayName,
      address: device.address,
    }
    this.handlers.set(device.serialNumber, new AirthingsPlatformAccessory(this, accessory))
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
    this.accessories.set(uuid, accessory)
    return uuid
  }

  /** drop extra accessories that share a ble address (short gatt serial vs mfg serial) */
  private removeDuplicateAccessories(): void {
    const groups = new Map<string, PlatformAccessory[]>()
    for (const accessory of this.accessories.values()) {
      const ctx = accessory.context.device as AccessoryDeviceContext | undefined
      if (!ctx?.address) {
        continue
      }
      const key = normalizeBleAddress(ctx.address)
      const list = groups.get(key) ?? []
      list.push(accessory)
      groups.set(key, list)
    }

    for (const [address, group] of groups) {
      if (group.length < 2) {
        continue
      }
      const keep = this.pickCanonicalAccessory(group)
      const keepCtx = keep.context.device as AccessoryDeviceContext
      for (const accessory of group) {
        if (accessory.UUID === keep.UUID) {
          continue
        }
        const ctx = accessory.context.device as AccessoryDeviceContext
        this.log.warn(
          `Removing duplicate accessory ${accessory.displayName}`
          + ` sn=${ctx.serialNumber ?? "?"} address=${address}`
          + ` (keeping sn=${keepCtx.serialNumber ?? "?"})`,
        )
        this.unregisterAccessory(accessory)
      }
    }
  }

  private pickCanonicalAccessory(group: PlatformAccessory[]): PlatformAccessory {
    const configuredSerials = new Set(
      (this.config.devices ?? [])
        .filter((d) => d.serialNumber !== undefined)
        .map((d) => normalizeSerial(d.serialNumber)),
    )
    return group.reduce((best, accessory) => {
      const bestSn = normalizeSerial(
        (best.context.device as AccessoryDeviceContext)?.serialNumber,
      )
      const accSn = normalizeSerial(
        (accessory.context.device as AccessoryDeviceContext)?.serialNumber,
      )
      if (configuredSerials.has(accSn) && !configuredSerials.has(bestSn)) {
        return accessory
      }
      if (configuredSerials.has(bestSn) && !configuredSerials.has(accSn)) {
        return best
      }
      return preferSerial(bestSn, accSn) === accSn ? accessory : best
    })
  }

  private findAccessoryForDevice(device: DiscoveredDevice): PlatformAccessory | undefined {
    const addr = normalizeBleAddress(device.address)
    for (const accessory of this.accessories.values()) {
      const ctx = accessory.context.device as AccessoryDeviceContext | undefined
      if (ctx?.address && normalizeBleAddress(ctx.address) === addr) {
        return accessory
      }
    }
    return undefined
  }

  private unregisterAccessory(accessory: PlatformAccessory): void {
    const ctx = accessory.context.device as AccessoryDeviceContext | undefined
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
    this.accessories.delete(accessory.UUID)
    const key = ctx ? this.accessoryHandlerKey(ctx) : undefined
    if (key) {
      this.handlers.delete(key)
    }
  }

  /** stable handler map key: serial when present, else normalized address */
  private accessoryHandlerKey(ctx: {
    serialNumber?: string
    address?: string
  }): string | undefined {
    if (ctx.serialNumber) {
      return ctx.serialNumber
    }
    if (ctx.address) {
      return ctx.address.toLowerCase().replace(/-/g, "").replace(/:/g, "")
    }
    return undefined
  }

  /**
   * true if accessory is one of the configured devices.
   * serialNumber is the identity when present; address is only a locator.
   */
  private isConfiguredDevice(ctx: {
    serialNumber?: string
    address?: string
  }): boolean {
    const devices = this.config.devices ?? []
    if (devices.length === 0) {
      return false
    }
    const serial = ctx.serialNumber ? normalizeSerial(ctx.serialNumber) : ""
    const address = ctx.address ? normalizeBleAddress(ctx.address) : ""
    return devices.some((d) => {
      if (d.serialNumber !== undefined) {
        return serial !== "" && normalizeSerial(d.serialNumber) === serial
      }
      if (d.address && address) {
        return normalizeBleAddress(d.address) === address
      }
      return false
    })
  }

  private onDeviceUpdate(id: string, device: AirthingsDevice): void {
    let handler = this.handlers.get(id)
    if (!handler && device.identifier) {
      handler = this.handlers.get(device.identifier)
    }
    if (!handler) {
      for (const [key, candidate] of this.handlers) {
        if (serialsReferToSameDevice(key, id)
          || (device.identifier && serialsReferToSameDevice(key, device.identifier))) {
          handler = candidate
          break
        }
      }
    }
    if (handler) {
      handler.update(device)
    }
  }
}
