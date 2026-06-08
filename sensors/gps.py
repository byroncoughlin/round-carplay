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

# --- Sky view (satellite troubleshooting) ----------------------------------
# The module streams GSV (satellites in view: per-sat PRN, elevation, azimuth,
# signal/SNR) and GSA (2D/3D fix type, used PRNs, HDOP/PDOP) at 1 Hz — we just
# weren't parsing them. SkyAssembler reassembles the multi-sentence GSV groups
# and folds in GSA + RMC lat/lon as they arrive, then produces a single combined
# snapshot via snapshot(). Pure/parse-only and self-contained so it can be
# unit-tested by feeding it parsed NMEA messages.
#
# Multi-GNSS (GPS + GLONASS, etc.): each constellation sends its OWN GSV group
# (GPGSV, GLGSV, …) and ≥1 GSA sentence per cycle. So GSV groups are accumulated
# per talker, and GSA "used PRN" sets are UNIONed across the cycle (the old code
# kept only the last GSA and undercounted used sats). The caller emits one
# snapshot per fix cycle, on RMC — the 1 Hz heartbeat that lands after the
# cycle's GSV/GSA — which gives a clean 1 Hz update instead of one-per-talker.
#
# NOTE: GSV/GSA only flow at the 1 Hz default. configure_10hz() (RMC+GGA only)
# would turn the sky view dark — an accepted trade-off documented there.
class SkyAssembler:
    def __init__(self):
        self.gsv = {}        # talker -> last COMPLETED {'expected','sats','inview'}
        self._part = {}      # talker -> in-progress group being reassembled
        self.used = set()    # PRNs used in the fix, unioned across GSA this cycle
        self.fix_type = 0    # best of 1/2/3 seen this cycle
        self.hdop = None
        self.pdop = None
        self.lat = None
        self.lon = None

    def feed(self, msg):
        """Consume one parsed pynmea2 message (accumulate only)."""
        st = getattr(msg, 'sentence_type', '')
        try:
            if st == 'GSA':
                self._gsa(msg)
            elif st == 'RMC':
                self._rmc(msg)
            elif st == 'GSV':
                self._gsv(msg)
        except (ValueError, IndexError, AttributeError):
            pass

    def _rmc(self, msg):
        if getattr(msg, 'status', None) == 'A':
            lat, lon = msg.latitude, msg.longitude
            if lat and lon:
                self.lat = round(float(lat), 6)
                self.lon = round(float(lon), 6)

    def _gsa(self, msg):
        d = msg.data  # ['A', fix_type, id1..id12, pdop, hdop, vdop]
        try:
            self.fix_type = max(self.fix_type, int(d[1]))   # best across constellations
        except (ValueError, IndexError):
            pass
        for v in d[2:14]:                                   # union used PRNs this cycle
            if v:
                try:
                    self.used.add(int(v))
                except ValueError:
                    pass
        p, h = self._f(d, 14), self._f(d, 15)
        if p is not None:
            self.pdop = p
        if h is not None:
            self.hdop = h

    @staticmethod
    def _f(d, i):
        try:
            return float(d[i]) if d[i] else None
        except (ValueError, IndexError):
            return None

    @staticmethod
    def _i(v):
        try:
            return int(v) if v not in (None, '') else None
        except ValueError:
            return None

    def _gsv(self, msg):
        d = msg.data  # [n_msgs, msg_num, n_in_view, (prn,el,az,snr)*]
        nmsg = int(d[0]); mnum = int(d[1]); ninview = int(d[2])
        talk = getattr(msg, 'talker', 'GP')
        if mnum == 1:
            self._part[talk] = {'expected': nmsg, 'sats': [], 'inview': ninview}
        acc = self._part.get(talk)
        if acc is None:
            return                      # missed the start of this group; wait for next
        acc['expected'] = nmsg
        acc['inview'] = ninview
        i = 3
        while i < len(d):
            grp = d[i:i + 4]
            prn = self._i(grp[0]) if len(grp) > 0 else None
            if prn is not None:
                acc['sats'].append({
                    'prn': prn,
                    'el':  self._i(grp[1]) if len(grp) > 1 else None,
                    'az':  self._i(grp[2]) if len(grp) > 2 else None,
                    'snr': self._i(grp[3]) if len(grp) > 3 else None,
                })
            i += 4
        if mnum >= acc['expected']:     # group complete → promote, ready for snapshot
            self.gsv[talk] = acc
            self._part.pop(talk, None)

    def snapshot(self):
        """Build one combined sky payload from all constellations' latest data,
        then reset the per-cycle GSA accumulators for the next cycle."""
        sats, inview = [], 0
        for acc in self.gsv.values():
            sats.extend(dict(s) for s in acc['sats'])
            inview += acc.get('inview', 0)
        for s in sats:
            s['used'] = s['prn'] in self.used
        payload = {
            'fixType':    self.fix_type if self.fix_type in (2, 3) else 0,
            'satsUsed':   len(self.used),
            'satsInView': inview or len(sats),
            'hdop':       self.hdop,
            'pdop':       self.pdop,
            'lat':        self.lat,
            'lon':        self.lon,
            'sats':       sats,
        }
        self.used = set()       # reset per-cycle accumulators (GSV groups persist
        self.fix_type = 0       # as last-completed until their next group arrives)
        return payload


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


def configure_sentences(ser):
    """Set the 1 Hz NMEA output set we use, with GSV (satellites-in-view) on
    EVERY fix instead of the module's every-5th-fix default. That makes the Sky
    View — sat plot, signal bars, AND the acquiring/TTFF counter — refresh at the
    full 1 Hz instead of jumping every 5 s.

    PMTK314 fields: GLL,RMC,VTG,GGA,GSA,GSV,GRS,GST,…  → we enable RMC (speed/
    heading/clock/position), GGA (altitude/sats/fix), GSA (fix type/DOP/used PRNs)
    and GSV (sats in view), all at 1 Hz; everything else off. This is ~5000 baud
    of NMEA, comfortably inside the 9600 baud link (~50%). The setting is volatile
    (lost on power-off unless the GPS backup battery holds it), so it's re-sent on
    every startup. NOTE: do not combine with configure_10hz() — 10 Hz can't fit
    GSV at 9600 baud, which is why that path drops back to RMC+GGA only."""
    _send_pmtk(ser, '$PMTK314,0,1,0,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0')
    time.sleep(0.2)


def configure_10hz(ser):
    """OPTIONAL: limit output to RMC+GGA and set 10 Hz. Requires BAUD >= 38400.
    Left unused by default — the 1 Hz default is fine for a dash. Mutually
    exclusive with configure_sentences() (this drops GSV → no Sky View)."""
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
    sky      = SkyAssembler()   # GSV/GSA → per-satellite 'gps-sky' for Sky View
    # Time-to-first-fix: seconds from process start until the first valid fix.
    # Uses the MONOTONIC clock on purpose — wall-clock time is unreliable here
    # because maybe_set_clock() can jump the system clock mid-acquisition. Counts
    # up live while searching; frozen the instant a 2D/3D fix appears.
    t_start  = time.monotonic()
    ttff     = None

    while True:
        ser = None
        try:
            port = find_port()
            if not port:
                print('[gps] no GPS serial device found — retry in 5s', flush=True)
                time.sleep(5)
                continue

            ser = serial.Serial(port, BAUD, timeout=2)
            try:
                configure_sentences(ser)   # GSV every fix → 1 Hz Sky View
            except Exception as e:
                print(f'[gps] sentence config failed (continuing): {e}', flush=True)
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

                # Satellite sky view: accumulate GSV/GSA/position as they arrive.
                # The combined snapshot is emitted once per cycle, on RMC (below).
                sky.feed(msg)

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

                    # One Sky-View snapshot per fix cycle (1 Hz): RMC lands after
                    # the cycle's GSV/GSA, so all constellations are fresh here.
                    # Stamp with TTFF (frozen on first fix) / acquiring (live).
                    sky_payload = sky.snapshot()
                    elapsed = time.monotonic() - t_start
                    fixed   = sky_payload['fixType'] in (2, 3)
                    if fixed and ttff is None:
                        ttff = round(elapsed, 1)        # freeze on first fix
                    sky_payload['ttff']      = ttff
                    sky_payload['acquiring'] = None if fixed else round(elapsed, 1)
                    sio.emit('gps-sky', sky_payload)

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
