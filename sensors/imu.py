#!/usr/bin/env python3
"""
imu.py — BNO055 IMU reader (UART, raw protocol)
Reads lean angle, pitch, and G-force from the BNO055 and emits to
the CarPlay app via Socket.IO.

WHY UART + RAW PROTOCOL:
  * I2C is unusable on the Pi 5: the BNO055 clock-stretches, the hardware
    controller (RP1 "designware") locks up ("SDA stuck at low"), and software
    i2c-gpio drops the first bit of every read.  UART has no clock to stretch.
  * The adafruit_bno055 BNO055_UART *library* is itself unreliable on this
    chip — its init routine throws "UART write error" and can leave the chip
    stuck in a non-fusion mode after a reboot.  The BNO055's raw UART register
    protocol, by contrast, is rock-solid (verified 100% read/write success).
    So we talk to it directly and skip the library entirely.

Hardware (UART mode):
  VIN → Pi Pin 1  (3.3V)
  GND → Pi Pin 6  (GND)
  PS1 → 3.3V          (selects UART mode)
  SDA → Pi Pin 10 (GPIO15, RXD)   BNO055 TX → Pi RX
  SCL → Pi Pin 8  (GPIO14, TXD)   BNO055 RX → Pi TX

Pi config (/boot/firmware/config.txt):  dtparam=uart0=on  → /dev/ttyAMA0

BNO055 UART register protocol:
  READ : 0xAA 0x01 <reg> <len>     → 0xBB <len> <data..>   | 0xEE <errcode>
  WRITE: 0xAA 0x00 <reg> <len> <d> → 0xEE 0x01 (ok)        | 0xEE <errcode>
Each _read/_write retries with a buffer flush, so an occasional UART desync
costs one quick retry instead of stalling the display.

Registers (page 0):
  OPR_MODE 0x3D   (0x00 CONFIG, 0x0C NDOF fusion)
  EUL      0x1A   6 bytes: heading, roll, pitch  (int16 LE, 16 LSB/deg)
  LIA      0x28   6 bytes: x, y, z linear accel  (int16 LE, 100 LSB/(m/s^2))

euler roll → lean angle (positive = right); euler pitch → pitch (nose up +).

BNO055 quirk: when fusion isn't ready the Euler regs read 0xFFFF (-0.0625°)
in roll AND pitch at once; we skip those frames so the UI holds its last
good value instead of flickering to zero.
"""

import time
import struct
import serial
import socketio

INTERVAL   = 0.1            # ~10 Hz
SERVER_URL = 'http://localhost:4000'
UART_PORT  = '/dev/ttyAMA0'
UART_BAUD  = 115200

OPR_MODE    = 0x3D
MODE_CONFIG = 0x00
MODE_NDOF   = 0x0C
CHIP_ID_REG = 0x00
EUL_REG     = 0x1A
LIA_REG     = 0x28

BNO_SENTINEL = -0.0625      # 0xFFFF/16 — fusion "not ready"


class BNO055UART:
    """Minimal, robust raw-protocol driver for the BNO055 over UART."""

    def __init__(self, port, baud):
        self.u = serial.Serial(port, baudrate=baud, timeout=0.25)
        self.u.reset_input_buffer()
        self.u.reset_output_buffer()
        time.sleep(0.1)

    def _read(self, reg, length, tries=4):
        for _ in range(tries):
            self.u.reset_input_buffer()
            self.u.write(bytes([0xAA, 0x01, reg, length]))
            head = self.u.read(2)                       # 0xBB <len> on success
            if len(head) == 2 and head[0] == 0xBB and head[1] == length:
                data = self.u.read(length)
                if len(data) == length:
                    return data
            # else: 0xEE <err> or desync — flush + retry
        return None

    def _write(self, reg, data, tries=4):
        payload = bytes([0xAA, 0x00, reg, len(data)]) + bytes(data)
        for _ in range(tries):
            self.u.reset_input_buffer()
            self.u.write(payload)
            resp = self.u.read(2)                       # 0xEE 0x01 on success
            if len(resp) == 2 and resp[0] == 0xEE and resp[1] == 0x01:
                return True
        return False

    def begin(self):
        cid = self._read(CHIP_ID_REG, 1)
        if not cid or cid[0] != 0xA0:
            raise RuntimeError(f'BNO055 chip id wrong/absent: {cid}')
        # Always force a clean CONFIG → NDOF cycle so a reboot can never leave
        # the chip stuck in a non-fusion mode.
        self._write(OPR_MODE, [MODE_CONFIG]); time.sleep(0.03)
        self._write(OPR_MODE, [MODE_NDOF]);   time.sleep(0.05)

    def euler(self):
        d = self._read(EUL_REG, 6)
        if not d:
            return None
        h, r, p = struct.unpack('<hhh', d)
        return h / 16.0, r / 16.0, p / 16.0

    def lin_accel(self):
        d = self._read(LIA_REG, 6)
        if not d:
            return None
        x, y, z = struct.unpack('<hhh', d)
        return x / 100.0, y / 100.0, z / 100.0

    def close(self):
        try:
            self.u.close()
        except Exception:
            pass


sio = socketio.Client(reconnection=True, reconnection_attempts=0)

@sio.event
def connect():
    print('[imu] Connected to CarPlay app', flush=True)

@sio.event
def disconnect():
    print('[imu] Disconnected — will reconnect', flush=True)

def is_sentinel(v):
    return v is None or abs(v - BNO_SENTINEL) < 0.001

def main():
    bno = None
    while True:
        try:
            bno = BNO055UART(UART_PORT, UART_BAUD)
            bno.begin()
            print('[imu] BNO055 NDOF ready (raw UART)', flush=True)

            sio.connect(SERVER_URL)
            while True:
                e = bno.euler()
                a = bno.lin_accel()
                if e is None or a is None:
                    time.sleep(INTERVAL)
                    continue

                lean, pitch = e[1], e[2]
                if is_sentinel(lean) or is_sentinel(pitch):
                    time.sleep(INTERVAL)
                    continue

                gx = round(a[0] / 9.81, 3)   # lateral G
                gy = round(a[1] / 9.81, 3)   # longitudinal G

                sio.emit('lean',   round(lean,  2))
                sio.emit('pitch',  round(pitch, 2))
                sio.emit('gforce', {'x': gx, 'y': gy})

                time.sleep(INTERVAL)

        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f'[imu] Link error: {e} — re-initialising in 5s', flush=True)
            try:
                sio.disconnect()
            except Exception:
                pass
            if bno is not None:
                bno.close()
            time.sleep(5)

if __name__ == '__main__':
    main()
