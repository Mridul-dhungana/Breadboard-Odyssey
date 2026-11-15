# Breadboard Odyssey

Hackathon MVP: assemble a breadboard circuit from a SPICE-like netlist, then debug it with a **live Arduino scope** and a **Gemini chat coach**.

**Local-first:** clone the repo, plug in an Arduino, add a Gemini key, and run on your machine. There is no cloud deploy for the LIVE hardware loop — USB serial has to stay with the board.

Modes: **Build** (Divider, 555 timer, or Dual LEDs), then **Debug** with oscilloscope channels **A0–A5** and a sidebar chat.

**Standout loop:** place circuit → Fit wires / Auto-set → Debug → say what’s wrong → Capture + ask chat → name the probe point → coach replies with steps.

This project is **live-only**: there is no mock ADC, mock waveform, mock fault model, or mock coach diagnosis.

## Quick start (pull and run)

```bash
git clone https://github.com/Mridul-dhungana/Breadboard-Odyssey.git
cd Breadboard-Odyssey
git checkout main && git pull
pip install -r requirements.txt   # pyserial for Arduino
cp .env.example .env              # set GEMINI_API_KEY (and optional ARDUINO_PORT)
python3 python/check_links.py     # optional: verify Gemini + Arduino (prints no secrets)
python3 python/server.py
# open http://127.0.0.1:8765  (hard-refresh if the UI looks stale: Ctrl+Shift+R / Cmd+Shift+R)
```

After a pull, always restart `python/server.py` from the repo root. The server sends `Cache-Control: no-store` for HTML/CSS/JS and cache-busts asset URLs.

### Environment

```bash
# .env (never commit)
GEMINI_API_KEY=...          # Google AI Studio / Gemini API key — required for Debug chat
GEMINI_MODEL=gemini-2.5-flash-lite
ARDUINO_PORT=               # empty = auto-detect; Linux /dev/ttyACM0, macOS /dev/cu.usbmodem*, Windows COM3
PORT=8765
```

Or export in the shell:

```bash
export GEMINI_API_KEY=...
export ARDUINO_PORT=/dev/ttyACM0
python3 python/server.py
```

Without Arduino, scope/measure return `source: "error"` (empty samples — no invented waveform). Without Gemini, Debug chat returns an error asking for `GEMINI_API_KEY`.

### Arduino hardware

1. Flash [`arduino/BreadboardProbe/BreadboardProbe.ino`](arduino/BreadboardProbe/BreadboardProbe.ino) (115200 baud).
2. Wire ADC sense lines to the points you want to probe (share GND; ≤5 V on ADC pins).

Default firmware channel map (re-wire as needed for your circuit):

| Channel | Default sense (555 harness example) |
| --- | --- |
| A0 | VCC |
| A1 | GND / 0 |
| A2 | OUT |
| A3 | CTRL |
| A4 | TIMING |
| A5 | DISCHARGE |

In the UI, channels are labeled **A0–A5** only (not tied to 555 net names). Yellow holes highlight board nets when the soft hint matches what’s placed.

**Links** panel: pick a serial port (or Auto-detect) → **Reconnect Arduino** → Run scope until readout says **LIVE**.

## Build

1. Pick a demo (**Divider**, **555 timer**, **Dual LEDs**) or paste your own netlist → **Import**.
2. Place parts (drag/click) or **Auto-set**. Jumpers **Fit wires** automatically when parts move; use **Fit wires** to redraw on demand.
3. Supported parts: `R`, `C`, `D` (with `.MODEL name D(…)`), DC `V` sources, `.op`, and one NE555 terminal profile (`TIMER_DEMO` — interface only, not behavioral SPICE).
4. When checklist is complete → **Open Debug**.

## Debug chat

1. Chat asks **what’s not working** — history stays in the sidebar and is resent every turn.
2. **Send** your symptom; coach may ask clarifying questions, then give short steps.
3. **Steps done** tells the coach you finished the last steps (full history goes again).
4. **Capture + ask chat** takes a LIVE scope sweep, then **waits** — type which circuit point the capture is from, then **Send**. Scope data attaches on that Send (not before).
5. Scope: **Run** / **Stop** / **Single capture** on channel A0–A5.

## What is live

| Piece | Behavior |
| --- | --- |
| Netlist / breadboard | Wiring UI only — not a SPICE simulator |
| `TIMER_DEMO` / NE555 | Pin profile for placement — **no behavioral SPICE** |
| Diodes / LEDs (`D` + `.MODEL … D`) | Wiring only — anode/cathode on the board |
| Fit wires | Auto-routes suggested jumpers when parts move |
| Voltages / scope | **Arduino only** — errors if not linked |
| Debug chat / Gemini | **Required** for coach replies; history + circuit (+ scope when attached) |
| Cloud deploy / auth / DB | Out of scope — run locally |

## Layout

```
index.html
css/app.css
js/board.js diagnose.js scope.js app.js
python/server.py          HTTP + /api/measure /api/diagnose /api/status /api/scope
python/arduino_bridge.py  pyserial MEAS/SWEEP protocol
arduino/BreadboardProbe/  Uno / UNO Q firmware
requirements.txt
.env.example
```

## API

- `GET /api/status` → Gemini + Arduino link state (`mockEnabled: false`)
- `POST /api/measure` `{ "net", "hole" }` → live `{ "voltage", "source": "arduino" }` or `{ "source": "error" }`
- `POST /api/scope` `{ "channel": "A0", "samples": 64 }` → live `{ "volts": [...], "source": "arduino" }` or error
- `POST /api/diagnose` chat/circuit/scope context → `{ "message", "source": "gemini"|"local"|"error" }`
- `POST /api/arduino/reconnect` `{ "port?" }` → reopen serial port
- `POST /api/arduino/ports` → list serial devices

## License

MIT
