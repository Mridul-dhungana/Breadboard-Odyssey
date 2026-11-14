#!/usr/bin/env python3
"""Breadboard Odyssey local server: static files + mock measure + Gemini/mock diagnose."""

from __future__ import annotations

import json
import os
import random
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("PORT", "8765"))
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")

# TIMER_DEMO expected rails / nets (interface fixture — not SPICE).
EXPECTED = {
    "VCC": 5.0,
    "0": 0.0,
    "GND": 0.0,
    "CTRL": 3.33,
    "OUT": 2.5,
    "TIMING": 2.5,
    "DISCHARGE": 2.5,
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
    base = EXPECTED.get(net_u, 0.0)
    return round(base + random.uniform(-0.04, 0.04), 3)


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
            volts = last.get("volts")
            ok = last.get("ok")
            if net == "VCC" and ok is False:
                return (
                    f"VCC measured {volts:.2f} V instead of ~5 V. "
                    "Treat this as a supply/jumper fault and go to Repair."
                )
            if ok:
                return f"{net} looks plausible at {volts:.2f} V. Continue to the next highlighted net."
            return f"{net} is off at {volts:.2f} V versus the expected rail. Use that in Repair."
        return "Capture the highlighted measurement."

    if stage == "repair":
        if fault == "healthy":
            return "Mock fault is cleared. Re-measure in Verify to confirm the rails."
        return (
            f"Active mock fault is '{fault}'. Fix the matching jumper/short on the board story, "
            "set fault to Healthy, then Verify."
        )

    if stage == "verify":
        return "Re-measure VCC, OUT, and CTRL. Healthy mock readings should sit near expected rails."

    return "Follow Build → Investigate → Repair → Verify."


def gemini_diagnose(payload: dict) -> str | None:
    if not GEMINI_API_KEY:
        return None
    prompt = (
        "You are a concise electronics lab coach for a breadboard 555 TIMER_DEMO (wiring fixture only, "
        "no SPICE). Given the JSON context, reply with 1-3 short sentences: what the reading means and "
        "the single next physical action (probe a net, fix a jumper, or verify). No markdown.\n\n"
        + json.dumps(payload, indent=2)
    )
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}"
        f":generateContent?key={GEMINI_API_KEY}"
    )
    body = json.dumps(
        {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.4, "maxOutputTokens": 220},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text = (
            data.get("candidates", [{}])[0]
            .get("content", {})
            .get("parts", [{}])[0]
            .get("text")
        )
        return (text or "").strip() or None
    except (urllib.error.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError):
        return None


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

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/measure":
            data = self._read_json()
            net = str(data.get("net", "VCC")).upper()
            fault = str(data.get("fault", "healthy"))
            voltage = mock_voltage(net, fault)
            self._json(
                200,
                {
                    "voltage": voltage,
                    "net": net,
                    "hole": data.get("hole"),
                    "fault": fault,
                    "source": "mock",
                    "note": "Mock ADC — swap this handler for Arduino UNO Q serial later.",
                },
            )
            return
        if self.path == "/api/diagnose":
            data = self._read_json()
            gem = gemini_diagnose(data)
            if gem:
                self._json(200, {"message": gem, "source": "gemini"})
            else:
                self._json(200, {"message": mock_diagnose(data), "source": "mock"})
            return
        self._json(404, {"error": "not found"})

    def log_message(self, fmt: str, *args) -> None:
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


def main() -> None:
    os.chdir(ROOT)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    mode = "Gemini+mock" if GEMINI_API_KEY else "mock-only (set GEMINI_API_KEY for live coach)"
    print(f"Breadboard Odyssey on http://127.0.0.1:{PORT}  ({mode})")
    print(f"Serving {ROOT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
