#!/usr/bin/env python3
"""Breadboard Odyssey local server: static files + live Arduino measure + Gemini diagnose (no mocks)."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))


def _load_dotenv(path: Path, *, override: bool = False) -> None:
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
        if not key:
            continue
        if override or key not in os.environ:
            os.environ[key] = val


_load_dotenv(ROOT / ".env")

from arduino_bridge import bridge  # noqa: E402

PORT = int(os.environ.get("PORT", "8765"))
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
# Prefer widely available Flash models; keep newer aliases as optional overrides.
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash").strip() or "gemini-2.5-flash"
_gemini_candidates = [
    GEMINI_MODEL,
    "gemini-2.5-flash",
    "gemini-flash-latest",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-3.6-flash",
]
GEMINI_MODEL_FALLBACKS: list[str] = []
for _m in _gemini_candidates:
    if _m and _m not in GEMINI_MODEL_FALLBACKS:
        GEMINI_MODEL_FALLBACKS.append(_m)
ACTIVE_GEMINI_MODEL = GEMINI_MODEL
LAST_GEMINI_ERROR: str | None = None


def refresh_runtime_config() -> None:
    """Reload .env for Gemini + Arduino without restarting the process."""
    _load_dotenv(ROOT / ".env", override=True)
    refresh_gemini_config()
    bridge.refresh_config()


def refresh_gemini_config() -> None:
    """Reload .env so a newly added GEMINI_API_KEY is picked up without a full process restart."""
    global GEMINI_API_KEY, GEMINI_MODEL, GEMINI_MODEL_FALLBACKS, ACTIVE_GEMINI_MODEL
    _load_dotenv(ROOT / ".env", override=True)
    GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
    GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash").strip() or "gemini-2.5-flash"
    candidates = [
        GEMINI_MODEL,
        "gemini-2.5-flash",
        "gemini-flash-latest",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-3.6-flash",
    ]
    GEMINI_MODEL_FALLBACKS = []
    for model in candidates:
        if model and model not in GEMINI_MODEL_FALLBACKS:
            GEMINI_MODEL_FALLBACKS.append(model)
    if ACTIVE_GEMINI_MODEL not in GEMINI_MODEL_FALLBACKS:
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

def measure_voltage(net: str) -> dict:
    """Live Arduino ADC only — never invents voltages."""
    net_u = str(net or "VCC").upper()
    exp = EXPECTED.get(net_u)
    try:
        if not bridge.enabled:
            raise RuntimeError(
                "No Arduino port. Set ARDUINO_PORT or plug in the board and Reconnect."
            )
        volts = bridge.read_voltage(net_u)
        ok = abs(volts - exp["nom"]) <= exp["tol"] if exp else None
        return {
            "voltage": round(float(volts), 3),
            "net": net_u,
            "channel": bridge.channel_for_net(net_u),
            "source": "arduino",
            "ok": ok,
            "expected": exp,
            "note": f"Live reading from {bridge.port}",
            "live": True,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "voltage": None,
            "net": net_u,
            "source": "error",
            "arduinoError": str(exc),
            "ok": None,
            "expected": exp,
            "note": f"Arduino read failed: {exc}",
            "live": False,
        }


def local_guide(payload: dict) -> str:
    """Assembly / UI guidance only (not a fake measurement or fault diagnosis)."""
    stage = payload.get("stage")
    circuit = payload.get("circuit") or {}
    if stage == "build":
        if not circuit.get("hasTimer"):
            return "Import the 555 timer netlist so TIMER_DEMO is on the tray."
        if not circuit.get("allPlaced"):
            return "Place every part (Auto-set is fine), then draw the suggested jumpers."
        if not circuit.get("allJumpersDrawn"):
            return "Add the remaining suggested jumpers to close the nets."
        return "Assembly looks ready. Open Debug and capture a LIVE Arduino scope sweep."
    if stage == "debug":
        ch = payload.get("channel") or "A0"
        net = payload.get("net") or "VCC"
        return (
            f"Probe {ch} (net {net}). Connect Arduino, Run scope until readout says LIVE, "
            "then Analyze signal with Gemini."
        )
    return "Connect Arduino + Gemini for live capture and analysis. No simulated data is used."


def _format_http_error(exc: urllib.error.HTTPError) -> str:
    body = ""
    try:
        body = exc.read().decode("utf-8", errors="replace")[:400]
    except Exception:  # noqa: BLE001
        body = ""
    return f"HTTP {exc.code} {exc.reason}" + (f": {body}" if body else "")


def _gemini_generate(prompt: str, model: str, max_tokens: int = 260) -> str | None:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}"
        f":generateContent?key={GEMINI_API_KEY}"
    )
    body = json.dumps(
        {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.35, "maxOutputTokens": max_tokens},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = (
        data.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text")
    )
    return (text or "").strip() or None


def gemini_diagnose(payload: dict) -> tuple[str | None, str | None, str | None]:
    """Returns (message, model_used, error). Tries Flash model fallbacks if one 404s."""
    global ACTIVE_GEMINI_MODEL, LAST_GEMINI_ERROR
    refresh_gemini_config()
    LAST_GEMINI_ERROR = None
    if not GEMINI_API_KEY:
        LAST_GEMINI_ERROR = "GEMINI_API_KEY not set"
        return None, None, LAST_GEMINI_ERROR
    expected_block = {k: v for k, v in EXPECTED.items() if k != "GND"}
    # Trim huge sample arrays so the prompt stays small/fast
    ctx = dict(payload)
    if isinstance(ctx.get("scope"), dict):
        scope = dict(ctx["scope"])
        samples = scope.get("samples") or []
        if isinstance(samples, list) and len(samples) > 24:
            scope["sampleCount"] = len(samples)
            scope["samples"] = samples[:: max(1, len(samples) // 24)][:24]
            ctx["scope"] = scope
    stage = ctx.get("stage")
    if stage == "process_fault":
        prompt = (
            "You are an electronics lab coach for Breadboard Odyssey.\n"
            "Circuit: 555 TIMER_DEMO on a solderless breadboard (wiring fixture — not a SPICE model).\n"
            "The student pressed Analyze signal with Gemini after capturing an oscilloscope sweep.\n"
            "Analyze the waveform/signal stats vs expected rails and give a diagnosis:\n"
            "(1) what the signal suggests (healthy rail, open supply, stuck output, oscillating, noise, etc.),\n"
            "(2) most likely fault in one short sentence,\n"
            "(3) 2-4 concrete next repair/probe steps (net/hole/jumper).\n"
            "Treat scope volts as physical Arduino truth only (source must be arduino). "
            "No markdown headings. Short plain sentences or a compact numbered list.\n\n"
            f"Expected rails (nom/tol):\n{json.dumps(expected_block, indent=2)}\n\n"
            f"Session context:\n{json.dumps(ctx, indent=2)}\n"
        )
        max_tokens = 480
    else:
        prompt = (
            "You are an electronics lab coach for Breadboard Odyssey.\n"
            "Circuit: 555 TIMER_DEMO on a solderless breadboard (wiring fixture — not a SPICE model).\n"
            "Hardware: optional Arduino UNO Q measuring ADC channels mapped to nets.\n"
            "Job: interpret the latest LIVE Arduino voltage vs expected rails and give ONE clear next action "
            "(which net/hole to probe next, which jumper to fix, or verify). "
            "Treat volts as physical truth. 1-3 short sentences. No markdown, no bullet lists.\n\n"
            f"Expected rails (nom/tol):\n{json.dumps(expected_block, indent=2)}\n\n"
            f"Session context:\n{json.dumps(ctx, indent=2)}\n"
        )
        max_tokens = 260
    last_err: str | None = None
    for model in GEMINI_MODEL_FALLBACKS:
        try:
            text = _gemini_generate(prompt, model, max_tokens=max_tokens)
            if text:
                ACTIVE_GEMINI_MODEL = model
                LAST_GEMINI_ERROR = None
                return text, model, None
            last_err = f"{model}: empty response"
        except urllib.error.HTTPError as exc:
            last_err = f"{model}: {_format_http_error(exc)}"
            print(f"[gemini] {last_err}")
            continue
        except (urllib.error.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError) as exc:
            last_err = f"{model}: {exc}"
            print(f"[gemini] {last_err}")
            continue
    LAST_GEMINI_ERROR = last_err or "all Gemini models failed"
    print(f"[gemini] all models failed; last error: {LAST_GEMINI_ERROR}")
    return None, None, LAST_GEMINI_ERROR


def _asset_version(*rel_paths: str) -> str:
    """Fingerprint static UI files so browsers reload after git pull."""
    latest = 0
    for rel in rel_paths:
        try:
            latest = max(latest, int((ROOT / rel).stat().st_mtime))
        except OSError:
            continue
    return str(latest or int(time.time()))


ASSET_VERSION = _asset_version(
    "index.html",
    "css/app.css",
    "js/app.js",
    "js/board.js",
    "js/diagnose.js",
    "js/scope.js",
)


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **getattr(SimpleHTTPRequestHandler, "extensions_map", {}),
        ".js": "application/javascript",
        ".css": "text/css",
        ".html": "text/html",
        "": "application/octet-stream",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        # Local demos: never let the browser keep stale CSS/JS after a git pull.
        path = self.path.split("?", 1)[0].lower()
        if (
            path in ("/", "/index.html")
            or path.endswith((".html", ".css", ".js", ".map"))
        ):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def _json(self, code: int, obj: dict) -> None:
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def _serve_index(self) -> None:
        """Inject cache-busting query params so pulled CSS/JS always reload."""
        html_path = ROOT / "index.html"
        try:
            html = html_path.read_text(encoding="utf-8")
        except OSError:
            self.send_error(404, "index.html missing")
            return
        ver = _asset_version(
            "index.html",
            "css/app.css",
            "js/app.js",
            "js/board.js",
            "js/diagnose.js",
            "js/scope.js",
        )
        html = (
            html.replace('href="css/app.css"', f'href="css/app.css?v={ver}"')
            .replace('src="js/board.js"', f'src="js/board.js?v={ver}"')
            .replace('src="js/diagnose.js"', f'src="js/diagnose.js?v={ver}"')
            .replace('src="js/scope.js"', f'src="js/scope.js?v={ver}"')
            .replace('src="js/app.js"', f'src="js/app.js?v={ver}"')
        )
        raw = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self._serve_index()
            return
        if path == "/api/status":
            refresh_runtime_config()
            bridge.connect()
            self._json(
                200,
                {
                    "gemini": {
                        "configured": bool(GEMINI_API_KEY),
                        "model": ACTIVE_GEMINI_MODEL if GEMINI_API_KEY else None,
                        "fallbacks": GEMINI_MODEL_FALLBACKS if GEMINI_API_KEY else [],
                        "lastError": LAST_GEMINI_ERROR,
                    },
                    "arduino": bridge.status(),
                    "preferArduino": True,
                    "allowMockScope": False,
                    "mockEnabled": False,
                    "expected": EXPECTED,
                    "ui": {
                        "root": str(ROOT),
                        "assetVersion": _asset_version(
                            "index.html",
                            "css/app.css",
                            "js/app.js",
                            "js/board.js",
                            "js/diagnose.js",
                            "js/scope.js",
                        ),
                        "theme": "oled-black",
                    },
                },
            )
            return
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/measure":
            data = self._read_json()
            net = str(data.get("net", "VCC")).upper()
            result = measure_voltage(net)
            result["hole"] = data.get("hole")
            self._json(200, result)
            return
        if self.path == "/api/diagnose":
            data = self._read_json()
            refresh_runtime_config()
            data["hardware"] = {
                "arduino": bridge.status(),
                "geminiConfigured": bool(GEMINI_API_KEY),
            }
            stage = data.get("stage")
            # Build/debug assembly tips can be local; analysis requires Gemini.
            if stage in ("process_fault", "investigate", "repair", "verify") or data.get("intent") == "analyze_signal":
                gem, model, err = gemini_diagnose(data)
                if gem:
                    self._json(200, {"message": gem, "source": "gemini", "model": model})
                else:
                    reason = "no_key" if not GEMINI_API_KEY else "gemini_error"
                    self._json(
                        200,
                        {
                            "message": (
                                "Gemini is required for signal/fault analysis. "
                                + (
                                    "Add GEMINI_API_KEY to .env and click Refresh links."
                                    if reason == "no_key"
                                    else f"Gemini call failed: {err or LAST_GEMINI_ERROR}"
                                )
                            ),
                            "source": "error",
                            "reason": reason,
                            "error": err or LAST_GEMINI_ERROR,
                            "detail": err or LAST_GEMINI_ERROR,
                        },
                    )
                return
            gem, model, err = gemini_diagnose(data)
            if gem:
                self._json(200, {"message": gem, "source": "gemini", "model": model})
            else:
                self._json(
                    200,
                    {
                        "message": local_guide(data),
                        "source": "local",
                        "reason": "no_key" if not GEMINI_API_KEY else "gemini_error",
                        "error": err or LAST_GEMINI_ERROR,
                    },
                )
            return
        if self.path == "/api/arduino/reconnect":
            refresh_runtime_config()
            data = self._read_json()
            port = str(data.get("port") or "").strip()
            if port:
                os.environ["ARDUINO_PORT"] = port
            bridge.close()
            bridge.refresh_config()
            ok = bridge.connect()
            self._json(200, {"ok": ok, "arduino": bridge.status()})
            return
        if self.path == "/api/arduino/ports":
            refresh_runtime_config()
            self._json(200, {"ports": bridge.status().get("ports", []), "arduino": bridge.status()})
            return
        if self.path == "/api/scope":
            refresh_runtime_config()
            data = self._read_json()
            channel = str(data.get("channel", "A0")).upper()
            count = max(8, min(int(data.get("samples", 40)), 200))
            net = None
            for n, ch in bridge.net_map.items():
                if ch == channel:
                    net = n
                    break
            if net is None:
                net = {"A0": "VCC", "A1": "0", "A2": "OUT", "A3": "CTRL", "A4": "TIMING", "A5": "DISCHARGE"}.get(
                    channel, "VCC"
                )
            volts: list[float] = []
            source = "error"
            note = ""
            arduino_error = None
            try:
                if not bridge.enabled:
                    raise RuntimeError(
                        "No Arduino port found. Set ARDUINO_PORT in .env (e.g. /dev/ttyACM0 or COM3) "
                        "or plug in the board and click Reconnect Arduino."
                    )
                if not bridge.connect():
                    raise RuntimeError(bridge.last_error or "not connected")
                volts = [round(v, 3) for v in bridge.read_sweep(channel, count, net=net)]
                if not volts:
                    raise RuntimeError("Arduino returned an empty sweep")
                source = "arduino"
                note = f"Live sweep from {bridge.port} {channel}"
            except Exception as exc:  # noqa: BLE001
                arduino_error = str(exc)
                note = f"Arduino sweep failed: {exc}"
                source = "error"
                volts = []

            self._json(
                200,
                {
                    "channel": channel,
                    "net": net,
                    "volts": volts,
                    "count": len(volts),
                    "source": source,
                    "note": note,
                    "arduinoError": arduino_error,
                    "port": bridge.port or None,
                    "live": source == "arduino",
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
    refresh_runtime_config()
    ard = (
        f"Arduino {bridge.port}" + (" (auto)" if bridge.autodetected else "")
        if bridge.enabled
        else "Arduino off (set ARDUINO_PORT or plug in board for auto-detect)"
    )
    print(f"Breadboard Odyssey on http://127.0.0.1:{PORT}")
    print(f"  {gem}")
    print(f"  {ard}")
    print("  Mode: LIVE ONLY (mock measure/scope/coach disabled)")
    print(f"Serving {ROOT}")
    print(f"  UI assetVersion={_asset_version('css/app.css', 'js/app.js', 'index.html')} theme=oled-black")
    print("  If the page looks stale after git pull: restart this server, then hard-refresh the browser.")
    bridge.connect()
    print(f"  Arduino status: {bridge.status()}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        bridge.close()


if __name__ == "__main__":
    main()
