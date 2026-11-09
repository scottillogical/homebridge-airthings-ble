import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequire } from "node:module"
import { RadonAlert, RADON_ALERT_SUBTYPE } from "../src/radonAlert.js"
import type { AirthingsBlePlatform } from "../src/platform.js"
import { AirthingsDeviceType as Model } from "../src/airthings/deviceType.js"
import { AirthingsClient } from "../src/airthings/client.js"
import { RADON_1DAY_AVG, RADON_1DAY_BQ } from "../src/airthings/const.js"

const require = createRequire(import.meta.url)
const hap = require("hap-nodejs")

function fixture(config: Record<string, unknown> = { radonAlertThreshold: 150, radonAlertResetThreshold: 100 }, cached?: any) {
  const accessory = cached ?? new hap.Accessory("Basement", hap.uuid.generate("radon-test"))
  accessory.context ??= {}
  const logs: string[] = []
  const errors: string[] = []
  const platform = {
    config, Service: hap.Service, Characteristic: hap.Characteristic,
    log: { info: (s: string) => logs.push(s), error: (s: string) => errors.push(s) },
    api: { hap, on() {}, updatePlatformAccessories() {} },
  } as unknown as AirthingsBlePlatform
  const alert = new RadonAlert(platform, accessory)
  const service = () => accessory.getServiceById(hap.Service.LeakSensor, RADON_ALERT_SUBTYPE)
  const value = () => service()?.getCharacteristic(hap.Characteristic.LeakDetected).value
  const fault = () => service()?.getCharacteristic(hap.Characteristic.StatusFault).value
  return { alert, accessory, service, value, fault, logs, errors }
}

describe("optional radon alert", () => {
  it("uses inclusive boundaries, retains hysteresis, and logs only transitions", () => {
    const f = fixture()
    for (const [raw, expected] of [[100, 0], [149, 0], [150, 1], [150, 1], [125, 1], [100, 0]]) {
      f.alert.update(raw, Model.WAVE_RADON)
      assert.equal(f.value(), expected)
      assert.equal(f.fault(), 0)
    }
    assert.equal(f.logs.length, 2)
    assert.equal(f.service().displayName, "Basement High Radon")
  })

  it("does not fabricate a verified safe value on first reading in the band", async () => {
    const f = fixture()
    f.alert.update(125, Model.WAVE_RADON)
    assert.equal(f.fault(), 1)
    await assert.rejects(f.service().getCharacteristic(hap.Characteristic.LeakDetected).handleGetRequest())
  })

  it("keeps active state on invalid/missing data and recovers on a real read", () => {
    const f = fixture()
    f.alert.update(160, Model.WAVE_RADON)
    for (const raw of [undefined, null, NaN, Infinity, -1, "0"]) {
      f.alert.update(raw, Model.WAVE_RADON)
      assert.equal(f.value(), 1)
      assert.equal(f.fault(), 1)
    }
    f.alert.update(120, Model.WAVE_RADON)
    assert.equal(f.value(), 1)
    assert.equal(f.fault(), 0)
    f.alert.update(0, Model.WAVE_RADON)
    assert.equal(f.value(), 0)
  })

  it("faults without successful radon reads even if no update arrives (failed polls)", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 })
    const f = fixture()
    f.alert.update(160, Model.WAVE_RADON)
    t.mock.timers.tick(f.alert.freshnessMs - 1)
    assert.equal(f.fault(), 0)
    t.mock.timers.tick(1)
    assert.equal(f.fault(), 1)
    assert.equal(f.value(), 1)
    f.alert.update(90, Model.WAVE_RADON)
    assert.equal(f.fault(), 0)
    assert.equal(f.value(), 0)
  })

  it("restores serialized cache state unverified, without duplicate services", () => {
    const f = fixture()
    f.alert.update(160, Model.WAVE_RADON)
    const cached = hap.Accessory.deserialize(hap.Accessory.serialize(f.accessory))
    const restored = fixture(undefined, cached)
    assert.equal(restored.value(), 1)
    assert.equal(restored.fault(), 1)
    restored.alert.update(125, Model.WAVE_RADON)
    restored.alert.update(155, Model.WAVE_RADON)
    assert.equal(restored.fault(), 0)
    assert.equal(cached.services.filter((s: any) => s.subtype === RADON_ALERT_SUBTYPE).length, 1)
    const other = cached.addService(hap.Service.LeakSensor, "Other", "other")
    fixture({}, cached)
    assert.equal(restored.service(), undefined)
    assert.ok(cached.services.includes(other))
  })

  it("rejects invalid configuration locally, with no optional service", () => {
    for (const [trigger, reset] of [[150, undefined], [undefined, 100], [NaN, 100], [Infinity, 100], [0, 1], [-1, 1], [150, 0], [150, -1], [150, NaN], [150, Infinity], [150, 150], [150, 151], ["150", 100]]) {
      const f = fixture({ radonAlertThreshold: trigger, radonAlertResetThreshold: reset })
      f.alert.update(200, Model.WAVE_RADON)
      assert.equal(f.errors.length, 1)
      assert.equal(f.service(), undefined)
    }
    const disabled = fixture({})
    disabled.alert.update(200, Model.WAVE_RADON)
    assert.equal(disabled.service(), undefined)
    assert.equal(disabled.errors.length, 0)
  })

  it("does not expose alerts on devices without radon", () => {
    for (const model of [Model.WAVE_ENHANCE_US, Model.WAVE_ENHANCE_EU, Model.WAVE_MINI]) {
      const f = fixture()
      f.alert.update(undefined, model)
      f.alert.update(200, model)
      assert.equal(f.service(), undefined)
    }
  })

  it("retains unconverted Bq/m³ for both Wave and Atom independently of display units", () => {
    for (const isMetric of [true, false]) {
      const client = new AirthingsClient({ isMetric }) as any
      const sensors: Record<string, unknown> = { [RADON_1DAY_AVG]: 150 }
      client.applyRadonUnits(sensors, { ...sensors })
      assert.equal(sensors[RADON_1DAY_BQ], 150)
      assert.equal(sensors[RADON_1DAY_AVG], isMetric ? 150 : 150 * 0.027)
      const atom: Record<string, unknown> = {}
      client.mapAtomRadon(atom, 150, RADON_1DAY_AVG, "level")
      assert.equal(atom[RADON_1DAY_BQ], 150)
      const f = fixture({ radonAlertThreshold: 150, radonAlertResetThreshold: 100, isMetric })
      f.alert.update(sensors[RADON_1DAY_BQ], Model.WAVE_RADON)
      assert.equal(f.value(), 1)
    }
  })
})
