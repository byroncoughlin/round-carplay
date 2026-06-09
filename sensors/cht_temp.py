#!/usr/bin/env python3
"""
cht_temp.py — MAX31856 cylinder head temperature reader
Left cylinder:  SPI bus 0, CE0 (Pi Pin 24, GPIO8)
Right cylinder: SPI bus 0, CE1 (Pi Pin 26, GPIO7)

Hardware (per board, Adafruit Universal Thermocouple Amplifier MAX31856):
  VIN → 5V  (Pin 2 left, Pin 4 right)  — board regulates to 3.3V
  GND → any GND (Pin 9 left, Pin 25 right)
  SCK → Pi Pin 23 (GPIO11, SPI CLK)   [shared between both boards]
  SDO → Pi Pin 21 (GPIO9,  SPI MISO)  [shared]
  SDI → Pi Pin 19 (GPIO10, SPI MOSI)  [shared]
  CS  → Pin 24 (CE0) for left, Pin 26 (CE1) for right  [separate]
  DRDY / FLT unconnected.

Thermocouple wiring: yellow → T+, red → T-  (ANSI K-type: yellow is positive).

Unlike the old MAX31855, the MAX31856 has writable config registers. They
reset to defaults on power loss, so every read cycle checks CR0 and rewrites
the config if needed (auto-convert mode, K-type, open-circuit detection).

SPI mode 1, 250kHz.

Pi setup: 'dtparam=spi=on' in /boot/firmware/config.txt.
Systemd service: ~/.config/systemd/user/cht-temp.service
"""

import time
import spidev
import socketio

INTERVAL   = 2      # seconds between readings
SERVER_URL = 'http://localhost:4000'

CR0_VALUE = 0x90    # CMODE=1 (auto conversion), OCFAULT=01 (open-circuit detect)
CR1_VALUE = 0x03    # K-type thermocouple

sio = socketio.Client(reconnection=True, reconnection_attempts=0)


def _open(device):
    spi = spidev.SpiDev()
    spi.open(0, device)
    spi.max_speed_hz = 250000
    spi.mode = 1
    return spi


def _ensure_config(spi):
    """Registers reset on power loss; rewrite config whenever CR0 is wrong.
    Returns False if the chip won't take config (absent / wiring fault)."""
    cr0 = spi.xfer2([0x00, 0])[1]
    if cr0 == CR0_VALUE:
        return True
    spi.xfer2([0x80, CR0_VALUE])
    spi.xfer2([0x81, CR1_VALUE])
    if spi.xfer2([0x00, 0, 0])[1:] != [CR0_VALUE, CR1_VALUE]:
        return False
    time.sleep(0.2)  # let the first auto conversion complete
    return True


def read_max31856(device):
    """Returns thermocouple °C, or None on fault / no board."""
    try:
        spi = _open(device)
        if not _ensure_config(spi):
            spi.close()
            return None
        regs = spi.xfer2([0x0A] + [0] * 6)[1:]  # CJTH CJTL LTCBH LTCBM LTCBL SR
        spi.close()
    except (IOError, OSError):
        return None

    # Floating bus = no board on this CS line.
    if all(r == 0xFF for r in regs) or all(r == 0x00 for r in regs):
        return None

    if regs[5]:  # any fault bit set (open circuit, range, voltage)
        return None

    cj_raw = (regs[0] << 8) | regs[1]
    if cj_raw & 0x8000:
        cj_raw -= 0x10000
    cj_c = cj_raw / 256.0
    if not (-40.0 <= cj_c <= 125.0):
        return None

    tc_raw = (regs[2] << 16) | (regs[3] << 8) | regs[4]
    if tc_raw & 0x800000:
        tc_raw -= 0x1000000
    tc_c = (tc_raw >> 5) * 0.0078125
    if not (-50.0 <= tc_c <= 1100.0):  # outside any real K-type CHT range
        return None
    return round(tc_c, 2)


class MedianFilter:
    """Sliding median over the last N readings — drops the odd glitched frame.
    None (fault / no board) passes through as a gap, window untouched."""

    def __init__(self, window=3):
        self.window = window
        self.buf    = []

    def update(self, raw):
        if raw is None:
            return None
        self.buf.append(raw)
        if len(self.buf) > self.window:
            self.buf.pop(0)
        ordered = sorted(self.buf)
        return ordered[len(ordered) // 2]


@sio.event
def connect():
    print('[cht] Connected to CarPlay app')


@sio.event
def disconnect():
    print('[cht] Disconnected — will reconnect')


def main():
    left_filter  = MedianFilter()
    right_filter = MedianFilter()
    while True:
        try:
            sio.connect(SERVER_URL)
            while True:
                left  = left_filter.update(read_max31856(0))   # CE0
                right = right_filter.update(read_max31856(1))  # CE1

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
