# Breadboard Odyssey

Hackathon MVP: assemble a **555 timer** breadboard circuit from a SPICE-like netlist, then diagnose it with **live Arduino ADC** + **Gemini**.

Modes: **Build** the 555 (or divider), then **Debug** with an **A0 oscilloscope** and yellow probe points on the breadboard.

**Standout loop:** place circuit → Debug → LIVE Arduino scope sweep → **Analyze signal with Gemini**.

This project is **live-only**: there is no mock ADC, mock waveform, mock fault model, or mock coach diagnosis.

## Quick start

```bash
git checkout main && git pull
pip install -r requirements.txt   # pyserial for Arduino
# stop any old server first, then:
python3 python/server.py
# open http://127.0.0.1:8765  (hard-refresh if the UI looks stale: Ctrl+Shift+R / Cmd+Shift+R)
```

After a pull, always restart `python/server.py` from the repo root. The server sends `Cache-Control: no-store` for HTML/CSS/JS and cache-busts asset URLs.

### Plug in Gemini + Arduino (required for Debug / Analyze)

```bash
cp .env.example .env
# edit .env — set GEMINI_API_KEY and optionally ARDUINO_PORT (never commit .env)
pip install -r requirements.txt
python3 python/check_links.py   # verifies both links (prints no secrets)
python3 python/server.py
```

Or export in the shell:

```bash
export GEMINI_API_KEY=...          # Google AI Studio / Gemini API key
export ARDUINO_PORT=/dev/ttyACM0   # macOS: /dev/cu.usbmodem*; Windows: COM3
python3 python/server.py
```

Without Arduino, scope/measure return `source: "error"` (empty samples — no invented waveform). Without Gemini, analysis returns an error asking for `GEMINI_API_KEY`.

### Arduino hardware

1. Flash [`arduino/BreadboardProbe/BreadboardProbe.ino`](arduino/BreadboardProbe/BreadboardProbe.ino) (115200 baud).
2. Wire ADC sense lines (share GND; ≤5 V on ADC pins):

| Net | Default pin |
| --- | --- |
| VCC | A0 |
| GND / 0 | A1 |
| OUT | A2 |
| CTRL | A3 |
| TIMING | A4 |
| DISCHARGE | A5 |

The Coach panel shows live link status. Pick a serial port (or Auto-detect) → **Reconnect Arduino** → Run scope until readout says **LIVE**.

## Demo path (555 timer)

1. **Build** — Auto-set parts + jumpers → **Open Debug (A0 scope)**.
2. **Debug** — Reconnect Arduino → **Run scope** / **Expand scope**, then **Analyze signal with Gemini**.

`Analyze signal with Gemini` requires a LIVE Arduino capture and `GEMINI_API_KEY`.

## What is live

| Piece | Behavior |
| --- | --- |
| `TIMER_DEMO` / NE555 | Wiring/interface profile only — **no behavioral SPICE** |
| Voltages / scope | **Arduino only** — errors if not linked |
| Gemini | **Required** for signal/fault analysis |
| Auto-routing / camera / auth / DB | Out of scope |

## Layout

```
index.html
css/app.css
js/board.js diagnose.js app.js
python/server.py          HTTP + /api/measure /api/diagnose /api/status /api/scope
python/arduino_bridge.py  pyserial MEAS/SWEEP protocol
arduino/BreadboardProbe/  Uno / UNO Q firmware
requirements.txt
```

## API

- `GET /api/status` → Gemini + Arduino link state (`mockEnabled: false`)
- `POST /api/measure` `{ "net", "hole" }` → live `{ "voltage", "source": "arduino" }` or `{ "source": "error" }`
- `POST /api/scope` `{ "channel": "A0", "samples": 64 }` → live `{ "volts": [...], "source": "arduino" }` or error
- `POST /api/diagnose` context → `{ "message", "source": "gemini"|"local"|"error" }`
- `POST /api/arduino/reconnect` `{ "port?" }` → reopen serial port
- `POST /api/arduino/ports` → list serial devices

## License

MIT
