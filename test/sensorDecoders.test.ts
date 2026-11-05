import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  decodeWaveMini,
  decodeWavePlus,
  decodeWaveRadon,
} from "../src/airthings/sensorDecoders.js"
import {
  CO2,
  HUMIDITY,
  ILLUMINANCE,
  PRESSURE,
  RADON_1DAY_AVG,
  RADON_LONGTERM_AVG,
  TEMPERATURE,
  VOC,
} from "../src/airthings/const.js"
import {
  WaveMiniCommandDecode,
  WaveRadonAndPlusCommandDecode,
} from "../src/airthings/commandDecode.js"
import { BATTERY } from "../src/airthings/const.js"
import { AtomRequest } from "../src/airthings/atom/request.js"
import { AtomRequestPath, pathAsBytes } from "../src/airthings/atom/requestPath.js"
import { AtomResponse } from "../src/airthings/atom/response.js"
import { getRadonLevel } from "../src/airthings/radonLevel.js"
import { batteryPercentage, AirthingsDeviceType } from "../src/airthings/deviceType.js"

const silentLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

describe("wave plus sensor decode", () => {
  it("matches official airthings-ble test vector", () => {
    const raw = Buffer.from("01380d800b002200bd094cc31d036c0000007d05", "hex")
    const data = decodeWavePlus(raw)
    assert.equal(data[HUMIDITY], 28.0)
    assert.equal(data[RADON_1DAY_AVG], 11)
    assert.equal(data[RADON_LONGTERM_AVG], 34)
    assert.equal(data[TEMPERATURE], 24.93)
    assert.equal(data[VOC], 108)
    assert.equal(data[CO2], 797)
    assert.equal(data[PRESSURE], 999.92)
  })
})

describe("wave radon sensor decode", () => {
  it("matches official airthings-ble test vector", () => {
    const raw = Buffer.from("013860f009001100a709ffffffffffff0000ffff", "hex")
    const data = decodeWaveRadon(raw)
    assert.equal(data[HUMIDITY], 28.0)
    assert.equal(data[RADON_1DAY_AVG], 9)
    assert.equal(data[RADON_LONGTERM_AVG], 17)
    assert.equal(data[TEMPERATURE], 24.71)
  })
})

describe("wave mini sensor decode", () => {
  it("matches official airthings-ble test vector", () => {
    const raw = Buffer.from("1800327431c168102e000000ff940700ffffffff", "hex")
    const data = decodeWaveMini(raw)
    assert.equal(data[ILLUMINANCE], 9)
    assert.equal(data[TEMPERATURE], 24.31)
    assert.equal(data[PRESSURE], 989.14)
    assert.equal(data[HUMIDITY], 42.0)
    assert.equal(data[VOC], 46.0)
  })
})

describe("command decode battery", () => {
  it("decodes wave plus battery voltage", () => {
    const decode = new WaveRadonAndPlusCommandDecode()
    const result = decode.decodeData(
      silentLogger,
      Buffer.from("6d00600c04000100008211ff00000000c04c20001f3560007006B80B0900", "hex"),
    )
    assert.deepEqual(result, { [BATTERY]: 3.0 })
  })

  it("decodes wave mini battery voltage", () => {
    const decode = new WaveMiniCommandDecode()
    const result = decode.decodeData(
      silentLogger,
      Buffer.from("6d0064000000c800000001020304f4015802bc02000020038403b80b4c04b0040000", "hex"),
    )
    assert.deepEqual(result, { [BATTERY]: 3.0 })
  })
})

describe("atom request/response", () => {
  it("builds latest values request", () => {
    const random = Buffer.from("A1B2", "hex")
    const request = new AtomRequest(AtomRequestPath.LATEST_VALUES, random)
    const bytes = request.asBytes()
    assert.deepEqual(bytes.subarray(0, 2), Buffer.from("0301", "hex"))
    assert.deepEqual(bytes.subarray(2, 4), random)
    assert.deepEqual(bytes.subarray(4, 7), Buffer.from("81A100", "hex"))
    assert.deepEqual(bytes.subarray(8), pathAsBytes(AtomRequestPath.LATEST_VALUES))
  })

  it("parses wave enhance latest values", () => {
    const random = Buffer.from("A1B2", "hex")
    const response = new AtomResponse(
      silentLogger,
      Buffer.from(
        "0345a1b281a2006d32393939392f302f333130313202583ea9634e4f49"
        + "182763544d501972f06348554d190d2f63434f321902dc63564f43190115634c5"
        + "55801635052531a005f364663424154190b346354494d1876",
        "hex",
      ),
      random,
      AtomRequestPath.LATEST_VALUES,
    )
    const sensorData = response.parse()
    assert.ok(sensorData)
    assert.equal(sensorData!.TMP, 29424)
    assert.equal(sensorData!.HUM, 3375)
    assert.equal(sensorData!.CO2, 732)
    assert.equal(sensorData!.VOC, 277)
    assert.equal(sensorData!.LUX, 1)
    assert.equal(sensorData!.PRS, 6239814)
    assert.equal(sensorData!.BAT, 2868)
    assert.equal(sensorData!.NOI, 39)
  })

  it("parses corentium home 2 latest values", () => {
    const random = Buffer.from("CCA4", "hex")
    const response = new AtomResponse(
      silentLogger,
      Buffer.from(
        "0345CCA481A2006D32393939392F302F3331303132025831A863523234"
        + "0363523744076352333007635231591263544D501973D76348554D190D8C63424"
        + "154190B816354494D19061D",
        "hex",
      ),
      random,
      AtomRequestPath.LATEST_VALUES,
    )
    const sensorData = response.parse()
    assert.ok(sensorData)
    assert.equal(sensorData!.TMP, 29655)
    assert.equal(sensorData!.HUM, 3468)
    assert.equal(sensorData!.BAT, 2945)
    assert.equal(sensorData!.R24, 3)
    assert.equal(sensorData!.R7D, 7)
    assert.equal(sensorData!.R30, 7)
    assert.equal(sensorData!.R1Y, 18)
  })

  it("parses connectivity mode", () => {
    const random = Buffer.from("5F93", "hex")
    const response = new AtomResponse(
      silentLogger,
      Buffer.from("03455F9381A2006A31372F302F33313130300204", "hex"),
      random,
      AtomRequestPath.CONNECTIVITY_MODE,
    )
    const data = response.parse()
    assert.deepEqual(data, { connectivity_mode: "Bluetooth" })
  })
})

describe("radon level and battery", () => {
  it("classifies radon levels", () => {
    assert.equal(getRadonLevel(50), "good")
    assert.equal(getRadonLevel(120), "fair")
    assert.equal(getRadonLevel(200), "poor")
  })

  it("maps battery voltage for two-cell devices", () => {
    assert.equal(batteryPercentage(AirthingsDeviceType.WAVE_PLUS, 3.0), 100)
    assert.equal(batteryPercentage(AirthingsDeviceType.WAVE_PLUS, 2.0), 0)
  })
})

describe("firmware version", () => {
  it("detects outdated atom firmware", async () => {
    const { needsFirmwareUpgrade, parseFirmwareVersion } = await import(
      "../src/airthings/firmware.js"
    )
    assert.deepEqual(parseFirmwareVersion("T-SUB-2.5.0-master+0"), [2, 5, 0])
    assert.equal(
      needsFirmwareUpgrade("T-SUB-2.5.0-master+0", "T-SUB-2.6.1-master+0"),
      true,
    )
    assert.equal(
      needsFirmwareUpgrade("T-SUB-2.6.1-master+0", "T-SUB-2.6.1-master+0"),
      false,
    )
  })
})
