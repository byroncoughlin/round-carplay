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

# Burst rejection: the two boards share the SPI MISO/CLK lines, so a dead or
# absent board can intermittently corrupt the *other* board's reads — bursts of
# wrong (typically low/negative) values that still pass the range check (e.g.
# -20 C at room temp) and lasted up to ~4 readings (~8s) in testing. A sliding
# median lets the stable true value outvote the burst (a step/slew filter can't:
# the garbage ramps in <step jumps and reads as a consistent fake level). The
# window must hold a majority of good samples through the longest burst, so
# MEDIAN_WINDOW=9 (~18s) tolerates up to 4 consecutive bad reads. Trade-off: a
# genuine temperature change lags ~half the window (~8s) — fine for a slow,
# high-thermal-mass cylinder head. The real fix is the dead board on the bus.
MEDIAN_WINDOW = 9

sio = socketio.Client(reconnection=True, reconnection_attempts=0)

def _read_raw(bus, device):
    spi = spidev.SpiDev()
    spi.open(bus, device)
    spi.max_speed_hz = 250000
    spi.mode = 0
    raw = spi.readbytes(4)
    spi.close()
    val = (raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]

    # No board present: a disconnected / unpowered MAX31855 leaves the SPI
    # MISO line floating, which reads as all-zeros or all-ones. Neither is a
    # real frame, so report '--' rather than a bogus 0 C.
    if val == 0x00000000 or val == 0xFFFFFFFF:
        return None

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


def read_max31855(bus, device):
    """Median of 3 quick reads — drops the odd single-frame SPI glitch before
    it even reaches the spike filter. Returns None only if every read faulted."""
    samples = []
    for _ in range(3):
        v = _read_raw(bus, device)
        if v is not None:
            samples.append(v)
        time.sleep(0.004)
    if not samples:
        return None
    samples.sort()
    return samples[len(samples) // 2]


class MedianFilter:
    """Sliding-median filter over the last N readings — robust to bursts of bad
    SPI frames (impulse noise): as long as a majority of the window is the real,
    stable value it outvotes the garbage. None (genuine fault / no board) is
    passed straight through as a gap and does not enter the window."""

    def __init__(self, window=MEDIAN_WINDOW):
        self.window = window
        self.buf    = []

    def update(self, raw):
        if raw is None:                 # genuine fault / no board → gap, untouched window
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
                left  = left_filter.update(read_max31855(0, 0))   # CE0
                right = right_filter.update(read_max31855(0, 1))  # CE1

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
