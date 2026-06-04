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
"""

import time
import board
import busio
import adafruit_bno055
import socketio

INTERVAL   = 0.1   # 10Hz update rate
SERVER_URL = 'http://localhost:4000'

sio = socketio.Client(reconnection=True, reconnection_attempts=0)

@sio.event
def connect():
    print('[imu] Connected to CarPlay app')

@sio.event
def disconnect():
    print('[imu] Disconnected — will reconnect')

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

                # Guard against None at the tuple level
                if euler is None or accel is None:
                    time.sleep(INTERVAL)
                    continue

                lean  = euler[1]
                pitch = euler[2]

                # BNO055 can return a valid tuple but with None inside individual
                # slots during NDOF fusion transitions / calibration dropouts.
                # Skip the emit entirely rather than falling back to 0.0 — the UI
                # will hold the last good reading instead of flickering to zero.
                if lean is None or pitch is None:
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
