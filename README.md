# Waterbird Bridge

VISCA-over-IP bridge for the **Waterbird MSXL** motorised camera slider.

A Sony VISCA controller connects to this bridge over UDP. The bridge translates pan/tilt drive commands into Panasonic PTZ HTTP commands and forwards them to the slider. A small web UI lets you configure the slider IP, adjust max speed, trigger homing, and watch the live position.

```
Sony VISCA controller  ──UDP 52381──►  waterbird-bridge  ──HTTP──►  Waterbird MSXL (192.168.1.20)
                                              │
                                        http://localhost:3000  (web config)
```

---

## Requirements

- Node.js 20 or later (for running from source)
- Waterbird MSXL slider on the same network
- Sony VISCA-over-IP controller (tested with 192.168.1.110)

---

## Running from source

```bash
npm install
npm run bridge
```

The bridge will:
1. Home the slider on startup (`#O1` — slider physically moves to find end stops, ~10 s)
2. Listen for VISCA commands on UDP port **52381**
3. Serve the web config UI at **http://localhost:3000**

### Other scripts

| Command | Description |
|---|---|
| `npm run tui` | Terminal UI for manual slider control |
| `npm run sniff` | Sniff discovery traffic on common PTZ ports |
| `npm run bridge` | VISCA bridge + web config |
| `npm run build` | Build standalone binary → `dist/waterbird-bridge` |

---

## Web config UI

Open **http://localhost:3000** in a browser.

| Setting | Description |
|---|---|
| Slider IP | IP address of the Waterbird MSXL (default `192.168.1.20`) |
| Max speed | Cap on PTS speed as % of full range. 50% = PTS offset ±24, 100% = full speed (±49). Start low. |
| Home now | Triggers `#O1` homing sequence — slider moves to both end stops |
| Position | Live position bar, updates every 400 ms |

Config is saved to `waterbird-config.json` in the working directory.

---

## Building a standalone binary

Produces a single self-contained executable (no Node.js install required on the target machine) using [Node.js Single Executable Applications](https://nodejs.org/api/single-executable-applications.html).

```bash
npm run build
# → dist/waterbird-bridge
```

Run it:
```bash
./dist/waterbird-bridge
```

Config is read from `waterbird-config.json` in the **current working directory**.

> **macOS note:** the build script removes and re-applies an ad-hoc code signature via `codesign`. You may need to allow the binary in System Preferences → Privacy & Security the first time you run it.

---

## Protocol notes

- **VISCA/IP** (UDP 52381): sequence-number reset handshake, inquiry replies (canned Sony camera defaults), pan/tilt drive commands forwarded to slider.
- **Panasonic PTZ HTTP** (`/cgi-bin/aw_ptz`): `#O1` power-on/homing, `#PTS` continuous speed, `#APC` absolute position.
- Tilt commands from the VISCA controller are ignored (slider is linear, one axis only).
- Pan speed mapping: `sliderSpeed = (viscaSpeed / 24) × (maxSpeed% / 100)`, where `viscaSpeed` is the VISCA 1–24 range.

---

## Panasonic PTZ command reference

| Command | Description |
|---|---|
| `#O1` | Power on + homing (MSXL_init — moves to end stops) |
| `#O0` | Standby |
| `#PTS<pp><tt>` | Continuous speed: `pp`/`tt` = 01–99, 50 = stop |
| `#APC<pppp><tttt>` | Absolute position (4-digit hex each axis) |
| `#APC` | Query current position |
