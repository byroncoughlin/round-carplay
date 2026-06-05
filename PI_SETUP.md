# Raspberry Pi Setup (round-carplay)

Everything needed to reproduce the Pi from a fresh SD-card flash. These are the
**non-default** changes layered on top of a stock Raspberry Pi OS install.

- **Board:** Raspberry Pi 5
- **OS:** Raspberry Pi OS (Debian Trixie), 64-bit
- **Python:** 3.13 (system python3)
- **Display:** 800×800 round, 3.4", 235 DPI
- **mDNS host:** `motocarplay.local` (also reachable by IP, e.g. `192.168.4.112`)

---

## 1. `/boot/firmware/config.txt` — added lines

Only **three** lines are custom (the rest of config.txt is RPi OS default). Add
these under the `[all]` section:

```ini
dtparam=spi=on        # MAX31855 CHT thermocouple boards (SPI0: CE0=left, CE1=right)
dtoverlay=w1-gpio     # DS18B20 ambient temp probe (1-Wire on GPIO4 / Pin 7)
dtparam=uart0=on      # BNO055 IMU in UART mode (GPIO14/15 = Pins 8/10 -> /dev/ttyAMA0)
```

> **Why UART for the BNO055:** the BNO055 clock-stretches over I2C, which the Pi 5's
> RP1 ("designware") I2C controller cannot tolerate (it locks the bus — "SDA stuck at
> low"). Software i2c-gpio drops the first bit of every read. UART has no clock to
> stretch and is rock-solid. See `sensors/imu.py` header for full detail.

> **Do NOT** re-enable `dtparam=i2c_arm` or add an `i2c-gpio` overlay for the BNO055 —
> those were dead ends and are intentionally absent. (I2C is free for a future ambient
> sensor if ever wanted.)

`cmdline.txt` is unchanged — the serial **console** lives on the dedicated debug UART
(`ttyAMA10`), so it does **not** conflict with the BNO055 on `ttyAMA0`.

A reboot is required after editing config.txt.

---

## 2. Run user services without login (linger) + group access

The sensor + app services run as the `byron` user session. Enable linger so they
start at boot without an interactive login:

```bash
sudo loginctl enable-linger byron
```

The `byron` user must be in the device groups the sensors need (these grant
non-root access to `/dev/ttyAMA0`, `/dev/spidev*`, GPIO, and I2C):

```bash
sudo usermod -aG dialout,spi,i2c,gpio,plugdev byron   # re-login (or reboot) to apply
```

- `dialout` → `/dev/ttyAMA0` (BNO055 UART)
- `spi` → `/dev/spidev0.*` (MAX31855 CHT)
- `gpio` → 1-Wire / general GPIO
- `plugdev` → CarPlay USB dongle (see udev rule below)

---

## 3. Python dependencies

Installed for the system python3 (Trixie requires `--break-system-packages`):

```bash
pip install --user --break-system-packages \
  pyserial spidev python-socketio adafruit-blinka adafruit-circuitpython-bno055
```

Verified working versions:

| Package | Version |
|---|---|
| pyserial | 3.5 |
| spidev | 3.6 |
| python-socketio | 5.16.2 |
| adafruit-blinka | 9.1.0 |
| Adafruit-PureIO | 1.1.11 |
| adafruit-circuitpython-bno055 | 5.4.22 *(present, but `imu.py` uses a raw UART driver, not this lib)* |

> Note: `imu.py` deliberately does **not** use the `adafruit_bno055` `BNO055_UART`
> class — its init is unreliable on this chip (throws "UART write error", can leave the
> sensor stuck in a non-fusion mode after a reboot). `imu.py` ships its own ~50-line raw
> register driver instead. `adafruit-blinka` is only needed for the SPI/general stack.

---

## 4. Sensor scripts

Copy the repo's `sensors/*.py` to `/home/byron/sensors/`:

```bash
mkdir -p /home/byron/sensors
# from repo:  scp sensors/{imu,cht_temp,ambient_temp}.py byron@motocarplay.local:/home/byron/sensors/
```

Each script's header documents its exact wiring. Summary:

| Sensor | Script | Bus | Pins |
|---|---|---|---|
| BNO055 IMU (lean/pitch/G) | `imu.py` | UART `/dev/ttyAMA0` | VIN→1, GND→6, **PS1→3.3V**, SDA→10 (RXD), SCL→8 (TXD) |
| CHT left/right (MAX31855) | `cht_temp.py` | SPI0 | VIN→5V, GND, DO→21, CLK→23 (both shared via splitter), CS: left→24 (CE0), right→26 (CE1) |
| Ambient (DS18B20, waterproof) | `ambient_temp.py` | 1-Wire | Data→7 (GPIO4), VCC→3.3V (Pin 17), GND, **4.7kΩ pull-up Data↔VCC** |
| GPS (Adafruit Ultimate, USB) | `gps.py` | **USB** | Plug into any USB port — no GPIO wiring. Enumerates as `/dev/ttyUSB0`. *(pending hardware)* |

**Critical gotchas learned the hard way:**
- **BNO055 PS1 must be jumpered to 3.3V** or it boots in I2C mode and is silent on UART.
- **Never hot-unplug the BNO055's power** while the Pi is running — it wedges into a
  half-powered state that only a full **Pi power-cycle** (not a reboot) clears. Power the
  Pi down before touching sensor wiring.
- **DS18B20 jitter:** the w1-gpio driver only causes UI jitter when *searching an empty
  bus* (~12% CPU). With the probe connected and found, CPU drops to ~0.2% and there's no
  measurable jitter. So a flaky/intermittent probe connection is worse than none.

---

## 5. systemd user services

Create these in `~/.config/systemd/user/` (all three follow the same pattern):

```ini
# ~/.config/systemd/user/imu.service   (and cht-temp.service, ambient-temp.service)
[Unit]
Description=BNO055 IMU Sensor (lean angle, pitch, G-force)
After=network.target graphical-session.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /home/byron/sensors/imu.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

- `cht-temp.service` → `ExecStart=… /home/byron/sensors/cht_temp.py`
- `ambient-temp.service` → `ExecStart=… /home/byron/sensors/ambient_temp.py`

Enable + start all three:

```bash
systemctl --user daemon-reload
systemctl --user enable --now imu.service cht-temp.service ambient-temp.service
```

---

## 6. CarPlay app autostart

The Electron AppImage is deployed to `/home/byron/round-carplay/round-carplay.AppImage`
and launched by a desktop autostart entry:

```ini
# ~/.config/autostart/round-carplay.desktop
[Desktop Entry]
Type=Application
Name=round-carplay
Exec=/home/byron/round-carplay/round-carplay.AppImage
Icon=round-carplay
X-GNOME-Autostart-enabled=true
Categories=AudioVideo;
```

Build + deploy (from the repo on a dev machine):

```bash
npm run build:armLinux   # -> dist/round-carplay-0.1.0-arm64.AppImage
rsync -az dist/round-carplay-0.1.0-arm64.AppImage \
  byron@motocarplay.local:/home/byron/round-carplay/round-carplay.AppImage
```

> AppImages re-exec from a FUSE mount, so to restart the running app use
> `pkill round-carplay` (by process name), **not** `pkill -f round-carplay.AppImage`
> (that only matches the launcher).

---

## 7. Sensor data flow

All sensor scripts emit to the app's Socket.IO server on `localhost:4000`:

| Event | Payload | Source |
|---|---|---|
| `lean` | number (deg, +right) | imu.py |
| `pitch` | number (deg, +nose-up) | imu.py |
| `gforce` | `{x, y}` (G) | imu.py |
| `cht` | `{left, right}` (°C, `null` = no board) | cht_temp.py |
| `ambient` | number (°C) | ambient_temp.py |
| `gps` | `{speed (km/h), heading (deg), altitude (m)}` | gps.py |

The renderer subscribes to these in `src/renderer/src/store/store.ts`.

---

## 8. Misc system settings

**CarPlay dongle USB access** — `/etc/udev/rules.d/52-carplay.rules` lets the app
talk to the CarPlay adapter without root:

```udev
SUBSYSTEM=="usb", ATTR{idVendor}=="1314", ATTR{idProduct}=="152*", MODE="0660", GROUP="plugdev"
```

After creating it: `sudo udevadm control --reload-rules && sudo udevadm trigger`.

**Host / locale:**
- hostname: `motoCarPlay` (→ `motocarplay.local` over mDNS)
- timezone: `America/New_York` (`sudo timedatectl set-timezone America/New_York`)

**App runtime config** — `~/.config/round-carplay/config.json` is written by the app's
own Settings screen (CarPlay resolution 565×565, `kiosk: true`, night mode, audio/mic,
key bindings, etc.). It's app-managed, not part of OS setup — but back it up if you want
to preserve tuned values across a reflash.

> The stock `99-rpi-keyboard.rules` udev file is shipped by Raspberry Pi OS — leave it;
> only `52-carplay.rules` is custom.

**Boot logo / desktop wallpaper** — so the boot→app gap shows the R75/6 emblem
instead of a blank/default desktop. Render the repo's wallpaper SVG to PNG and point
pcmanfm at it (Pi compositor is **labwc** + **pcmanfm**):

```bash
# from src/renderer/src/assets/airhead-wall.svg in the repo:
scp src/renderer/src/assets/airhead-wall.svg byron@motocarplay.local:/home/byron/round-carplay/
ssh byron@motocarplay.local "chromium --headless --no-sandbox --disable-gpu \
  --screenshot=/home/byron/round-carplay/airhead-wall.png --window-size=800,800 \
  file:///home/byron/round-carplay/airhead-wall.svg"
# point pcmanfm at it (config: ~/.config/pcmanfm/default/desktop-items-HDMI-A-1.conf)
#   wallpaper_mode=crop   wallpaper=/home/byron/round-carplay/airhead-wall.png   desktop_bg=#000000
```

The app's own instant boot splash lives in `src/renderer/index.html` (inline SVG, fades
out from `main.tsx` once the dashboard mounts) — no Pi-side setup needed.

---

## 9. GPS (pending hardware — Adafruit Ultimate GPS USB)

When the GPS module arrives:

1. **Plug it into any USB port.** Find the device:
   ```bash
   ls /dev/ttyUSB* /dev/ttyACM*    # usually /dev/ttyUSB0
   dmesg | grep -i tty             # confirm + note the USB vendor/product id
   lsusb                           # for the udev rule below
   ```
2. **Install the NMEA parser:**
   ```bash
   pip install --user --break-system-packages pynmea2
   ```
3. **Stable device name** — add `/etc/udev/rules.d/53-gps.rules` (fill in the
   `idVendor`/`idProduct` from `lsusb`) so it's always `/dev/gps`:
   ```udev
   SUBSYSTEM=="tty", ATTRS{idVendor}=="XXXX", ATTRS{idProduct}=="XXXX", SYMLINK+="gps", MODE="0660", GROUP="dialout"
   ```
   then `sudo udevadm control --reload-rules && sudo udevadm trigger`.
4. **Deploy `gps.py`** to `/home/byron/sensors/` and add `gps.service`
   (same systemd pattern; `ExecStart=… /home/byron/sensors/gps.py`), then
   `systemctl --user enable --now gps.service`.
5. **First fix** outdoors with sky view can take 1–2 min (cold start). The
   `gps` event then drives speed/heading (`SpeedDisplay`) and altitude
   (`LeanAngle`) — already wired in the UI.

> The module defaults to 1 Hz, which is fine for a dash. For higher rates,
> enable `configure_10hz()` in `gps.py` **and** raise `BAUD` to 38400 (10 Hz of
> NMEA does not fit 9600 baud).

