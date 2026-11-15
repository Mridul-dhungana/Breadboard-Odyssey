#!/usr/bin/env python3
"""Breadboard Odyssey local server: static files + Arduino/mock measure + Gemini/mock diagnose."""

from __future__ import annotations

import json
import math
import os
import random
import sys
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader so GEMINI_API_KEY / ARDUINO_PORT can live outside the shell."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = val


_load_dotenv(ROOT / ".env")

from arduino_bridge import bridge  # noqa: E402

PORT = int(os.environ.get("PORT", "8765"))
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
# gemini-2.0-flash was shut down (404). Prefer current Flash aliases.
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash").strip() or "gemini-3.6-flash"
_gemini_candidates = [
    GEMINI_MODEL,
    "gemini-3.6-flash",
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-1.5-flash",
]
GEMINI_MODEL_FALLBACKS: list[str] = []
for _m in _gemini_candidates:
    if _m and _m not in GEMINI_MODEL_FALLBACKS:
        GEMINI_MODEL_FALLBACKS.append(_m)
PREFER_ARDUINO = os.environ.get("PREFER_ARDUINO", "1").strip() not in ("0", "false", "False")
ACTIVE_GEMINI_MODEL = GEMINI_MODEL

# TIMER_DEMO expected rails / nets (interface fixture — not SPICE).
EXPECTED = {
    "VCC": {"nom": 5.0, "tol": 0.4, "label": "Supply rail"},
    "0": {"nom": 0.0, "tol": 0.15, "label": "Ground"},
    "GND": {"nom": 0.0, "tol": 0.15, "label": "Ground"},
    "CTRL": {"nom": 3.33, "tol": 0.35, "label": "Control (~2/3 VCC)"},
    "OUT": {"nom": 2.5, "tol": 2.2, "label": "Output (astable)"},
    "TIMING": {"nom": 2.5, "tol": 1.4, "label": "Timing node"},
    "DISCHARGE": {"nom": 2.5, "tol": 2.5, "label": "Discharge node"},
}

FAULT_OFFSETS = {
    "healthy": {},
    "open_vcc": {"VCC": 0.05, "OUT": 0.02, "CTRL": 0.02, "TIMING": 0.02, "DISCHARGE": 0.02},
    "open_gnd": {"0": 1.8, "GND": 1.8, "OUT": 1.1, "CTRL": 4.2},
    "out_short": {"OUT": 0.04},
    "timing_open": {"TIMING": 4.9, "OUT": 0.1},
}


def mock_voltage(net: str, fault: str) -> float:
    net_u = (net or "").upper()
    offsets = FAULT_OFFSETS.get(fault, FAULT_OFFSETS["healthy"])
    if net_u in offsets:
        return float(offsets[net_u])
    base = EXPECTED.get(net_u, {}).get("nom", 0.0)
    return round(base + random.uniform(-0.04, 0.04), 3)


def measure_voltage(net: str, fault: str, force_mock: bool = False) -> dict:
    net_u = str(net or "VCC").upper()
    if PREFER_ARDUINO and bridge.enabled and not force_mock:
        try:
            volts = bridge.read_voltage(net_u)
            exp = EXPECTED.get(net_u)
            ok = None
            if exp:
                ok = abs(volts - exp["nom"]) <= exp["tol"]
            return {
                "voltage": round(float(volts), 3),
                "net": net_u,
                "channel": bridge.channel_for_net(net_u),
                "source": "arduino",
                "ok": ok,
                "expected": exp,
                "note": f"Live reading from {bridge.port}",
            }
        except Exception as exc:  # noqa: BLE001
            # Fall through to mock but report the Arduino error
            mock = mock_voltage(net_u, fault)
            exp = EXPECTED.get(net_u)
            return {
                "voltage": mock,
                "net": net_u,
                "source": "mock",
                "fallbackFrom": "arduino",
                "arduinoError": str(exc),
                "ok": abs(mock - exp["nom"]) <= exp["tol"] if exp else None,
                "expected": exp,
                "note": "Arduino read failed; returned mock voltage.",
            }
    volts = mock_voltage(net_u, fault)
    exp = EXPECTED.get(net_u)
    return {
        "voltage": volts,
        "net": net_u,
        "source": "mock",
        "ok": abs(volts - exp["nom"]) <= exp["tol"] if exp else None,
        "expected": exp,
        "note": "Mock ADC (set ARDUINO_PORT for live Uno Q readings).",
    }


def mock_diagnose(payload: dict) -> str:
    stage = payload.get("stage")
    pending = payload.get("pending") or {}
    readings = payload.get("readings") or []
    last = payload.get("lastReading") or (readings[-1] if readings else None)
    circuit = payload.get("circuit") or {}
    symptom = payload.get("symptom") or {}
    fault = payload.get("fault")

    if stage == "build":
        if not circuit.get("hasTimer"):
            return "Import the 555 timer netlist so TIMER_DEMO is on the tray."
        if not circuit.get("allPlaced"):
            return "Place every part (Auto-set is fine), then draw the suggested jumpers."
        if not circuit.get("allJumpersDrawn"):
            return "Add the remaining suggested jumpers to close the nets."
        return "Assembly looks ready. Move to Investigate and pick a symptom."

    if stage == "investigate":
        if not symptom:
            return "Choose a symptom to start the closed measurement loop."
        if pending and not last:
            hole = pending.get("hole")
            net = pending.get("net")
            exp = (pending.get("expected") or {}).get("nom")
            return f"Probe {hole} on net {net}. Expect about {exp} V on a healthy TIMER_DEMO."
        if last:
            net = last.get("net")
            volts = float(last.get("volts", 0))
            ok = last.get("ok")
            src = last.get("source", "mock")
            prefix = f"[{src}] "
            if net == "VCC" and ok is False:
                return (
                    f"{prefix}VCC measured {volts:.2f} V instead of ~5 V. "
                    "Likely an open supply jumper or unpowered rail — go to Repair."
                )
            if net in ("0", "GND") and ok is False:
                return f"{prefix}Ground is {volts:.2f} V. Check the ground return jumper and supply − rail."
            if ok:
                return f"{prefix}{net} looks plausible at {volts:.2f} V. Continue to the next highlighted net."
            return f"{prefix}{net} is off at {volts:.2f} V versus the expected rail. Use that in Repair."
        return "Capture the highlighted measurement."

    if stage == "repair":
        if fault == "healthy":
            return "Fault cleared. Re-measure with Arduino (or mock) in Verify."
        return (
            f"Active mock fault is '{fault}' (used only when Arduino is offline). "
            "Fix the matching jumper/short on the physical board, then Verify with a live reading."
        )

    if stage == "verify":
        return "Re-measure VCC, OUT, and CTRL. Healthy rails should sit near expected values."

    if stage == "debug":
        ch = payload.get("channel") or "A0"
        net = payload.get("net") or "VCC"
        return f"Scope {ch} on net {net}. Yellow holes are the probe points — run the scope to watch the waveform."

    return "Build the circuit, then open Debug for the A0 scope."


def _gemini_generate(prompt: str, model: str) -> str | None:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}"
        f":generateContent?key={GEMINI_API_KEY}"
    )
    body = json.dumps(
        {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.35, "maxOutputTokens": 260},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = (
        data.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text")
    )
    return (text or "").strip() or None


def gemini_diagnose(payload: dict) -> tuple[str | None, str | None]:
    """Returns (message, model_used). Tries current Flash models if one 404s."""
    global ACTIVE_GEMINI_MODEL
    if not GEMINI_API_KEY:
        return None, None
    expected_block = {k: v for k, v in EXPECTED.items() if k != "GND"}
    prompt = (
        "You are an electronics lab coach for Breadboard Odyssey.\n"
        "Circuit: 555 TIMER_DEMO on a solderless breadboard (wiring fixture — not a SPICE model).\n"
        "Hardware: optional Arduino UNO Q measuring ADC channels mapped to nets.\n"
        "Job: interpret the latest voltage reading vs expected rails and give ONE clear next action "
        "(which net/hole to probe next, which jumper to fix, or verify). "
        "If source is arduino, treat the volts as physical truth. "
        "If source is mock, say so briefly. 1-3 short sentences. No markdown, no bullet lists.\n\n"
        f"Expected rails (nom/tol):\n{json.dumps(expected_block, indent=2)}\n\n"
        f"Session context:\n{json.dumps(payload, indent=2)}\n"
    )
    last_err: Exception | None = None
    for model in GEMINI_MODEL_FALLBACKS:
        try:
            text = _gemini_generate(prompt, model)
            if text:
                ACTIVE_GEMINI_MODEL = model
                return text, model
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError) as exc:
            last_err = exc
            continue
    if last_err:
        print(f"[gemini] all models failed; last error: {last_err}")
    return None, None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json(self, code: int, obj: dict) -> None:
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] == "/api/status":
            if bridge.enabled:
                bridge.connect()
            self._json(
                200,
                {
                    "gemini": {
                        "configured": bool(GEMINI_API_KEY),
                        "model": ACTIVE_GEMINI_MODEL if GEMINI_API_KEY else None,
                        "fallbacks": GEMINI_MODEL_FALLBACKS if GEMINI_API_KEY else [],
                    },
                    "arduino": bridge.status(),
                    "preferArduino": PREFER_ARDUINO,
                    "expected": EXPECTED,
                },
            )
            return
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/measure":
            data = self._read_json()
            net = str(data.get("net", "VCC")).upper()
            fault = str(data.get("fault", "healthy"))
            force_mock = bool(data.get("forceMock"))
            result = measure_voltage(net, fault, force_mock=force_mock)
            result["hole"] = data.get("hole")
            result["fault"] = fault
            self._json(200, result)
            return
        if self.path == "/api/diagnose":
            data = self._read_json()
            # Enrich with live hardware status so Gemini knows what's real
            data["hardware"] = {
                "arduino": bridge.status(),
                "geminiConfigured": bool(GEMINI_API_KEY),
            }
            gem, model = gemini_diagnose(data)
            if gem:
                self._json(200, {"message": gem, "source": "gemini", "model": model})
            else:
                self._json(
                    200,
                    {
                        "message": mock_diagnose(data),
                        "source": "mock",
                        "reason": "no_key" if not GEMINI_API_KEY else "gemini_error",
                    },
                )
            return
        if self.path == "/api/arduino/reconnect":
            bridge.close()
            ok = bridge.connect()
            self._json(200, {"ok": ok, "arduino": bridge.status()})
            return
        if self.path == "/api/scope":
            data = self._read_json()
            channel = str(data.get("channel", "A0")).upper()
            count = max(8, min(int(data.get("samples", 64)), 200))
            # Map channel → net using bridge defaults
            net = None
            for n, ch in bridge.net_map.items():
                if ch == channel:
                    net = n
                    break
            if net is None:
                net = {"A0": "VCC", "A1": "0", "A2": "OUT", "A3": "CTRL", "A4": "TIMING", "A5": "DISCHARGE"}.get(
                    channel, "VCC"
                )
            fault = str(data.get("fault", "healthy"))
            volts: list[float] = []
            source = "mock"
            note = ""
            if PREFER_ARDUINO and bridge.enabled:
                try:
                    if not bridge.connect():
                        raise RuntimeError(bridge.last_error or "not connected")
                    for _ in range(count):
                        volts.append(round(float(bridge.read_voltage(net, channel)), 3))
                    source = "arduino"
                    note = f"Live sweep from {bridge.port} {channel}"
                except Exception as exc:  # noqa: BLE001
                    note = f"Arduino sweep failed ({exc}); mock waveform"
                    source = "mock"
            if not volts:
                # Mock waveforms: A0/VCC ≈ DC rail; A2/OUT ≈ slow square (555-ish)
                base = mock_voltage(net, fault)
                for i in range(count):
                    if channel == "A2" or net == "OUT":
                        # ~500 Hz square-ish mock between rails
                        phase = math.sin(2 * math.pi * 8 * (i / count))
                        v = 4.8 if phase >= 0 else 0.2
                        v += random.uniform(-0.05, 0.05)
                    elif channel in ("A4",) or net == "TIMING":
                        v = 1.6 + 1.7 * (0.5 + 0.5 * math.sin(2 * math.pi * 3 * (i / count)))
                        v += random.uniform(-0.04, 0.04)
                    else:
                        v = base + random.uniform(-0.03, 0.03)
                    volts.append(round(max(0.0, min(5.2, v)), 3))
                if not note:
                    note = "Mock scope sweep (set ARDUINO_PORT for live A0)"
            self._json(
                200,
                {
                    "channel": channel,
                    "net": net,
                    "volts": volts,
                    "count": len(volts),
                    "source": source,
                    "note": note,
                },
            )
            return
        self._json(404, {"error": "not found"})

    def log_message(self, fmt: str, *args) -> None:
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


def main() -> None:
    os.chdir(ROOT)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    gem = (
        f"Gemini ON (default {GEMINI_MODEL}; fallbacks {', '.join(GEMINI_MODEL_FALLBACKS)})"
        if GEMINI_API_KEY
        else "Gemini off (export GEMINI_API_KEY)"
    )
    ard = f"Arduino {bridge.port}" if bridge.enabled else "Arduino off (export ARDUINO_PORT)"
    print(f"Breadboard Odyssey on http://127.0.0.1:{PORT}")
    print(f"  {gem}")
    print(f"  {ard}")
    print(f"Serving {ROOT}")
    if bridge.enabled:
        bridge.connect()
        print(f"  Arduino status: {bridge.status()}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        bridge.close()


if __name__ == "__main__":
    main()
