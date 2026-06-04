#!/usr/bin/env python3
"""
cht_temp.py — MAX31855 cylinder head temperature reader
Left cylinder:  SPI bus 0, CE0 (Pi Pin 24, GPIO8)
Right cylinder: SPI bus 0, CE1 (Pi Pin 26, GPIO7) — uncomment when second board arrives

Hardware (per board):
  VIN → Pi Pin 17 (3.3V)   [left board; right board shares via daisy-chain]
  GND → Pi Pin 9  (GND)    [or any available GND pin]
  DO  → Pi Pin 21 (GPIO9,  SPI MISO) [shared between both boards]
  CS  → Pin 24 (CE0) for left, Pin 26 (CE1) for right
  CLK → Pi Pin 23 (GPIO11, SPI CLK) [shared between both boards]

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
    tc_raw = (val >> 18) & 0x3FFF
    if tc_raw & 0x2000:
        tc_raw -= 0x4000
    return round(tc_raw * 0.25, 2)

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
                left  = read_max31855(0, 0)
                # right = read_max31855(0, 1)  # uncomment when second board arrives
                right = None

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
