<p align="center">
  <img alt="License" src="https://img.shields.io/github/license/OneMakerShow/round-carplay">
</p>

# Round CarPlay — BMW R75/6 Fork

> **This is a fork of [OneMakerShow/round-carplay](https://github.com/OneMakerShow/round-carplay), customized for an R75/6.**
>
> All credit for the base CarPlay implementation goes to the original authors. This fork adds a sensor overlay UI and Pi-side hardware integration for standalone motorcycle use.

---

## What This Fork Adds

The original project displays CarPlay on a round screen with OBD data in the surrounding arcs. Since the BMW R75/6 has no OBD port, this fork replaces the OBD layer with data from discrete sensors wired directly to the Raspberry Pi.

### Instrument Overlay Layout

CarPlay runs in a centered 565×565px square (the largest square inscribed in an 800px circle). The four arc segments around it show:

| Position | Display |
|---|---|
| Top | GPS speed (mph), compass heading, ambient temperature |
| Bottom | Inclinometer — lean angle needle with tick marks, pitch angle, altitude, G-force bubble plot |
| Left | Cylinder head temperature — left jug (bar gauge, color-coded) |
| Right | Cylinder head temperature — right jug (bar gauge, color-coded) |

### Hardware

All sensors connect to the Raspberry Pi GPIO. No OBD adapter or CAN bus required.

| Sensor | Part | Interface | Notes |
|---|---|---|---|
| GPS (speed, heading, altitude) | Adafruit Ultimate GPS with USB | USB | 10Hz update rate, plug-and-play |
| External GPS antenna | Adafruit active antenna + uFL→SMA cable | — | Better sky view when mounted under fairing |
| Lean angle + G-force + pitch | Adafruit BNO055 9-DOF IMU | I2C (pins 3, 5) | Built-in sensor fusion, outputs absolute orientation |
| Ambient temperature | DS18B20 waterproof probe | 1-Wire (pin 7) | Stainless steel probe, includes pull-up resistor |
| Cylinder head temp ×2 | K-type thermocouple spark plug gaskets (14mm) | — | Clamp under spark plug, one per cylinder |
| CHT amplifiers ×2 | MAX31855 breakout boards | SPI | One per thermocouple |

### Spark Plug Size

The R75/6 uses **14mm** spark plugs — the thermocouple gasket adapters listed above are the correct fit.

---

# Round Carplay

Round Caraplay is an attempt to adapt the classic Apple CarPlay to a round screen using a Raspberry Pi. The idea is to display CarPlay in a central square area and then fill the surrounding space with information coming from the vehicle’s OBD bus.

Support for Linux (ARM/x86) and macOS (ARM) as well. It is a standalone Electron app, optimized for embedded setups and ultra-low-resolution OEM displays.  

> **Requirements:** A Carlinkit **CPC200-CCPA** (wireless & wired) or **CPC200-CCPW** (wired only) adapter.
## Installation (Raspberry Pi OS)

```bash
curl -LO https://raw.githubusercontent.com/OneMakerShow/round-carplay/main/setup-pi.sh
sudo chmod +x setup-pi.sh
./setup-pi.sh
```

The `setup-pi.sh` script performs the following tasks:

1. check for required tools: curl and xdg-user-dir
2. configures udev rules to ensure the proper access rights for the CarPlay dongle
3. downloads the latest AppImage
4. creates an autostart entry, so the application will launch automatically on boot
5. creates a desktop shortcut for easy access to the application

*Do not run this script on other Linux distributions.*

## Images
<p align="center">
  <strong><span style="font-size:20px;">Reference, Mini Cooper Navigator System</span></strong>
</p>

<p align="center">
  <img src="documentation/images/reference.jpg"
       alt="CarPlay"
       width="45%" />
</p>

<p align="center">
  <strong><span style="font-size:20px;">Real Device First Tests</span></strong>
</p>

<p align="center">
  <img src="documentation/images/01.jpg"
       alt="Settings"
       width="20%" />
  &emsp;&emsp;
  <img src="documentation/images/02.jpg"
       alt="Settings"
       width="20%" />
    &emsp;&emsp;
  <img src="documentation/images/03.jpg"
       alt="Settings"
       width="20%" />
    &emsp;&emsp;
  <img src="documentation/images/04.jpg"
       alt="Settings"
       width="20%" />
</p>


### System Requirements (build)

Make sure the following packages and tools are installed on your system before building:

- **Python 3.x** (for native module builds via `node-gyp`)
- **build-essential** (Linux: includes `gcc`, `g++`, `make`, etc.)
- **libusb-1.0-0-dev** (required for `node-usb`)
- **libudev-dev** (optional but recommended for USB detection on Linux)
- **fuse** (required to run AppImages)

---

### Clone & Build

```bash
git clone --branch main --single-branch https://github.com/OneMakerShow/round-carplay.git \
  && cd pi-carplay \
  && npm run install:clean \
  && npm run build \
  && npm run build:armLinux
```

---

### Linux (x86_64)

This AppImage has been tested on Debian Trixie (13). No additional software is required — just download the x86_64.AppImage and make it executable.

```bash
chmod +x round-carplay-*-x86_64.AppImage
```

---

### Mac (arm64)

This step is required for all non-Apple-signed apps.

```bash
xattr -cr /Applications/round-carplay.app
```

For microphone support, please install Sound eXchange (SoX) via brew.
```bash
brew install sox
```

---

## Settings Reference

Access settings via the tuning icon in the nav bar. Changes to video/stream settings require hitting **Save** which resets the dongle; most other changes apply immediately.

### Video & Stream

| Setting | Default | What it does |
|---|---|---|
| **WIDTH / HEIGHT** | 800 × 480 | Resolution sent to the phone — CarPlay renders its UI at this exact size and streams it back. Should match your display resolution. |
| **FPS** | 60 | Frames per second requested from the phone. 30 is fine for navigation, 60 is better for video. |
| **DPI** | 140 | Dots-per-inch hint sent to the phone. Affects how CarPlay scales its UI. Higher = smaller, denser elements. |
| **FORMAT** | 5 | Video codec format. 5 = H.264. Don't change this unless you know your adapter supports something else. |
| **IBOX VERSION** | 2 | Protocol version for the Carlinkit hardware. 2 works for CPC200-CCPA and CPC200-CCPW. |
| **MEDIA DELAY** | 500ms | Delay before audio starts. Helps sync audio with the video stream. If audio leads or lags video, adjust this. |
| **PHONE WORK MODE** | 2 | How the phone connects. 2 = wireless CarPlay. |

### Audio

| Setting | What it does |
|---|---|
| **AUDIO VOLUME** | Volume for CarPlay media (music, podcasts). 0–100% slider. |
| **NAV VOLUME** | Separate volume for turn-by-turn navigation voice. Lets you keep nav loud while music stays quieter. |
| **DISABLE AUDIO** | Transfers audio processing back to the phone instead of handling it on the Pi. Useful for troubleshooting audio issues. |
| **MICROPHONE: OS** | Uses a microphone connected to the Pi via the OS (USB mic, etc.) — the detected device name shows next to it. |
| **MICROPHONE: BOX** | Uses the microphone built into the Carlinkit dongle. |

### Connectivity

| Setting | What it does |
|---|---|
| **WIFI TYPE** | Which band the dongle broadcasts for wireless CarPlay. 5GHz has lower latency and less interference — use it unless your phone struggles to connect. |

### Display & UI

| Setting | What it does |
|---|---|
| **DARK MODE** | Tells CarPlay to use its night/dark theme. Applies immediately. |
| **KIOSK** | Hides the navigation tabs (settings, camera, etc.) for a pure CarPlay experience. Good once everything is dialled in. |

### Key Bindings

Physical button mappings. If you wire buttons to the Pi GPIO you can bind them to CarPlay controls: select, directional input, home, back, play/pause, next/previous track.

---

## Links

* **Repository & Issue Tracker:** [OneMakerShow/round-carplay](https://github.com/OneMakerShow/round-carplay)
* **Inspired by:** [pi-carplay](https://github.com/f-io/pi-carplay)

## Disclaimer

** _Apple and CarPlay are trademarks of Apple Inc. This project is not affiliated with or endorsed by Apple in any way. All trademarks are the property of their respective owners._


## License

This project is licensed under the MIT License.
