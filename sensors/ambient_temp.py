#!/usr/bin/env python3
"""
ambient_temp.py — DS18B20 ambient temperature reader
Reads the 1-Wire DS18B20 probe and emits celsius to the CarPlay app via Socket.IO.

Hardware:
  VCC  → Pi Pin 1  (3.3V)
  GND  → Pi Pin 6  (GND)
  DATA → Pi Pin 7  (GPIO4, 1-Wire)

Pi setup: add 'dtoverlay=w1-gpio' to /boot/firmware/config.txt and reboot.

Systemd service: ~/.config/systemd/user/ambient-temp.service
"""

import time
import glob
import socketio

SENSOR_GLOB = '/sys/bus/w1/devices/28-*/w1_slave'
INTERVAL    = 10   # seconds between readings
SERVER_URL  = 'http://localhost:4000'

sio = socketio.Client(reconnection=True, reconnection_attempts=0)

def find_sensor():
    paths = glob.glob(SENSOR_GLOB)
    return paths[0] if paths else None

def read_temp(path):
    try:
        with open(path) as f:
            lines = f.readlines()
        if len(lines) >= 2 and 'YES' in lines[0]:
            t = int(lines[1].split('t=')[1].strip())
            return round(t / 1000.0, 2)
    except Exception as e:
        print(f'[ambient] Read error: {e}')
    return None

@sio.event
def connect():
    print('[ambient] Connected to CarPlay app')

@sio.event
def disconnect():
    print('[ambient] Disconnected — will reconnect')

def main():
    sensor = find_sensor()
    if not sensor:
        print('[ambient] No DS18B20 sensor found — is 1-Wire enabled?')
        return

    print(f'[ambient] Using sensor: {sensor}')

    while True:
        try:
            sio.connect(SERVER_URL)
            while True:
                temp = read_temp(sensor)
                if temp is not None:
                    sio.emit('ambient', temp)
                    print(f'[ambient] {temp}°C')
                time.sleep(INTERVAL)
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f'[ambient] Connection error: {e} — retrying in 5s')
            try:
                sio.disconnect()
            except Exception:
                pass
            time.sleep(5)

if __name__ == '__main__':
    main()
