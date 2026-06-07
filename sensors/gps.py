#!/usr/bin/env python3
"""
gps.py — Adafruit Ultimate GPS (USB) reader

Reads NMEA over the USB serial port and emits speed / heading / altitude to
the CarPlay app via Socket.IO.

Hardware: Adafruit Ultimate GPS GNSS with USB (99-channel, 10 Hz capable).
  * Plug into ANY Pi USB port — no GPIO wiring.
  * Enumerates as a USB-serial device, usually /dev/ttyUSB0 (check after
    plugging in:  ls /dev/ttyUSB* /dev/ttyACM*   and   dmesg | grep tty).
  * For a stable name add a udev rule (see PI_SETUP.md) → /dev/gps.
  * Antenna needs a clear view of the sky; first fix outdoors can take a
    minute or two (cold start).

Emits the 'gps' event in the units store.ts expects:
    { speed: km/h, heading: degrees, altitude: meters }
  - RMC sentence → ground speed (knots × 1.852 → km/h) + true course (heading)
  - GGA sentence → altitude (meters) + fix quality / satellite count

Also sets the system clock from GPS UTC on the first valid fix if it's grossly
wrong — a no-WiFi safety net for travel (see maybe_set_clock). Needs passwordless
sudo for `date`/`hwclock` (already granted on the Pi).

Systemd service: ~/.config/systemd/user/gps.service

Rate note: the module powers up at 1 Hz / 9600 baud, which is plenty for a
speedometer. To run faster you must BOTH raise the rate and limit the
sentence set so it fits the baud (10 Hz of full NMEA does not fit 9600).
Uncomment configure_10hz() below and bump BAUD if you want it.
"""

import time
import glob
import serial
import pynmea2
import socketio
import subprocess
import datetime

SERVER_URL = 'http://localhost:4000'
BAUD       = 9600   # module default; raise (e.g. 38400) only if going high-Hz

# Try a stable udev symlink first, then common USB-serial device names.
PORT_CANDIDATES = ['/dev/gps', '/dev/ttyUSB0', '/dev/ttyACM0']

# --- GPS clock set (no-network safety net) ----------------------------------
# Without WiFi the Pi boots with a stale clock (until the RTC battery is in and
# charged). GPS RMC sentences carry UTC date+time, so on a VALID fix we set the
# system clock ONCE if it's grossly wrong. Guardrails: valid fix only (status
# 'A'); only act when off by more than CLOCK_SKEW_TOLERANCE (so we never fight
# WiFi NTP when home); set at most once per process run (no repeated jumping).
CLOCK_SKEW_TOLERANCE = 120  # seconds — within this, leave the clock alone
_clock_synced = False       # True once set (or found already good) this run


def maybe_set_clock(gps_dt_utc):
    """gps_dt_utc: tz-aware UTC datetime from a VALID RMC. Sets the system clock
    once if it disagrees with GPS by more than the tolerance, then writes the
    new time into the hardware RTC (persists across power-off once a battery is
    fitted). No-op after the first call that resolves the clock."""
    global _clock_synced
    if _clock_synced:
        return
    now  = datetime.datetime.now(datetime.timezone.utc)
    skew = abs((now - gps_dt_utc).total_seconds())
    if skew <= CLOCK_SKEW_TOLERANCE:
        # already close — NTP or the RTC battery did its job; stop checking
        _clock_synced = True
        print(f'[gps] clock OK (skew {skew:.0f}s) — not setting', flush=True)
        return
    stamp = gps_dt_utc.strftime('%Y-%m-%d %H:%M:%S')
    try:
        # interpret the stamp as UTC; the system applies its timezone for display
        subprocess.run(['sudo', 'date', '-u', '-s', stamp],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        # push system time into the RTC (best effort — helps once a battery is in)
        subprocess.run(['sudo', 'hwclock', '-w'],
                       check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        _clock_synced = True
        print(f'[gps] clock was off by {skew:.0f}s — set to {stamp} UTC from GPS', flush=True)
    except Exception as e:
        print(f'[gps] failed to set clock from GPS: {e}', flush=True)

sio = socketio.Client(reconnection=True, reconnection_attempts=0)

@sio.event
def connect():
    print('[gps] Connected to CarPlay app', flush=True)

@sio.event
def disconnect():
    print('[gps] Disconnected — will reconnect', flush=True)


def find_port():
    for pat in PORT_CANDIDATES:
        hits = glob.glob(pat)
        if hits:
            return hits[0]
    hits = glob.glob('/dev/ttyUSB*') + glob.glob('/dev/ttyACM*')
    return hits[0] if hits else None


def _send_pmtk(ser, body):
    """Send a PMTK command with checksum (e.g. '$PMTK220,100')."""
    cs = 0
    for ch in body[1:]:           # XOR everything between '$' and '*'
        cs ^= ord(ch)
    ser.write(f'{body}*{cs:02X}\r\n'.encode())


def configure_10hz(ser):
    """OPTIONAL: limit output to RMC+GGA and set 10 Hz. Requires BAUD >= 38400.
    Left unused by default — the 1 Hz default is fine for a dash."""
    _send_pmtk(ser, '$PMTK314,0,1,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0')  # RMC + GGA only
    time.sleep(0.2)
    _send_pmtk(ser, '$PMTK220,100')                                     # 100 ms = 10 Hz
    time.sleep(0.2)


def main():
    # Latest known values; heading/altitude only update under the right
    # conditions (moving / has fix), so we hold the last good reading.
    last = {'speed': 0.0, 'heading': 0.0, 'altitude': 0.0}
    have_fix = False
    sats     = 0   # satellites in use (from GGA), for the "acquiring" UI

    while True:
        ser = None
        try:
            port = find_port()
            if not port:
                print('[gps] no GPS serial device found — retry in 5s', flush=True)
                time.sleep(5)
                continue

            ser = serial.Serial(port, BAUD, timeout=2)
            # configure_10hz(ser)   # <- enable for 10 Hz (also set BAUD=38400)
            sio.connect(SERVER_URL)
            print(f'[gps] reading NMEA from {port} @ {BAUD}', flush=True)

            while True:
                raw = ser.readline().decode('ascii', errors='replace').strip()
                if not raw.startswith('$'):
                    continue
                try:
                    msg = pynmea2.parse(raw)
                except pynmea2.ParseError:
                    continue

                if isinstance(msg, pynmea2.types.talker.RMC):
                    # status 'A' = valid fix, 'V' = void
                    if msg.status == 'A':
                        have_fix = True
                        # one-shot: correct a stale clock from GPS UTC (no-WiFi
                        # safety net). datestamp/timestamp are present on a valid
                        # RMC; combine into a UTC datetime and set once if wrong.
                        if msg.datestamp is not None and msg.timestamp is not None:
                            maybe_set_clock(datetime.datetime.combine(
                                msg.datestamp, msg.timestamp,
                                tzinfo=datetime.timezone.utc))
                        if msg.spd_over_grnd is not None:
                            last['speed'] = round(float(msg.spd_over_grnd) * 1.852, 1)
                        if msg.true_course is not None:   # only valid while moving
                            last['heading'] = round(float(msg.true_course))
                    else:
                        have_fix = False

                    # RMC arrives once per second — use it as the heartbeat for a
                    # lightweight status (fix yes/no + sat count) so the UI can show
                    # "acquiring" instead of just freezing on the last reading.
                    sio.emit('gps-status', {'fix': have_fix, 'sats': sats})

                    # Push the real data only once we actually have a fix.
                    if have_fix:
                        sio.emit('gps', {
                            'speed':    last['speed'],
                            'heading':  last['heading'],
                            'altitude': last['altitude'],
                        })

                elif isinstance(msg, pynmea2.types.talker.GGA):
                    # satellites in use — updates even before a full fix
                    try:
                        sats = int(msg.num_sats) if msg.num_sats else 0
                    except ValueError:
                        sats = 0
                    # gps_qual 0 = no fix
                    if msg.gps_qual and int(msg.gps_qual) > 0 and msg.altitude is not None:
                        last['altitude'] = round(float(msg.altitude), 1)

        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f'[gps] error: {e} — retry in 5s', flush=True)
            try:
                sio.disconnect()
            except Exception:
                pass
            try:
                if ser is not None:
                    ser.close()
            except Exception:
                pass
            time.sleep(5)


if __name__ == '__main__':
    main()
