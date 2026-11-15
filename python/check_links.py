#!/usr/bin/env python3
"""Verify Gemini + Arduino links before a demo. Safe to run; prints no secret values."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402  — loads .env
from arduino_bridge import bridge  # noqa: E402


def check_gemini() -> dict:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        return {"ok": False, "detail": "GEMINI_API_KEY not set (.env or export)"}

    models = list(getattr(server, "GEMINI_MODEL_FALLBACKS", [])) or [
        os.environ.get("GEMINI_MODEL", "gemini-flash-latest"),
        "gemini-flash-latest",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
    ]
    for discovered in getattr(server, "list_gemini_flash_models", lambda: [])():
        if discovered not in models:
            models.append(discovered)
    # de-dupe
    seen: set[str] = set()
    ordered = []
    for m in models:
        if m and m not in seen:
            seen.add(m)
            ordered.append(m)

    errors = []
    for model in ordered:
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}"
            f":generateContent?key={key}"
        )
        body = json.dumps(
            {
                "contents": [{"parts": [{"text": "Reply with exactly: ok"}]}],
                "generationConfig": {"temperature": 0, "maxOutputTokens": 8},
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            text = (
                data.get("candidates", [{}])[0]
                .get("content", {})
                .get("parts", [{}])[0]
                .get("text", "")
            )
            server.ACTIVE_GEMINI_MODEL = model
            return {"ok": True, "detail": f"model={model} reply={text.strip()[:40]!r}"}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:160]
            errors.append(f"{model}: HTTP {exc.code} {detail}")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{model}: {type(exc).__name__}: {exc}")

    return {
        "ok": False,
        "detail": "No working model. Tried: " + " | ".join(errors[:3]),
    }


def check_arduino() -> dict:
    if not bridge.enabled:
        return {"ok": False, "detail": "ARDUINO_PORT not set — live measure unavailable"}
    if not bridge.connect():
        return {"ok": False, "detail": bridge.last_error or "connect failed"}
    try:
        v = bridge.read_voltage("VCC")
        return {
            "ok": True,
            "detail": f"port={bridge.port} VCC≈{v:.3f} V (channel {bridge.channel_for_net('VCC')})",
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "detail": str(exc)}
    finally:
        bridge.close()


def main() -> int:
    print("Breadboard Odyssey link check")
    print(f"  root: {ROOT}")
    g = check_gemini()
    a = check_arduino()
    print(f"  Gemini:  {'OK' if g['ok'] else 'NO'} — {g['detail']}")
    print(f"  Arduino: {'OK' if a['ok'] else 'NO'} — {a['detail']}")
    if g["ok"] or a["ok"]:
        print("Ready for live demo on whichever link is OK.")
    else:
        print("Both links offline — scope/measure/analyze will error until Arduino + Gemini are linked.")
    return 0 if g["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
