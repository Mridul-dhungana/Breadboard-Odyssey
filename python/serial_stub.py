#!/usr/bin/env python3
"""Serial stub for future Arduino UNO Q measurement bridge.

Not required for the demo. The HTTP mock in server.py already returns voltages.
Replace read_voltage() with real pyserial I/O when hardware is attached.
"""

from __future__ import annotations


class MeasurementStub:
    """Pretend ADC readings over a virtual serial link."""

    def __init__(self, port: str = "MOCK", baud: int = 115200):
        self.port = port
        self.baud = baud
        self.connected = False

    def connect(self) -> None:
        self.connected = True

    def close(self) -> None:
        self.connected = False

    def read_voltage(self, channel: str = "A0") -> float:
        if not self.connected:
            raise RuntimeError("Stub not connected")
        # Placeholder: map channel → volts when firmware speaks a protocol.
        table = {"A0": 5.0, "A1": 0.0, "A2": 2.5, "A3": 3.33}
        return table.get(channel.upper(), 0.0)


if __name__ == "__main__":
    stub = MeasurementStub()
    stub.connect()
    for ch in ("A0", "A1", "A2", "A3"):
        print(f"{ch}: {stub.read_voltage(ch):.2f} V")
    stub.close()
