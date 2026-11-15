#!/usr/bin/env python3
"""Arduino UNO Q (or classic Uno) voltage bridge over USB serial.

Protocol (newline-terminated ASCII):
  Host  ->  MEAS <channel>     e.g. MEAS A0
  Board ->  VOLTS <channel> <float>
  Host  ->  SWEEP <channel> <count>   e.g. SWEEP A0 40
  Board ->  SWEEP <channel> <n> v1,v2,...
  Host  ->  PING
  Board ->  PONG

Net → default ADC map (override with ARDUINO_NET_MAP JSON env):
  VCC→A0  GND/0→A1  OUT→A2  CTRL→A3  TIMING→A4  DISCHARGE→A5

Env:
  ARDUINO_PORT   serial device (e.g. /dev/ttyACM0, COM3). Empty = auto-detect.
  ARDUINO_BAUD   default 115200
  ARDUINO_TIMEOUT_S  default 1.5
  ARDUINO_AUTODETECT  default 1 — scan serial ports when ARDUINO_PORT is empty
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any

DEFAULT_NET_MAP = {
    "VCC": "A0",
    "0": "A1",
    "GND": "A1",
    "OUT": "A2",
    "CTRL": "A3",
    "CONT": "A3",
    "TIMING": "A4",
    "DISCHARGE": "A5",
    "DISCH": "A5",
}


def _net_map() -> dict[str, str]:
    raw = os.environ.get("ARDUINO_NET_MAP", "").strip()
    if not raw:
        return dict(DEFAULT_NET_MAP)
    try:
        data = json.loads(raw)
        return {str(k).upper(): str(v).upper() for k, v in data.items()}
    except (json.JSONDecodeError, TypeError, ValueError):
        return dict(DEFAULT_NET_MAP)


def list_serial_ports() -> list[dict[str, str]]:
    try:
        from serial.tools import list_ports  # type: ignore
    except ImportError:
        return []
    out: list[dict[str, str]] = []
    for p in list_ports.comports():
        out.append(
            {
                "device": p.device,
                "description": p.description or "",
                "hwid": getattr(p, "hwid", "") or "",
                "manufacturer": getattr(p, "manufacturer", "") or "",
            }
        )
    return out


def score_port(port: dict[str, str]) -> int:
    device = (port.get("device") or "").lower()
    blob = " ".join(
        [
            port.get("description") or "",
            port.get("hwid") or "",
            port.get("manufacturer") or "",
            device,
        ]
    ).lower()
    score = 0
    if "arduino" in blob or "uno" in blob:
        score += 20
    if "2341" in blob:  # Arduino USB VID
        score += 15
    if "ttyacm" in device or "cu.usbmodem" in device:
        score += 10
    if "ttyusb" in device or "cu.usbserial" in device or "usbserial" in device:
        score += 6
    if device.startswith("com") and device[-1:].isdigit():
        score += 4
    if "bluetooth" in blob or "debug" in blob:
        score -= 10
    return score


def autodetect_port() -> str | None:
    ports = list_serial_ports()
    if not ports:
        return None
    ranked = sorted(((score_port(p), p["device"]) for p in ports), reverse=True)
    best_score, best_device = ranked[0]
    if best_score <= 0:
        return None
    return best_device


class ArduinoBridge:
    def __init__(self) -> None:
        self._ser = None
        self._lock = threading.Lock()
        self.last_error: str | None = None
        self.autodetected = False
        self.refresh_config()

    def refresh_config(self) -> None:
        configured = os.environ.get("ARDUINO_PORT", "").strip()
        autodetect = os.environ.get("ARDUINO_AUTODETECT", "1").strip() not in ("0", "false", "False")
        self.autodetected = False
        if configured:
            self.port = configured
        elif autodetect:
            found = autodetect_port()
            self.port = found or ""
            self.autodetected = bool(found)
        else:
            self.port = ""
        self.baud = int(os.environ.get("ARDUINO_BAUD", "115200"))
        self.timeout = float(os.environ.get("ARDUINO_TIMEOUT_S", "1.5"))
        self.net_map = _net_map()

    @property
    def enabled(self) -> bool:
        return bool(self.port)

    def status(self) -> dict[str, Any]:
        self.refresh_config()
        return {
            "enabled": self.enabled,
            "port": self.port or None,
            "baud": self.baud,
            "connected": self._ser is not None and getattr(self._ser, "is_open", False),
            "autodetected": self.autodetected,
            "ports": list_serial_ports(),
            "netMap": self.net_map,
            "lastError": self.last_error,
        }

    def connect(self) -> bool:
        self.refresh_config()
        if not self.enabled:
            self.last_error = "No Arduino serial port (set ARDUINO_PORT or plug in the board)"
            return False
        try:
            import serial  # type: ignore
        except ImportError:
            self.last_error = "pyserial not installed (pip install -r requirements.txt)"
            return False
        with self._lock:
            try:
                if self._ser and self._ser.is_open:
                    # Port may have changed via .env / autodetection
                    if getattr(self._ser, "port", None) == self.port:
                        return True
                    try:
                        self._ser.close()
                    except Exception:  # noqa: BLE001
                        pass
                    self._ser = None
                self._ser = serial.Serial(self.port, self.baud, timeout=self.timeout)
                # Boards often reboot on open — wait briefly, then clear boot noise
                time.sleep(0.35)
                self._ser.reset_input_buffer()
                self._ser.write(b"PING\n")
                self._ser.flush()
                line = self._readline()
                if line and "PONG" in line.upper():
                    self.last_error = None
                    return True
                # Some boards need a moment after open; still usable if port opened
                self.last_error = None
                return True
            except Exception as exc:  # noqa: BLE001 — surface to status/UI
                self.last_error = str(exc)
                self._ser = None
                return False

    def close(self) -> None:
        with self._lock:
            if self._ser is not None:
                try:
                    self._ser.close()
                except Exception:  # noqa: BLE001
                    pass
                self._ser = None

    def _readline(self) -> str:
        assert self._ser is not None
        raw = self._ser.readline()
        return raw.decode("utf-8", errors="replace").strip()

    def channel_for_net(self, net: str) -> str:
        return self.net_map.get(str(net).upper(), "A0")

    def read_voltage(self, net: str, channel: str | None = None) -> float:
        ch = (channel or self.channel_for_net(net)).upper()
        if not self.connect():
            raise RuntimeError(self.last_error or "Arduino not connected")
        with self._lock:
            assert self._ser is not None
            self._ser.reset_input_buffer()
            cmd = f"MEAS {ch}\n".encode("ascii")
            self._ser.write(cmd)
            self._ser.flush()
            # Accept a couple of lines in case of banners
            for _ in range(6):
                line = self._readline()
                if not line:
                    continue
                parts = line.replace(",", " ").split()
                upper = [p.upper() for p in parts]
                if "VOLTS" in upper:
                    idx = upper.index("VOLTS")
                    # VOLTS A0 4.98  OR  VOLTS 4.98
                    try:
                        if idx + 2 < len(parts):
                            return float(parts[idx + 2])
                        return float(parts[idx + 1])
                    except (ValueError, IndexError):
                        continue
                # Bare float fallback
                try:
                    return float(parts[-1])
                except ValueError:
                    continue
            raise RuntimeError(f"No VOLTS reply for {ch} (lastError={self.last_error})")

    def read_sweep(self, channel: str, count: int = 40, net: str | None = None) -> list[float]:
        """Batch ADC capture. Prefers firmware SWEEP; falls back to repeated MEAS."""
        ch = str(channel or (self.channel_for_net(net or "VCC"))).upper()
        n = max(8, min(int(count), 200))
        if not self.connect():
            raise RuntimeError(self.last_error or "Arduino not connected")
        with self._lock:
            assert self._ser is not None
            self._ser.reset_input_buffer()
            self._ser.write(f"SWEEP {ch} {n}\n".encode("ascii"))
            self._ser.flush()
            for _ in range(8):
                line = self._readline()
                if not line:
                    continue
                upper = line.upper()
                if upper.startswith("ERR"):
                    # Old firmware without SWEEP — fall through to MEAS loop
                    break
                if "SWEEP" in upper.split():
                    # SWEEP A0 40 1.2,1.3,...   or SWEEP A0 1.2 1.3 ...
                    try:
                        parts = line.replace(",", " ").split()
                        idx = 1
                        if idx < len(parts) and parts[idx].upper().startswith("A"):
                            idx += 1
                        if idx < len(parts) and parts[idx].isdigit() and "." not in parts[idx]:
                            idx += 1
                        volts = [float(p) for p in parts[idx:] if p]
                        if len(volts) >= max(4, n // 4):
                            return volts[:n]
                    except ValueError:
                        continue
            # Firmware without SWEEP: quick MEAS loop (still one lock)
            volts: list[float] = []
            for _ in range(n):
                self._ser.reset_input_buffer()
                self._ser.write(f"MEAS {ch}\n".encode("ascii"))
                self._ser.flush()
                got = None
                for _ in range(4):
                    line = self._readline()
                    if not line:
                        continue
                    parts = line.replace(",", " ").split()
                    upper = [p.upper() for p in parts]
                    if "VOLTS" in upper:
                        i = upper.index("VOLTS")
                        try:
                            got = float(parts[i + 2] if i + 2 < len(parts) else parts[i + 1])
                            break
                        except (ValueError, IndexError):
                            continue
                if got is None:
                    raise RuntimeError(f"No SWEEP/VOLTS reply for {ch}")
                volts.append(got)
            return volts


# Process-wide singleton used by the HTTP server
bridge = ArduinoBridge()


if __name__ == "__main__":
    print(json.dumps(bridge.status(), indent=2))
    if bridge.enabled:
        ok = bridge.connect()
        print("connect:", ok, bridge.last_error)
        if ok:
            for net in ("VCC", "0", "OUT", "CTRL"):
                try:
                    print(net, bridge.read_voltage(net))
                except Exception as exc:  # noqa: BLE001
                    print(net, "ERR", exc)
        bridge.close()
