# Project Notes for Claude

## Deploying to Pi

**Correct rsync target:** `/home/byron/round-carplay/round-carplay.AppImage`

The autostart entry on the Pi runs:
```
/home/byron/round-carplay/round-carplay.AppImage
```

Always sync like this:
```bash
rsync -az --progress "dist/round-carplay-0.1.0-arm64.AppImage" byron@motocarplay.local:/home/byron/round-carplay/round-carplay.AppImage
ssh byron@motocarplay.local "sudo reboot"
```

NOT to `/home/byron/round-carplay-0.1.0-arm64.AppImage` (wrong path, autostart ignores it).

## Build

```bash
npm run build:armLinux   # produces dist/round-carplay-0.1.0-arm64.AppImage
```

### ⚠️ electron-builder rewrites the root `package.json` — always restore it after a build

During packaging, electron-builder rewrites `./package.json` in place, stripping
`scripts` + `devDependencies`. If a build is interrupted mid-write it leaves the
file **truncated / invalid JSON**. A subsequent build then reads that broken
package.json and produces an AppImage whose `app.asar` has an unparseable
`package.json` → Electron can't find `main`, falls back to `default_app.asar`,
and **exits 1 with no output → black screen / app never starts** (port 4000
never opens; sensors log `Connection refused`).

So after every build, before committing or rebuilding:

```bash
git checkout -- package.json   # restore scripts + devDependencies
python3 -c "import json; json.load(open('package.json'))"   # verify it parses
```

Never commit the stripped package.json. If the app shows a black screen on the
Pi, diagnose with: `strace -f -e openat ./round-carplay 2>&1 | grep default_app`
— a `default_app.asar` lookup confirms the broken-`package.json` cause.

## GitHub

Push to the fork remote (not origin):
```bash
git push fork main
```

`origin` = upstream OneMakerShow/round-carplay (no push access)
`fork` = byroncoughlin/round-carplay (our fork)

## Testing on the Pi (screenshots & sensors) — READ BEFORE TRIAL-AND-ERROR

Hard-won workflow. Following this avoids ~30 min of re-deriving it each session.

### Connecting
- Host is `byron@motocarplay.local`, passwordless sudo (`NOPASSWD: ALL`).
- Always use `ssh -o ConnectTimeout=6`. **Right after a reboot SSH is slow and
  the harness auto-backgrounds long SSH commands** — don't spam; read the task
  output file or wait for the completion notification.

### Sensor-only changes are the FAST path (no app rebuild, no reboot)
Sensor scripts live in `/home/byron/sensors/` (`gps.py`, `cht_temp.py`, …) and run
as **systemd --user services** (`gps.service`, `cht-temp.service`).
```bash
scp sensors/gps.py byron@motocarplay.local:/home/byron/sensors/gps.py
ssh byron@motocarplay.local "systemctl --user restart gps.service"
```
- **Verify data flow without the UI:** the running app relays sensor socket
  events to any client on port 4000. Connect a `python-socketio` client (it's
  installed) and listen for the event (`gps-sky`, `cht`, `gps`, …). Count events
  over N seconds to measure emit rate.
- **Service logs go to the app, not journald** (`journalctl --user -u gps.service`
  often shows "No entries"); use the socketio listener to observe behavior.
- **Reading raw NMEA** (the serial port is exclusive): `systemctl --user stop
  gps.service`, read `/dev/gps` (or `/dev/ttyUSB0` / `/dev/ttyACM0`) at 9600,
  then `systemctl --user start gps.service`.

### Screenshots over CDP — use the AUTOSTART-FLAG method, never kill the app
The app autostarts from `~/.config/autostart/round-carplay.desktop`. **The kiosk
graphical session is tied to the app**, so:
- ❌ **Do NOT `pkill` the app to relaunch with debug flags.** Killing it churns
  the Wayland session → **your SSH drops (exit 255)** AND the app **respawns**
  on its own. You'll fight it.
- ❌ Kill-then-relaunch also hits **port 4000 `TIME_WAIT`**: the new instance
  can't bind 4000 → the renderer shows a **"JavaScript error"** (server never
  started). If you ever see that, just restart again after ~30–60 s once the
  port clears.

✅ **Reliable method** — add the debug flag to autostart, reboot, screenshot,
revert, reboot. No killing, no session churn:
```bash
# 1. add flag (note: /tmp backups don't survive reboot — sed in place)
ssh … "sed -i 's#\(Exec=.*round-carplay.AppImage\)\$#\1 --remote-debugging-port=9222 --remote-allow-origins=*#' ~/.config/autostart/round-carplay.desktop && sudo reboot"
# 2. wait for SSH + ports (4000 AND 9222). Then capture (see below).
# 3. restore: sed the flag back off, reboot, verify clean.
ssh … "sed -i 's# --remote-debugging-port=9222 --remote-allow-origins=\*##' ~/.config/autostart/round-carplay.desktop && sudo reboot"
```
- **`/tmp` is tmpfs — wiped on every reboot.** Any helper script (`shot.py`,
  `peek.py`) must be recreated after each reboot.
- **CDP capture:** GET `http://localhost:9222/json` → page target's
  `webSocketDebuggerUrl`; `Page.enable`; `Page.captureScreenshot {format:png}`;
  base64-decode to `/tmp/shot.png`; `scp` back; Read it. `websocket-client` +
  `urllib` are on the Pi. PIL is on the Mac for crop/measure.
- **Opening a graph for the shot when the dash is idle:** the idle clock overlay
  covers the **top arc + center square (top ~565 px) but NOT the bottom arc**.
  Dispatch a click at **screen (180, 745)** (`Input.dispatchMouseEvent`
  mousePressed+mouseReleased) — that's the bottom-strip ALT zone → opens the
  **altitude** graph (a GPS key → `GpsSkyPanel`). Setting `activeGraph` hides the
  idle overlay so the graph (z1400) shows. Speed/heading taps are blocked while
  idle (behind the overlay).

### After any debug session, verify clean state
App running normally (no `--remote-debugging-port` in the process), `9222`
closed, `4000` listening, `gps.service` + `cht-temp.service` active.

## Display

- 800×800 round display, 3.4", 235 DPI
- CarPlay square: 565×565px (70.625% of 800)
- Arc strips: 117px (14.625% of 800)
- All sensor overlay content must stay within the circle boundary
