#!/usr/bin/env python3
"""
cht_temp.py — MAX31855 cylinder head temperature reader
Left cylinder:  SPI bus 0, CE0 (Pi Pin 24, GPIO8)
Right cylinder: SPI bus 0, CE1 (Pi Pin 26, GPIO7)

Hardware (per board):
  VIN → 5V  (Pin 2 left, Pin 4 right)  — board regulates to 3.3V; DO stays
                                          3.3V logic, so the Pi is safe
  GND → any GND (Pin 9 left, Pin 25 right)
  DO  → Pi Pin 21 (GPIO9,  SPI MISO)  [shared between both boards via splitter]
  CLK → Pi Pin 23 (GPIO11, SPI CLK)   [shared between both boards via splitter]
  CS  → Pin 24 (CE0) for left, Pin 26 (CE1) for right  [separate]

Thermocouple wiring: red → red terminal, yellow → yellow terminal (ANSI K-type standard).
SPI mode 0, 250kHz.

Pi setup: uncomment 'dtparam=spi=on' in /boot/firmware/config.txt and reboot.

Systemd service: ~/.config/systemd/user/cht-temp.service
"""

import time
import spidev
import socketio

INTERVAL   = 2      # seconds between readings
SERVER_URL = 'http://localhost:4000'

sio = socketio.Client(reconnection=True, reconnection_attempts=0)

def read_max31855(bus, device):
    spi = spidev.SpiDev()
    spi.open(bus, device)
    spi.max_speed_hz = 250000
    spi.mode = 0
    raw = spi.readbytes(4)
    spi.close()
    val = (raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]
    if val & 0x7:
        return None  # fault (OC, SCG, or SCV)

    # Sanity check via the chip's internal cold-junction temperature.
    # A working MAX31855 always reports its own die temp (~ -40..150 C),
    # independent of the thermocouple.  A dead / unpowered / disconnected
    # board floats the SPI bus and returns impossible values (e.g. -128 C
    # with no fault bits set) — reject those so the gauge shows '--'
    # instead of a garbage reading.
    internal_raw = (val >> 4) & 0xFFF
    if internal_raw & 0x800:
        internal_raw -= 0x1000
    if not (-40.0 <= internal_raw * 0.0625 <= 150.0):
        return None

    tc_raw = (val >> 18) & 0x3FFF
    if tc_raw & 0x2000:
        tc_raw -= 0x4000
    tc_c = tc_raw * 0.25
    if not (-50.0 <= tc_c <= 1100.0):  # outside any real K-type CHT range
        return None
    return round(tc_c, 2)

@sio.event
def connect():
    print('[cht] Connected to CarPlay app')

@sio.event
def disconnect():
    print('[cht] Disconnected — will reconnect')

def main():
    while True:
        try:
            sio.connect(SERVER_URL)
            while True:
                left  = read_max31855(0, 0)   # CE0
                right = read_max31855(0, 1)   # CE1

                sio.emit('cht', {'left': left, 'right': right})
                print(f'[cht] L={left if left is not None else "--"}°C  R={"--" if right is None else right}°C')

                time.sleep(INTERVAL)
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f'[cht] Error: {e} — retrying in 5s')
            try:
                sio.disconnect()
            except Exception:
                pass
            time.sleep(5)

if __name__ == '__main__':
    main()
