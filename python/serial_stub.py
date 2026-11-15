#!/usr/bin/env python3
"""Backward-compatible entrypoint — use arduino_bridge.ArduinoBridge for live I/O. """

from arduino_bridge import ArduinoBridge, bridge

# Keep the old name for any external imports
MeasurementStub = ArduinoBridge

if __name__ == "__main__":
    print("status:", bridge.status())
    if not bridge.enabled:
        print("Set ARDUINO_PORT=/dev/ttyACM0 (or COM3) to talk to the board.")
