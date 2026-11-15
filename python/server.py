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
# Prefer lite/fast Flash aliases. Never include retired ids like gemini-1.5-flash.
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite"
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL
# Keep the happy-path list short so we do not burn seconds on sequential 404s.
_DEFAULT_GEMINI_CANDIDATES = [
    "gemini-2.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemini-2.5-flash",
]
_GEMINI_MAX_ATTEMPTS = 3
_GEMINI_HTTP_TIMEOUT_S = float(os.environ.get("GEMINI_TIMEOUT_S", "14"))
_GEMINI_LIST_TIMEOUT_S = 8.0
_LAST_GEMINI_CFG_AT = 0.0


def _dedupe_models(*groups: list[str]) -> list[str]:
    out: list[str] = []
    for group in groups:
        for model in group:
            name = (model or "").strip()
            if not name or name in out:
                continue
            # Drop known-dead / unsupported ids that only produce 404 noise.
            if name in {"gemini-1.5-flash", "gemini-1.5-pro", "gemini-1.0-pro", "gemini-pro"}:
                continue
            out.append(name)
    return out


GEMINI_MODEL_FALLBACKS: list[str] = _dedupe_models([GEMINI_MODEL], _DEFAULT_GEMINI_CANDIDATES)
# Remap if .env still names a retired id (e.g. gemini-1.5-flash).
if GEMINI_MODEL not in GEMINI_MODEL_FALLBACKS:
    GEMINI_MODEL = GEMINI_MODEL_FALLBACKS[0] if GEMINI_MODEL_FALLBACKS else DEFAULT_GEMINI_MODEL
ACTIVE_GEMINI_MODEL = GEMINI_MODEL
LAST_GEMINI_ERROR: str | None = None
_DISCOVERED_GEMINI_MODELS: list[str] | None = None


def refresh_runtime_config() -> None:
    """Reload .env for Gemini + Arduino without restarting the process."""
    _load_dotenv(ROOT / ".env", override=True)
    refresh_gemini_config(force=True)
    bridge.refresh_config()


def refresh_gemini_config(*, force: bool = False) -> None:
    """Reload .env so a newly added GEMINI_API_KEY is picked up without a full process restart."""
    global GEMINI_API_KEY, GEMINI_MODEL, GEMINI_MODEL_FALLBACKS, ACTIVE_GEMINI_MODEL
    global _DISCOVERED_GEMINI_MODELS, _LAST_GEMINI_CFG_AT
    now = time.monotonic()
    # Avoid re-reading .env on every diagnose tick — that alone adds latency.
    if not force and _LAST_GEMINI_CFG_AT and (now - _LAST_GEMINI_CFG_AT) < 8.0:
        return
    prev_key = GEMINI_API_KEY
    _load_dotenv(ROOT / ".env", override=True)
    GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
    if GEMINI_API_KEY != prev_key:
        _DISCOVERED_GEMINI_MODELS = None
    requested = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL
    GEMINI_MODEL_FALLBACKS = _dedupe_models([requested], _DEFAULT_GEMINI_CANDIDATES)
    GEMINI_MODEL = (
        requested
        if requested in GEMINI_MODEL_FALLBACKS
        else (GEMINI_MODEL_FALLBACKS[0] if GEMINI_MODEL_FALLBACKS else DEFAULT_GEMINI_MODEL)
    )
    if ACTIVE_GEMINI_MODEL not in GEMINI_MODEL_FALLBACKS and (
        _DISCOVERED_GEMINI_MODELS is None or ACTIVE_GEMINI_MODEL not in (_DISCOVERED_GEMINI_MODELS or [])
    ):
        ACTIVE_GEMINI_MODEL = GEMINI_MODEL
    _LAST_GEMINI_CFG_AT = now


def list_gemini_flash_models() -> list[str]:
    """Ask Google which generateContent flash models this key can use (cached)."""
    global _DISCOVERED_GEMINI_MODELS
    if _DISCOVERED_GEMINI_MODELS is not None:
        return list(_DISCOVERED_GEMINI_MODELS)
    if not GEMINI_API_KEY:
        return []
    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={GEMINI_API_KEY}"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=_GEMINI_LIST_TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"[gemini] ListModels failed: {exc}")
        _DISCOVERED_GEMINI_MODELS = []
        return []
    found: list[str] = []
    for item in data.get("models") or []:
        methods = item.get("supportedGenerationMethods") or []
        if "generateContent" not in methods:
            continue
        name = str(item.get("name") or "")
        if name.startswith("models/"):
            name = name[len("models/") :]
        low = name.lower()
        if "flash" not in low:
            continue
        if any(skip in low for skip in ("image", "audio", "tts", "live", "embed", "robot")):
            continue
        found.append(name)

    def rank(m: str) -> tuple[int, str]:
        ml = m.lower()
        score = 0
        if "lite" in ml:
            score += 40
        if "flash-latest" in ml or "flash-lite-latest" in ml:
            score += 30
        if "2.5" in ml:
            score += 15
        return (-score, ml)

    found.sort(key=rank)
    _DISCOVERED_GEMINI_MODELS = found
    return list(found)

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


def _gemini_generate(prompt: str, model: str, max_tokens: int = 220) -> str | None:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}"
        f":generateContent?key={GEMINI_API_KEY}"
    )
    body = json.dumps(
        {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": max_tokens,
                # Favor shorter completions for interactive lab coaching.
                "candidateCount": 1,
            },
        },
        separators=(",", ":"),
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=_GEMINI_HTTP_TIMEOUT_S) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    text = (
        data.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text")
    )
    return (text or "").strip() or None


def _slim_diagnose_context(payload: dict) -> dict:
    """Keep Gemini prompts small — large JSON is the main latency tax."""
    ctx: dict = {
        "stage": payload.get("stage"),
        "intent": payload.get("intent"),
        "channel": payload.get("channel"),
        "net": payload.get("net"),
        "holes": payload.get("holes"),
        "symptom": payload.get("symptom"),
    }
    circuit = payload.get("circuit")
    if isinstance(circuit, dict):
        ctx["circuit"] = {
            "hasTimer": circuit.get("hasTimer"),
            "allPlaced": circuit.get("allPlaced"),
            "allJumpersDrawn": circuit.get("allJumpersDrawn"),
            "jumperCount": circuit.get("jumperCount"),
        }
    readings = payload.get("readings")
    if isinstance(readings, list) and readings:
        # Last few live readings only
        slim = []
        for r in readings[-6:]:
            if not isinstance(r, dict):
                continue
            slim.append(
                {
                    k: r.get(k)
                    for k in ("net", "voltage", "ok", "source", "channel")
                    if k in r
                }
            )
        ctx["readings"] = slim
    if isinstance(payload.get("scope"), dict):
        scope = dict(payload["scope"])
        samples = scope.get("samples") or []
        if isinstance(samples, list) and samples:
            scope["sampleCount"] = len(samples)
            # 12 evenly spaced samples + stats is enough for rail/fault cues
            step = max(1, len(samples) // 12)
            scope["samples"] = [round(float(v), 3) for v in samples[::step][:12]]
        for heavy in ("note",):
            scope.pop(heavy, None)
        ctx["scope"] = scope
    # Drop empty keys
    return {k: v for k, v in ctx.items() if v is not None and v != {}}


def _model_queue() -> list[str]:
    """Active model first, then short fallbacks (no ListModels on happy path)."""
    return _dedupe_models(
        [ACTIVE_GEMINI_MODEL, GEMINI_MODEL],
        GEMINI_MODEL_FALLBACKS,
        _DEFAULT_GEMINI_CANDIDATES,
    )


def gemini_diagnose(payload: dict) -> tuple[str | None, str | None, str | None]:
    """Returns (message, model_used, error). Fast path: one model; discover only after 404s."""
    global ACTIVE_GEMINI_MODEL, LAST_GEMINI_ERROR
    t0 = time.monotonic()
    refresh_gemini_config()
    LAST_GEMINI_ERROR = None
    if not GEMINI_API_KEY:
        LAST_GEMINI_ERROR = "GEMINI_API_KEY not set"
        return None, None, LAST_GEMINI_ERROR
    expected_block = {k: {"nom": v["nom"], "tol": v["tol"]} for k, v in EXPECTED.items() if k != "GND"}
    ctx = _slim_diagnose_context(payload)
    dump = json.dumps({"expected": expected_block, "session": ctx}, separators=(",", ":"))
    stage = ctx.get("stage")
    if stage == "process_fault":
        prompt = (
            "Electronics lab coach for 555 TIMER_DEMO (breadboard, not SPICE). "
            "Student captured a LIVE Arduino scope sweep. Reply in under 80 words: "
            "(1) signal type (rail/open/stuck/oscillating/noise), "
            "(2) likely fault one sentence, "
            "(3) 2-3 concrete next probe/repair steps. No markdown.\n"
            f"{dump}"
        )
        max_tokens = 220
    else:
        prompt = (
            "Electronics lab coach for 555 TIMER_DEMO. "
            "Interpret LIVE Arduino volts vs expected rails. "
            "Give ONE next action in 1-2 short sentences. No markdown.\n"
            f"{dump}"
        )
        max_tokens = 120

    models = _model_queue()[:_GEMINI_MAX_ATTEMPTS]
    errors: list[str] = []
    saw_not_found = False

    def try_models(candidates: list[str]) -> tuple[str | None, str | None]:
        nonlocal saw_not_found
        for model in candidates:
            try:
                text = _gemini_generate(prompt, model, max_tokens=max_tokens)
                if text:
                    return text, model
                errors.append(f"{model}: empty response")
            except urllib.error.HTTPError as exc:
                msg = f"{model}: {_format_http_error(exc)}"
                errors.append(msg)
                print(f"[gemini] {msg}")
                if exc.code == 404:
                    saw_not_found = True
                # Auth / quota — don't burn more attempts
                if exc.code in (401, 403, 429):
                    break
                continue
            except (urllib.error.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError) as exc:
                msg = f"{model}: {exc}"
                errors.append(msg)
                print(f"[gemini] {msg}")
                continue
        return None, None

    text, model = try_models(models)
    # Only pay for ListModels after configured ids 404 — never on the happy path.
    if text is None and saw_not_found:
        discovered = [m for m in list_gemini_flash_models() if m not in models][:2]
        if discovered:
            print(f"[gemini] discovering fallbacks: {discovered}")
            text, model = try_models(discovered)

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    if text and model:
        ACTIVE_GEMINI_MODEL = model
        LAST_GEMINI_ERROR = None
        print(f"[gemini] ok model={model} {elapsed_ms}ms")
        return text, model, None

    LAST_GEMINI_ERROR = " | ".join(errors[-3:]) if errors else "all Gemini models failed"
    print(f"[gemini] all models failed ({elapsed_ms}ms); {LAST_GEMINI_ERROR}")
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
            # Assembly tips stay local — Gemini only for signal/fault analysis.
            needs_gemini = (
                stage in ("process_fault", "investigate", "repair", "verify")
                or data.get("intent") == "analyze_signal"
            )
            if not needs_gemini:
                self._json(200, {"message": local_guide(data), "source": "local"})
                return
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
