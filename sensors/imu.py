#!/usr/bin/env python3
"""
imu.py — BNO055 IMU reader
Reads lean angle, pitch, and G-force from the BNO055 and emits to
the CarPlay app via Socket.IO.

Hardware (I2C):
  VIN → Pi Pin 1  (3.3V)
  GND → Pi Pin 20 (GND)
  SDA → Pi Pin 3  (GPIO2, I2C SDA)
  SCL → Pi Pin 5  (GPIO3, I2C SCL)

Euler angles (BNO055 NDOF mode):
  euler[0] = heading  (0-360°, compass)
  euler[1] = roll     → lean angle (positive = right)
  euler[2] = pitch    → pitch angle (positive = nose up)

Linear acceleration is gravity-compensated m/s², divided by 9.81 for G.

Systemd service: ~/.config/systemd/user/imu.service

I2C note: set dtparam=i2c_arm_baudrate=10000 in /boot/firmware/config.txt
to slow the clock for BNO055 clock-stretching compatibility.

BNO055 quirk: when the internal fusion hasn't produced a new result yet,
it returns 0xFFFF in the Euler angle registers, which the Adafruit library
decodes as -0.0625°.  Both roll AND pitch return this exact value at the
same time.  We detect and skip these frames so the UI holds its last
good reading rather than flickering to zero.
"""

import time
import board
import busio
import adafruit_bno055
import socketio

INTERVAL = 0.1    # 10 Hz update rate
SERVER_URL = 'http://localhost:4000'

# BNO055 "data not ready" sentinel value in the Adafruit library
# (0xFFFF as a signed 16-bit int * 1/16 deg/LSB = -0.0625°)
BNO_SENTINEL = -0.0625

sio = socketio.Client(reconnection=True, reconnection_attempts=0)

@sio.event
def connect():
    print('[imu] Connected to CarPlay app')

@sio.event
def disconnect():
    print('[imu] Disconnected — will reconnect')

def is_sentinel(v):
    """Return True if value matches the BNO055 not-ready sentinel."""
    return v is None or abs(v - BNO_SENTINEL) < 0.001

def main():
    i2c    = busio.I2C(board.SCL, board.SDA)
    sensor = adafruit_bno055.BNO055_I2C(i2c)

    print('[imu] BNO055 initialised')

    while True:
        try:
            sio.connect(SERVER_URL)
            while True:
                euler = sensor.euler
                accel = sensor.linear_acceleration

                if euler is None or accel is None:
                    time.sleep(INTERVAL)
                    continue

                lean  = euler[1]
                pitch = euler[2]

                # Skip frames where the BNO055 returns its not-ready sentinel.
                # On a Raspberry Pi the I2C timing causes this on ~40% of reads;
                # without skipping, the display flickers to zero each time.
                if is_sentinel(lean) or is_sentinel(pitch):
                    time.sleep(INTERVAL)
                    continue

                gx = round((accel[0] or 0.0) / 9.81, 3)  # lateral G
                gy = round((accel[1] or 0.0) / 9.81, 3)  # longitudinal G

                sio.emit('lean',   round(float(lean),  2))
                sio.emit('pitch',  round(float(pitch), 2))
                sio.emit('gforce', {'x': gx, 'y': gy})

                time.sleep(INTERVAL)

        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f'[imu] Error: {e} — retrying in 5s')
            try:
                sio.disconnect()
            except Exception:
                pass
            time.sleep(5)

if __name__ == '__main__':
    main()
