# Wiring & pin map

Every sensor on the bike and exactly where it lands on the Raspberry Pi 5. The
source of truth for each device is the header comment in its `sensors/*.py`
script; this file collects them into one place plus a physical pin map.

Three buses do the work: **UART** for the IMU, **SPI0** for the two cylinder-head
boards, **1-Wire** for the ambient probe. GPS is **USB**. Pi CPU temp is internal.
See [`PI_SETUP.md`](PI_SETUP.md) for the `config.txt` overlays and udev rules that
turn these buses on.

## Pi 5 40-pin header

Odd pins are the left column, even pins the right, pin 1 nearest the SD-card
corner. `●` = used, `·` = free.

```
        signal / device        pin   pin        signal / device
    ─────────────────────────────────────────────────────────────────────
    IMU VIN + PS1   3V3  ●──── [ 1] [ 2] ────●  5V    CHT-L VIN
                  GPIO2  ·     [ 3] [ 4] ────●  5V    CHT-R VIN
                  GPIO3  ·     [ 5] [ 6] ────●  GND   IMU GND
    AMBIENT DATA  GPIO4  ●──── [ 7] [ 8] ────●  GPIO14 TXD   IMU SCL
                    GND  ●──── [ 9] [10] ────●  GPIO15 RXD   IMU SDA
                 GPIO17  ·     [11] [12]      ·  GPIO18
                 GPIO27  ·     [13] [14] ────●  GND   AMBIENT GND
                 GPIO22  ·     [15] [16]      ·  GPIO23
    AMBIENT VCC     3V3  ●──── [17] [18]      ·  GPIO24
    CHT SDI   MOSI GPIO10 ●─── [19] [20]      ·  GND
    CHT SDO   MISO GPIO9  ●─── [21] [22]      ·  GPIO25
    CHT SCK   SCLK GPIO11 ●─── [23] [24] ────●  GPIO8  CE0   CHT-L CS
                    GND  ●──── [25] [26] ────●  GPIO7  CE1   CHT-R CS
                  GPIO0  ·     [27] [28]      ·  GPIO1
                  GPIO5  ·     [29] [30]      ·  GND
                  GPIO6  ·     [31] [32]      ·  GPIO12
                 GPIO13  ·     [33] [34]      ·  GND
                 GPIO19  ·     [35] [36]      ·  GPIO16
                 GPIO26  ·     [37] [38]      ·  GPIO20
                    GND  ·     [39] [40]      ·  GPIO21
```

### Pins in use

| Pin | Signal (GPIO/alt) | Goes to |
|--:|---|---|
| 1 | 3V3 | IMU `VIN` **and** `PS1` (mode select) |
| 2 | 5V | CHT **left** `VIN` |
| 4 | 5V | CHT **right** `VIN` |
| 6 | GND | IMU `GND` |
| 7 | GPIO4 (1-Wire) | Ambient `DATA` (+ 4.7 kΩ pull-up to pin 17) |
| 8 | GPIO14 (UART TXD) | IMU `SCL` (Pi TX → BNO055 RX) |
| 9 | GND | CHT **left** `GND` |
| 10 | GPIO15 (UART RXD) | IMU `SDA` (BNO055 TX → Pi RX) |
| 14 | GND | Ambient `GND` |
| 17 | 3V3 | Ambient `VCC` (+ pull-up resistor top) |
| 19 | GPIO10 (SPI0 MOSI) | CHT `SDI` (both boards, shared) |
| 21 | GPIO9 (SPI0 MISO) | CHT `SDO` (both boards, shared) |
| 23 | GPIO11 (SPI0 SCLK) | CHT `SCK` (both boards, shared) |
| 24 | GPIO8 (SPI0 CE0) | CHT **left** `CS` |
| 25 | GND | CHT **right** `GND` |
| 26 | GPIO7 (SPI0 CE1) | CHT **right** `CS` |

> **Power and ground are rails, not 1:1.** There are only two 3V3 pins (1, 17)
> and two 5V pins (2, 4), but several things tap each. Where the table shows two
> wires on one pin (e.g. IMU `VIN` + `PS1` on pin 1), splice them or run a short
> pigtail. The eight GND pins are all common, so any GND device can use any free
> GND pin; the assignments above just keep each one near its device.

## Per-device wiring

### BNO055 IMU — lean / pitch / G  ([`sensors/imu.py`](sensors/imu.py))
UART (raw protocol, **not** I2C). `PS1` tied high selects UART mode.

| BNO055 | Pi pin | Note |
|---|---|---|
| VIN | 1 (3V3) | |
| GND | 6 (GND) | |
| PS1 | 1 / any 3V3 | selects UART mode |
| SDA | 10 (GPIO15, RXD) | BNO055 TX → Pi RX |
| SCL | 8 (GPIO14, TXD) | BNO055 RX → Pi TX |

Why not I2C: the BNO055 clock-stretches and the Pi 5's RP1 I2C controller locks
up. UART has no clock to stretch. Enable with `dtparam=uart0=on` → `/dev/ttyAMA0`.

### MAX31856 cylinder-head temps ×2  ([`sensors/cht_temp.py`](sensors/cht_temp.py))
Two Adafruit Universal Thermocouple Amplifier boards on **SPI0**. `SCK`, `SDO`,
`SDI` are shared between both boards; only `CS` is separate. Thermocouple
polarity: **yellow → T+, red → T−** (ANSI K-type).

| Board | VIN | GND | SCK | SDO | SDI | CS |
|---|---|---|---|---|---|---|
| **Left** | 2 (5V) | 9 | 23 | 21 | 19 | 24 (CE0) |
| **Right** | 4 (5V) | 25 | 23 | 21 | 19 | 26 (CE1) |

`DRDY` / `FLT` left unconnected. Enable with `dtparam=spi=on` → `/dev/spidev0.0`
(left), `/dev/spidev0.1` (right).

### DS18B20 ambient temp  ([`sensors/ambient_temp.py`](sensors/ambient_temp.py))
1-Wire. A **4.7 kΩ pull-up between DATA (pin 7) and VCC (pin 17)** is required.

| DS18B20 | Pi pin |
|---|---|
| VCC | 17 (3V3) |
| GND | 14 (GND) |
| DATA | 7 (GPIO4) |

> The script header lists VCC/GND on pins 1/6 as a representative 3V3/GND; pins
> 17/14 are used here so it doesn't fight the IMU for pin 1/6. Either way it's the
> same rail. Enable with `dtoverlay=w1-gpio`.

### Adafruit Ultimate GPS — speed / heading / altitude  ([`sensors/gps.py`](sensors/gps.py))
**USB, no GPIO.** Plug into any USB port. Enumerates as `/dev/ttyUSB0` (udev rule
gives a stable `/dev/gps`). The external active antenna screws onto the SMA
pigtail. The same GPS feeds speed, heading, **and** altitude.

### Pi CPU temp  ([`sensors/pi_temp.py`](sensors/pi_temp.py))
No wiring. Reads `/sys/class/thermal/thermal_zone0/temp`.

## Off the 40-pin header

- **GPS:** any USB-A port.
- **RTC battery (Pi 5):** the dedicated 2-pin **J5** header next to the USB-C
  jack, **not** the GPIO header. Rechargeable ML2032. Trickle-charge with
  `dtparam=rtc_bbat_vchg=3000000`. See [`PI_SETUP.md`](PI_SETUP.md#rtc-battery-pi-5--primary-cold-boot-time-fix).
- **GPS backup cell (optional mod):** the GPS module's own CR1220 holder. To keep
  it topped up off the Pi's rechargeable RTC rail, run one wire from the Pi RTC
  battery + through a **BAT85** Schottky diode (band toward the GPS) into the GPS
  `VBAT` pad. Ground is already shared over USB. Remove the CR1220 first. See
  [`PI_SETUP.md`](PI_SETUP.md#gps-backup-battery-cr1220-faster-warm-fix).

## config.txt overlays (the buses above)

```ini
dtparam=spi=on        # MAX31856 CHT boards (SPI0)
dtoverlay=w1-gpio     # DS18B20 ambient probe (1-Wire on GPIO4)
dtparam=uart0=on      # BNO055 IMU (UART on GPIO14/15 → /dev/ttyAMA0)
dtparam=rtc_bbat_vchg=3000000   # trickle-charge the RTC battery (after it's fitted)
```
