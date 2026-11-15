#!/usr/bin/env python3
"""Arduino UNO Q (or classic Uno) voltage bridge over USB serial.

Protocol (newline-terminated ASCII):
  Host  ->  MEAS <channel>     e.g. MEAS A0
  Board ->  VOLTS <channel> <float>
  Host  ->  PING
  Board ->  PONG

Net → default ADC map (override with ARDUINO_NET_MAP JSON env):
  VCC→A0  GND/0→A1  OUT→A2  CTRL→A3  TIMING→A4  DISCHARGE→A5

Env:
  ARDUINO_PORT   serial device (e.g. /dev/ttyACM0, COM3). Empty = disabled.
  ARDUINO_BAUD   default 115200
  ARDUINO_TIMEOUT_S  default 1.5
"""

from __future__ import annotations

import json
import os
import threading
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


class ArduinoBridge:
    def __init__(self) -> None:
        self._ser = None
        self._lock = threading.Lock()
        self.last_error: str | None = None
        self.refresh_config()

    def refresh_config(self) -> None:
        self.port = os.environ.get("ARDUINO_PORT", "").strip()
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
            "netMap": self.net_map,
            "lastError": self.last_error,
        }

    def connect(self) -> bool:
        self.refresh_config()
        if not self.enabled:
            self.last_error = "ARDUINO_PORT not set"
            return False
        try:
            import serial  # type: ignore
        except ImportError:
            self.last_error = "pyserial not installed (pip install -r requirements.txt)"
            return False
        with self._lock:
            try:
                if self._ser and self._ser.is_open:
                    return True
                self._ser = serial.Serial(self.port, self.baud, timeout=self.timeout)
                # Wake / clear boot noise
                self._ser.reset_input_buffer()
                self._ser.write(b"PING\n")
                self._ser.flush()
                line = self._readline()
                if line and "PONG" in line.upper():
                    self.last_error = None
                    return True
                # Some boards need a moment after open; still usable
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
            for _ in range(4):
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
