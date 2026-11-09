# @ushuz/homebridge-airthings-ble

Homebridge plugin for [Airthings](https://www.airthings.com/) air quality monitors over **Bluetooth LE**.

Sensor protocol is ported from the official [Airthings BLE library](https://github.com/Airthings/airthings-ble) used by Home Assistant.

BLE stack: [`node-ble`](https://www.npmjs.com/package/node-ble) (BlueZ over D-Bus, pure JavaScript — no native HCI bindings). **Linux only** (Raspberry Pi / Homebridge OS).

## Supported devices

- Wave Gen 1
- Wave Mini
- Wave Plus
- Wave Radon (Wave 2)
- Wave Enhance
- Corentium Home 2

**Not supported** (BLE used only for onboarding): Hub, Renew, View series.

## Requirements

| Component | Version |
| --- | --- |
| Homebridge | 1.8.5+ (2.x also supported) |
| Node.js | 20.18.0+ (or 22.x) |
| OS | Linux with BlueZ (Raspberry Pi) |

### Raspberry Pi / Linux Bluetooth

```bash
sudo apt-get update
sudo apt-get install -y bluetooth bluez
sudo systemctl enable --now bluetooth
```

`node-ble` talks to BlueZ on the system D-Bus. Ensure the Homebridge user can use `org.bluez` (membership in the `bluetooth` group, or a D-Bus policy such as the one in the [node-ble README](https://github.com/chrvadala/node-ble#provide-permissions)).

No `setcap` / raw HCI capabilities are required (unlike noble).

## Install

```bash
hb-service add @ushuz/homebridge-airthings-ble
# or
npm install -g @ushuz/homebridge-airthings-ble
```

Restart Homebridge after install.

## Config

Example `config.json` platform block:

```json
{
  "platform": "AirthingsBLE",
  "name": "Airthings BLE",
  "refreshInterval": 300,
  "scanDuration": 20,
  "isMetric": true,
  "co2AlertThreshold": 1000,
  "hciDeviceId": 0,
  "debug": false,
  "devices": []
}
```

| Field | Default | Description |
| --- | --- | --- |
| `refreshInterval` | `300` | Seconds between BLE polls (min 300 = 5 minutes). |
| `scanDuration` | `20` | Seconds to scan at startup. |
| `isMetric` | `true` | Radon in Bq/m³ when true, pCi/L when false. |
| `co2AlertThreshold` | `1000` | ppm; HomeKit CO₂ Detected is abnormal at or above this. (Not provided over BLE by the device.) |
| `hciDeviceId` | `0` | BlueZ adapter index (`hci0`). Match other BLE plugins for shared locking. |
| `debug` | `false` | Verbose BLE logs. |
| `devices` | `[]` | Optional allow-list. `serialNumber` is the accessory identity; `address` is only used to find the radio. Empty = auto-discover nearby Airthings sensors. |

### Optional device filter

```json
"devices": [
  {
    "serialNumber": "2930123456",
    "name": "Basement Wave Plus"
  },
  {
    "address": "aa:bb:cc:dd:ee:ff",
    "name": "Bedroom Wave Mini"
  }
]
```

Serial numbers come from BLE manufacturer data (same as the Airthings app / packaging).

### Sharing the adapter with other BLE plugins

Both this plugin and `@ushuz/homebridge-govee-ble` use **node-ble** (BlueZ D-Bus), so they no longer fight over exclusive raw HCI sockets. They still take a short-lived directory lock (`$TMPDIR/homebridge-ble-hci{N}.lock/`) around scan/connect so only one plugin drives the radio at a time. Set the same `hciDeviceId` on both.

## HomeKit services

See the plugin UI / accessory characteristics for temperature, humidity, CO₂, VOC, pressure, radon, battery, and air quality mappings.

### Optional Apple Home radon alerts

Set **both** platform settings to enable alerts (omit both to keep them disabled):

```json
"radonAlertThreshold": 150,
"radonAlertResetThreshold": 100
```

These example values illustrate configuration, not a recommended exposure limit.
Both must be finite positive numbers in **Bq/m³**, with reset strictly below trigger,
regardless of `isMetric`. Invalid settings log an error and disable only the optional
alert feature; other sensor services and devices continue working.

On devices that actually supply radon, the plugin adds a standard HomeKit
**LeakSensor** named **[device name] High Radon**. Wave Enhance and Wave Mini do not
get this service. Existing accessory identities, custom numerical radon
characteristics and Air Quality behavior remain unchanged. Removing the settings
removes only this optional service.

The alert uses the device's `radon_1day_avg` **rolling radon average**, not an
instantaneous measurement. It triggers at or above the trigger threshold, clears
at or below reset, and keeps its previous state between them. Thresholds are
compared with the original Bq/m³ reading before display-unit conversion.

This is a **leak-sensor workaround**, not native numerical radon notification
support. Apple controls the icon and notification wording and may describe the
alert as a water leak. The plugin cannot change that wording to a radon warning.
In Apple Home, open the accessory (or its individual High Radon sensor under
Accessories), open Settings → Status and Notifications, and enable **Activity
Notifications**. Names and navigation may vary with iOS. Check any time/people
filters and allow Home notifications in iPhone Settings. A working Apple Home
setup, including the home hub and remote access required by Apple, is needed for
push delivery. Exposing a notification-capable sensor state does not guarantee
that Apple delivers a push notification.

Freshness is based only on successful, finite, nonnegative radon reads. Missing
or invalid radon in a successful partial poll immediately sets `StatusFault`.
If polls fail entirely or stop arriving, `StatusFault` is set after **two configured
refresh intervals** (with the existing 300-second minimum). Other sensor updates
do not extend this deadline. Faults retain the last binary state, including an
active alert; they never manufacture a safe reading. A fresh radon read clears
the fault and applies hysteresis. Home may display faults differently and need
not send a notification for loss of data. BLE polling, adapter contention, device
averaging and Apple delivery can all delay alerts.

The last known binary state is saved in Homebridge's accessory cache. On restart
it is restored with `StatusFault` set until a fresh radon read verifies it. A fresh
reading inside the hysteresis band preserves that restored state, even if thresholds
were changed. With no previous state, a first reading inside the band remains
unknown/faulted until a reading reaches either boundary; reads of LeakDetected
return a communication error meanwhile. Cache loss or disabling the feature
forgets its state. Alert and recovery transitions are logged once per change.
Everything runs locally over BLE; no additional service, credentials or
notification dependency is used.

The threshold/hysteresis pattern was checked against
[homebridge-awair2's implementation](https://github.com/DMBlakeley/homebridge-awair2/blob/master/src/index.ts):
its CO₂ service uses CarbonDioxideDetected, while TVOC/PM2.5 limits use
OccupancyDetected. Those binary sensor states must not be taken as evidence that
every sensor type supports Apple Home push notifications.

### Manual validation: Raspberry Pi, Homebridge 2, Wave Radon

Hardware and iPhone push delivery have **not** been tested for this change.

1. Back up your Homebridge configuration/cache. Install a locally built checkout
   of this branch on your test Pi using your normal plugin development workflow;
   confirm BlueZ access and the existing Wave Radon readings on Homebridge 2.
2. With thresholds omitted, verify the existing accessory, services, Air Quality
   and custom radon values, and absence of High Radon. Configure both thresholds
   and restart; verify one High Radon sensor after the first valid radon poll.
3. Using temporary positive test thresholds around the observed rolling average,
   exercise trigger, reset and hysteresis (do not create radon exposure). Verify
   state and one log per transition. Repeat with `isMetric: false`; decisions
   must still match the raw Bq/m³ value, not the displayed pCi/L value.
4. Enable Activity Notifications as above. Cause a new trigger transition; record
   actual iPhone delivery, wording, latency and home hub/iOS versions. Repeat
   remotely. Treat this separately from verifying HomeKit sensor state.
5. Restart while active and temporarily make the Wave unreachable. Check retained
   alert state and fault before the first read; reconnect with a reading inside
   the band, then below reset. Confirm no duplicate sensor after repeated restarts.
6. With an active alert, interrupt BLE polling for more than two refresh intervals.
   Verify fault without a safe transition, then restore Bluetooth and verify recovery.
   Observe Homebridge characteristic values if Home hides StatusFault.
7. Omit both settings and restart; verify only High Radon is removed. Try invalid
   thresholds and check the clear error while other sensors still work. If a Wave
   Enhance is present, confirm it never receives High Radon.
