#!/usr/bin/env python3
"""
pi_temp.py — Raspberry Pi CPU temperature reader

Reads the SoC thermal zone and emits celsius to the CarPlay app via Socket.IO
as a 'pi-temp' event: {'cpu': <float C>}. No extra hardware — the Pi's on-die
sensor is always present.

Source: /sys/class/thermal/thermal_zone0/temp  (millidegrees C)
On a Pi 5 thermal_zone0 is the CPU (cpu-thermal) zone.

Systemd service: ~/.config/systemd/user/pi-temp.service
"""

import time
import socketio

ZONE       = '/sys/class/thermal/thermal_zone0/temp'
INTERVAL   = 2     # seconds between readings
SERVER_URL = 'http://localhost:4000'

sio = socketio.Client(reconnection=True, reconnection_attempts=0)

def read_cpu_temp():
    try:
        with open(ZONE) as f:
            milli = int(f.read().strip())
        c = milli / 1000.0
        # Sanity: the SoC sensor reads roughly 0..120 C in service.
        if -20.0 <= c <= 150.0:
            return round(c, 1)
    except Exception as e:
        print(f'[pi-temp] Read error: {e}')
    return None

@sio.event
def connect():
    print('[pi-temp] Connected to CarPlay app')

@sio.event
def disconnect():
    print('[pi-temp] Disconnected — will reconnect')

def main():
    while True:
        try:
            sio.connect(SERVER_URL)
            while True:
                c = read_cpu_temp()
                if c is not None:
                    sio.emit('pi-temp', {'cpu': c})
                    print(f'[pi-temp] {c}°C')
                time.sleep(INTERVAL)
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f'[pi-temp] Connection error: {e} — retrying in 5s')
            try:
                sio.disconnect()
            except Exception:
                pass
            time.sleep(5)

if __name__ == '__main__':
    main()
