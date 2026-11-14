# Breadboard Odyssey

Hackathon MVP: assemble a **555 timer** breadboard circuit from a SPICE-like netlist, then diagnose it with a closed loop of **highlighted probe points → mock voltage readings → understandable next actions** (Gemini when available, local heuristics otherwise).

Journey: **Build → Investigate → Repair → Verify**.

## Quick start

```bash
# from repo root
python3 python/server.py
# open http://127.0.0.1:8765
```

Optional live coach:

```bash
export GEMINI_API_KEY=your_key_here
python3 python/server.py
```

Static-only (board UI works; `/api/*` calls fall back to in-browser mocks):

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

## Demo path (555 timer)

1. **Build** — 555 timer netlist is loaded by default. Click **Auto-set**, confirm jumpers are drawn, then **Continue to Investigate**.
2. **Investigate** — Choose a symptom (e.g. board unpowered). **Start diagnostic loop**. Yellow holes mark the probe. **Capture mock reading** (default mock fault is an open VCC jumper → ~0 V on VCC).
3. **Repair** — Follow the coach steps. Set **Mock hardware fault → Healthy** (or **Mark repaired**), then continue.
4. **Verify** — Capture mock readings on VCC → OUT → CTRL. With Healthy fault, verify should pass.

Divider example remains available as an import fixture.

## What is mocked

| Piece | Behavior |
| --- | --- |
| `TIMER_DEMO` / NE555 | Wiring/interface profile only — **no behavioral SPICE** |
| Voltage measurements | `POST /api/measure` returns mock ADC volts from a selectable fault model |
| Arduino UNO Q | Not required. `python/serial_stub.py` is a placeholder for later serial |
| Gemini coach | Used when `GEMINI_API_KEY` is set; otherwise mock/local heuristics |
| Auto-routing / camera / auth / DB | Out of scope |

## Layout

```
index.html          UI shell + journey panels
css/app.css         Styles
js/board.js         Netlist parse, placement, jumpers (prototype interactions)
js/diagnose.js      Expected rails, measurement loop, coach client
js/app.js           Stage wiring
python/server.py    Static server + /api/measure + /api/diagnose
python/serial_stub.py  Future UNO Q serial placeholder
```

## API

- `POST /api/measure` `{ "net", "hole", "fault" }` → `{ "voltage", "source": "mock" }`
- `POST /api/diagnose` journey context → `{ "message", "source": "gemini"|"mock" }`

## License

MIT
