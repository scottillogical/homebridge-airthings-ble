/** airthings company id (0x0334) in BLE manufacturer data */
export const MFCT_ID = 820

export const UPDATE_TIMEOUT_MS = 15_000
export const COMMAND_TIMEOUT_MS = 5_000
export const DEFAULT_MAX_UPDATE_ATTEMPTS = 2

// standard GATT
export const CHAR_UUID_MANUFACTURER_NAME = "00002a29-0000-1000-8000-00805f9b34fb"
export const CHAR_UUID_SERIAL_NUMBER_STRING = "00002a25-0000-1000-8000-00805f9b34fb"
export const CHAR_UUID_MODEL_NUMBER_STRING = "00002a24-0000-1000-8000-00805f9b34fb"
export const CHAR_UUID_DEVICE_NAME = "00002a00-0000-1000-8000-00805f9b34fb"
export const CHAR_UUID_FIRMWARE_REV = "00002a26-0000-1000-8000-00805f9b34fb"
export const CHAR_UUID_HARDWARE_REV = "00002a27-0000-1000-8000-00805f9b34fb"

// wave sensors
export const CHAR_UUID_DATETIME = "00002a08-0000-1000-8000-00805f9b34fb"
export const CHAR_UUID_TEMPERATURE = "00002a6e-0000-1000-8000-00805f9b34fb"
export const CHAR_UUID_HUMIDITY = "00002a6f-0000-1000-8000-00805f9b34fb"
export const CHAR_UUID_RADON_1DAYAVG = "b42e01aa-ade7-11e4-89d3-123b93f75cba"
export const CHAR_UUID_RADON_LONG_TERM_AVG = "b42e0a4c-ade7-11e4-89d3-123b93f75cba"
export const CHAR_UUID_ILLUMINANCE_ACCELEROMETER = "b42e1348-ade7-11e4-89d3-123b93f75cba"
export const CHAR_UUID_WAVE_PLUS_DATA = "b42e2a68-ade7-11e4-89d3-123b93f75cba"
export const CHAR_UUID_WAVE_2_DATA = "b42e4dcc-ade7-11e4-89d3-123b93f75cba"
export const CHAR_UUID_WAVEMINI_DATA = "b42e3b98-ade7-11e4-89d3-123b93f75cba"

export const COMMAND_UUID_WAVE_2 = "b42e50d8-ade7-11e4-89d3-123b93f75cba"
export const COMMAND_UUID_WAVE_PLUS = "b42e2d06-ade7-11e4-89d3-123b93f75cba"
export const COMMAND_UUID_WAVE_MINI = "b42e3ef4-ade7-11e4-89d3-123b93f75cba"

// atom (wave enhance / corentium home 2)
export const COMMAND_UUID_ATOM_NOTIFY = "b42ebc9e-ade7-11e4-89d3-123b93f75cba"
export const COMMAND_UUID_ATOM = "b42eb73a-ade7-11e4-89d3-123b93f75cba"

// discovery service uuids used by home assistant airthings_ble
export const SERVICE_UUIDS = [
  "b42e1f6e-ade7-11e4-89d3-123b93f75cba",
  "b42e4a8e-ade7-11e4-89d3-123b93f75cba",
  "b42e1c08-ade7-11e4-89d3-123b93f75cba",
  "b42e3882-ade7-11e4-89d3-123b93f75cba",
  "b42e90a2-ade7-11e4-89d3-123b93f75cba",
]

export const BQ_TO_PCI_MULTIPLIER = 0.027

export const CO2_MAX = 65534
export const VOC_MAX = 65534
export const PERCENTAGE_MAX = 100
export const PRESSURE_MAX = 1310
export const RADON_MAX = 16383
export const TEMPERATURE_MAX = 100

// atom sensor keys
export const ATOM_BAT = "BAT"
export const ATOM_LUX = "LUX"
export const ATOM_TEMPERATURE = "TMP"
export const ATOM_HUMIDITY = "HUM"
export const ATOM_VOC = "VOC"
export const ATOM_CO2 = "CO2"
export const ATOM_NOISE = "NOI"
export const ATOM_PRESSURE = "PRS"
export const ATOM_RADON_1DAY_AVG = "R24"
export const ATOM_RADON_WEEK_AVG = "R7D"
export const ATOM_RADON_MONTH_AVG = "R30D"
export const ATOM_RADON_MONTH_AVG_ALT = "R30"
export const ATOM_RADON_YEAR_AVG = "R1Y"

// normalized sensor keys
export const ACCELEROMETER = "accelerometer"
export const BATTERY = "battery"
export const CO2 = "co2"
export const CONNECTIVITY_MODE = "connectivity_mode"
export const DATE_TIME = "date_time"
export const NOISE = "noise"
export const HUMIDITY = "humidity"
export const ILLUMINANCE = "illuminance"
export const LUX = "lux"
export const PRESSURE = "pressure"
export const TEMPERATURE = "temperature"
export const RADON_LONGTERM_AVG = "radon_longterm_avg"
export const RADON_LONGTERM_LEVEL = "radon_longterm_level"
export const RADON_1DAY_AVG = "radon_1day_avg"
export const RADON_1DAY_LEVEL = "radon_1day_level"
export const RADON_WEEK_AVG = "radon_week_avg"
export const RADON_WEEK_LEVEL = "radon_week_level"
export const RADON_MONTH_AVG = "radon_month_avg"
export const RADON_MONTH_LEVEL = "radon_month_level"
export const RADON_YEAR_AVG = "radon_year_avg"
export const RADON_YEAR_LEVEL = "radon_year_level"
export const VOC = "voc"

export type SensorValue = string | number | null | undefined
export type SensorMap = Record<string, SensorValue>

/** Internal unconverted reading, present only when this poll read radon. */
export const RADON_1DAY_BQ = "radon_1day_bq"
