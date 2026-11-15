# Breadboard Odyssey

Hackathon MVP: assemble a **555 timer** breadboard circuit from a SPICE-like netlist, then diagnose it with a closed loop of **highlighted probe points → voltage readings → understandable next actions**.

Modes: **Build** the 555 (or divider), then **Debug** with an **A0 oscilloscope** and yellow probe points on the breadboard.

**Standout loop:** place circuit → Debug → highlight A0 probe holes → scope sweep (Arduino or mock waveform) → Gemini/local coach tip.

## Quick start

```bash
pip install -r requirements.txt   # pyserial for Arduino
python3 python/server.py
# open http://127.0.0.1:8765
```

### Plug in Gemini + Arduino (recommended)

```bash
cp .env.example .env
# edit .env — set GEMINI_API_KEY and ARDUINO_PORT (never commit .env)
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

Without a key/port, mock measure + local coach still work for UI demos.

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

The Coach panel shows live link status. **Capture reading** prefers Arduino; **Force mock** uses the fault model. Serial failures fall back to mock and surface the error.

## Demo path (555 timer)

1. **Build** — Auto-set parts + jumpers → **Open Debug (A0 scope)** (or **Ask Gemini: process fault** once wiring is complete).
2. **Debug** — Yellow holes mark A0 (VCC) probe points. **Run scope** / **Expand scope** for a larger view. When all wires are set, **Ask Gemini: process fault** captures the waveform and returns a diagnosis + repair steps.

## What is mocked vs live

| Piece | Behavior |
| --- | --- |
| `TIMER_DEMO` / NE555 | Wiring/interface profile only — **no behavioral SPICE** |
| Voltages | Live via `ARDUINO_PORT` + firmware; else mock fault model |
| Gemini | Live when `GEMINI_API_KEY` is set; else mock/local coach |
| Auto-routing / camera / auth / DB | Out of scope |

## Layout

```
index.html
css/app.css
js/board.js diagnose.js app.js
python/server.py          HTTP + /api/measure /api/diagnose /api/status
python/arduino_bridge.py  pyserial MEAS/VOLTS protocol
arduino/BreadboardProbe/  Uno / UNO Q firmware
requirements.txt
```

## API

- `GET /api/status` → Gemini + Arduino link state
- `POST /api/measure` `{ "net", "hole", "fault", "forceMock?" }` → `{ "voltage", "source": "arduino"|"mock", ... }`
- `POST /api/scope` `{ "channel": "A0", "samples": 64 }` → `{ "volts": [...], "net", "source" }`
- `POST /api/diagnose` context → `{ "message", "source": "gemini"|"mock" }` (use `stage: "process_fault"` for full diagnosis + solution)
- `POST /api/arduino/reconnect` → reopen serial port

## License

MIT
