# Handoff — Session 3 (2026-06-11)

CarPlay-window lag investigation, continued. This session **made the lag worse,
then reverted to baseline.** Read this before touching the render path again.

---

## TL;DR / Current state of the Pi

- The Pi (`byron@motocarplay.local`) is running an AppImage built **this session**
  that is **functionally your original known-good UI** plus two non-UI changes:
  1. `electron-builder.yml`: `npmRebuild: true` → **`false`** (launch fix, see below).
  2. `src/main/usb/USBService.ts`: calls `carplay.stop()` on dongle detach (you
     requested this).
- The two CSS "lag optimizations" I tried **caused a ~10s touch delay and broke
  the backdrop**, and have been **fully reverted** (verified `git diff` of
  `Carplay.tsx`, `BackdropGlow.tsx`, `App.tsx` against HEAD is empty).
- CPU governor is pinned to `performance` via a persistent systemd service
  (`cpu-performance.service`) from Session 2. **Per the user, this made no
  noticeable difference** — do not assume it's the fix.
- No CDP debug flag active; ports: 4000 listening, 9222 closed. App verified
  launching cleanly (renderer process up + port 4000 bound) after the final
  deploy.

**Open question for the user (unanswered at handoff):** is the unit now back to
its original feel (backdrop visible, touch responsive)? Awaiting confirmation.

---

## What I tried this session

### 1. `carplay.stop()` on USB detach — KEPT (user-requested)
`src/main/usb/USBService.ts`, in the `usb.on('detach')` handler, now calls
`this.carplay.stop()` after `markDongleConnected(false)`. Rationale: the read
loop's awaited `transferIn` calls otherwise keep failing until
`MAX_ERROR_COUNT` (5) before closing, leaving a dead handle spinning; stopping
immediately makes the next attach a clean restart. **Not yet feel-verified** —
the dongle didn't drop cleanly during the (aborted) testing.

### 2. Rounded-corner clip "optimization" — TRIED, REGRESSED, REVERTED
**Hypothesis:** the video square's rounded corners came from an
`overflow:hidden` parent (`#videoContainer` in `Carplay.tsx` had
`borderRadius:36; overflow:hidden`, nested inside `App.tsx`'s center-square div
which also has `borderRadius:36; overflow:hidden`). A clipping parent forces the
V3D compositor to re-rasterize the video into an intermediate render target.
A CDP probe (`cdp_compositor_probe.py`) suggested removing that clip got the
main-page rAF cadence near-perfect 60fps.

**Change:** moved `borderRadius` onto the `<canvas id="video">` itself
(`borderRadius:34`) + added `willChange:'transform'` to promote it to its own
GPU layer, and removed the parent `overflow:hidden`.

**Result (user feel-test): MUCH WORSE.** ~10 seconds of touch-drag delay.
Rounding a large, constantly-updated `<canvas>` + `willChange` layer promotion
on the V3D evidently forces a hugely expensive per-frame rounded-clip raster —
the opposite of the intent.

**Status: fully reverted.**

### 3. Backdrop "optimization" — TRIED, REGRESSED, REVERTED
**Hypothesis:** `BackdropGlow.tsx` ran `filter: blur(6px) saturate(1.5)
brightness(0.92)` on a full-display layer scaled to 1.32; the CSS `blur()` on
the big upscaled layer is expensive on V3D (GL filter path blocklisted →
software) and forces recompositing with the video stack every vsync. The user
**confirmed earlier that disabling the backdrop helped a lot** (but lag wasn't
fully gone).

**Change:** removed the CSS `blur(6px)` (baked all blur into the tiny 192px
canvas via `SRC_BLUR` 9→12), added `contain:'paint'` + `translateZ(0)` to
isolate the layer so it only repaints at ~5fps.

**Result (user feel-test): BROKE the backdrop** — it was not visible at all, and
when toggled it took ~20s to appear. `contain:'paint'` on a `scale(1.32)`
element likely clipped it to its (pre-scale) box → nothing visible; combined
with the touch-delay regression from #2 the whole screen was unusable.

**Status: fully reverted.**

### 4. Build/launch failure — DIAGNOSED + FIXED (the `npmRebuild` fix)
First build of the night **black-screened the Pi** (icon wouldn't launch).
Captured error by running the AppImage manually over SSH:

```
Error: .../node_modules/usb/build/Release/usb_bindings.node: invalid ELF header
```

**Root cause:** building from macOS with `npmRebuild: true` made
`@electron/rebuild` recompile the native `usb` module **for macOS (Mach-O)** and
electron-builder packaged that Mac binary into the Linux AppImage →
`require('usb')` throws on the Pi → main process dies → no renderer, no port
4000, black screen.

**Why it surfaced now:** `usb` ships correct per-platform prebuilts
(`node_modules/usb/prebuilds/linux-arm64/node.napi.armv8.node`, a valid ELF
aarch64). `node-gyp-build` prefers `build/Release/*.node` over `prebuilds/*`, so
the freshly-built Mac binary won. (Strong implication: **earlier working builds
were NOT produced from this Mac with `npmRebuild:true`** — that combo always
crashes on the Pi.)

**Fix (2 parts):**
1. `electron-builder.yml`: `npmRebuild: false` — package the shipped prebuilts,
   don't recompile for the host.
2. Before packaging, `rm -rf node_modules/usb/build` so `node-gyp-build` falls
   through to `prebuilds/linux-arm64/` on the Pi.

Verified the packaged binary is `ELF 64-bit ... ARM aarch64` with no `build/`
dir, and the redeploy launched cleanly. **This fix must stay** or the AppImage
won't run when built from this Mac.

> Side note: rebuilding native deps on this Mac also tripped a TLS error
> (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`) from `@electron/rebuild` fetching Electron
> headers; worked around once with `NODE_TLS_REJECT_UNAUTHORIZED=0`. With
> `npmRebuild:false` that step is skipped entirely, so it's no longer needed.

---

## What was ruled out / learned (don't re-derive)

- **Synthetic-drag CDP probing is unreliable for this.** During testing the
  CarPlay stream "kept dropping," but `dmesg` showed **zero USB disconnects** that
  boot — i.e. NOT hardware re-enumeration. The drops were almost certainly my
  synthetic touch injection fighting the live phone session / heavy CDP load.
  **Stop synthetic-input probing against the live dongle.**
- **GPU-layer tricks on the video canvas backfire on V3D.** `border-radius` +
  `willChange:transform` + `contain` on a large, every-frame-updated canvas =
  catastrophic per-frame raster (the ~10s delay). Do NOT promote/clip the video
  canvas this way.
- **Governor change (Session 2) did not noticeably help** per the user. The
  Session-2 "governor was root cause" conclusion is **invalidated**.
- Earlier (Session 2) measurements, treat with skepticism given the above:
  decode ~2.2ms, 1:1 chunks:draws, main-thread jank ~0.13ms, no thermal
  throttle, ~28 sensor events/s. The bottleneck appears to be in
  **compositing/presentation**, content-dependent, not decode throughput — but
  the only changes attempted to exploit that made things worse.

---

## Files touched this session (working tree, uncommitted)

| File | Change | Keep? |
|------|--------|-------|
| `electron-builder.yml` | `npmRebuild: false` + comment | **YES — required to launch** |
| `src/main/usb/USBService.ts` | `carplay.stop()` on detach | Yes (user-requested, unverified) |
| `src/renderer/src/components/Carplay.tsx` | **reverted to HEAD** | n/a (no diff) |
| `src/renderer/src/components/BackdropGlow.tsx` | **reverted to HEAD** | n/a (no diff) |
| `HANDOFF.md` | Session-2 notes (pre-existing) | — |
| `tools/perf/cdp_*.py` | probe scripts (untracked) | tooling only |

The deployed AppImage = baseline UI + the two "Keep" rows above.

---

## Where I'm handing off / suggested next steps

1. **Confirm baseline restored** — get the user to verify the unit feels like it
   did originally (backdrop visible, touch responsive, no multi-second delay).
2. **Re-approach lag conservatively.** The compositor-cost theory may still be
   right, but the fixes must be different and each independently reversible:
   - Prefer the **existing Settings → BACKDROP toggle** (user already confirmed
     OFF helps) over CSS rewrites. Consider only whether to change its *default*,
     not how it composites.
   - Do **not** touch the video canvas's clipping/layer promotion again without a
     way to A/B it live and revert instantly.
   - If probing, measure **without** synthetic input (passive observation of real
     use), since synthetic drag corrupts the session and the measurement.
3. **Build discipline:** keep `npmRebuild:false`; always `rm -rf
   node_modules/usb/build` before packaging from this Mac; restore `package.json`
   after every build (`git checkout -- package.json`) per `CLAUDE.md`; verify the
   packaged `usb` binary is ELF aarch64 before deploying.
4. **USB detach `stop()` fix is unverified** — confirm a real dongle drop now
   recovers cleanly on reattach.

---

## Follow-up: plain CarPlay diagnostic build deployed (2026-06-11)

User reported the later CarPlay/dongle recovery hardening did **not** noticeably
improve the experience. During testing, the phone sometimes has to have
Wi-Fi/Bluetooth toggled before it will "let go" of CarPlay and reconnect.

Implemented a hidden, recoverable plain mode:

- `src/main/Globals.ts`: added `diagnosticPlainCarplay?: boolean`.
- `src/main/index.ts`: default config now writes `diagnosticPlainCarplay: false`.
- `src/renderer/src/App.tsx`: when the flag is true, render only the centered
  CarPlay square on black. It skips `BackdropGlow`, gauges, graphs, nav, routes,
  home overlay, dev panel, reverse camera modal, and camera detection.
- `src/renderer/src/components/Carplay.tsx`: when the flag is true, keep the
  CarPlay surface visible regardless of route, block host-UI navigation to
  settings, disable the render worker backdrop frame tap, and remove the normal
  rounded/overscan video styling for the plain test.

Verified locally:

- `npm run typecheck` passes.
- Built with `rm -rf node_modules/usb/build && npm run build:armLinux`.
- Ran `git checkout -- package.json` and validated JSON after the build.
- Verified packaged `usb` binary is `ELF 64-bit ... ARM aarch64`.

Deployed to the correct autostart path:

```bash
rsync -az --progress dist/round-carplay-0.1.0-arm64.AppImage \
  byron@motocarplay.local:/home/byron/round-carplay/round-carplay.AppImage
```

Pi state after deploy:

- Config backup:
  `/home/byron/.config/round-carplay/config.before-plain-carplay-20260611-004625.json`
- Current config has `diagnosticPlainCarplay: true`.
- Reboot verified by new boot ID and boot time `2026-06-11 00:48:05`.
- App is listening on port `4000`; port `9222` is closed.
- Process command does **not** include `--remote-debugging-port`.

Passive USB finding in plain mode:

- On the fresh diagnostic boot, the Auto Box enumerated at `00:48:09`, then
  disconnected at `00:48:19`, and re-enumerated at `00:48:23`.
- A further ~75 second passive watch did not show another disconnect, but this
  early reset happened before gauges/backdrop/graphs could be blamed.

Revert plain mode after the quick test:

```bash
ssh -o ConnectTimeout=6 byron@motocarplay.local \
  "python3 -c 'import json, pathlib; p=pathlib.Path(\"/home/byron/.config/round-carplay/config.json\"); c=json.loads(p.read_text()); c[\"diagnosticPlainCarplay\"]=False; p.write_text(json.dumps(c, indent=2)+\"\\n\")' && sudo systemctl reboot"
```

Recommended next test sequence:

1. User feel-tests current plain mode as-is.
2. Check `dmesg` right after any CarPlay freeze/disconnect.
3. If the lag/freeze persists in plain mode, physically unplug USB GPS and test
   again. Stopping `gps.service` is useful for software isolation, but physical
   unplug is better for USB/power/bus interaction.
4. If Auto Box resets continue with plain UI and GPS unplugged, prioritize
   dongle/cable/USB power/hub/port isolation over further renderer changes.

---

## Follow-up: USB traffic correlation + protocol restoration (2026-06-11)

Current deployed Pi state:

- Running the diagnostic plain-CarPlay build (`diagnosticPlainCarplay: true`).
- A later build was deployed and rebooted at `2026-06-11 01:13:38`.
- Port `4000` open; no `9222` remote debug port.
- GPS plugged back in and `gps.service` active.

Important user observation:

- User correctly noted the dongle did **not visibly drop/disconnect** during live
  troubleshooting. Kernel logs agree after the initial boot enumeration: no live
  `usb 3-1` Auto Box disconnects during the slow/fast cycles.

What was measured:

- Enabled `usbmon` on the Pi (`sudo modprobe usbmon`) and monitored bus 3
  (`/sys/kernel/debug/usb/usbmon/3u`), where the Auto Box is attached.
- During sluggish/hang periods in plain mode, incoming USB traffic from the
  dongle frequently dropped from healthy hundreds of kB/s to tiny/control-only
  traffic or near-zero. This happened without kernel USB disconnects,
  undervoltage, thermal throttle, or high CPU.
- GPS unplug test:
  - GPS physically unplugged at `2026-06-11 01:01:00`; kernel logged `usb 1-2`
    CP210x disconnect.
  - `gps.service` was stopped at `01:03:37` after it kept retrying a missing
    device.
  - The CarPlay traffic starvation continued and actually felt worse to the
    user while GPS was unplugged/stopped.
  - GPS was replugged around `01:04:45`; `gps.service` restarted at `01:05:12`;
    feel improved, but intermittent hangs still occurred. Conclusion: GPS is
    not the primary root cause.
- Ethernet was plugged in later; SSH/ping became clean (`eth0 192.168.4.4`).
  This improved measurement reliability only; it is not expected to affect
  phone-to-dongle CarPlay.

Suspicious code regression found:

- Older `src/main/carplay/node/CarplayNode.ts` sent `SendCommand('frame')` every
  5 seconds for `PhoneType.CarPlay` using `phoneConfig[CarPlay].frameInterval`.
- Current `src/main/carplay/CarplayService.ts` had a `frameInterval` member, but
  only cleared it; it did **not** start the periodic frame command.
- Older path also cleared the pair timeout once real video/audio/media arrived.
  Current service scheduled `wifiPair` after start and did not clear it on
  stream data, so a delayed pair command could fire during an already-connected
  stream.

Deployed protocol restoration:

- `CarplayService` now restores the old behavior:
  - On `Plugged`, clear existing timers and start periodic `SendCommand('frame')`
    using `this.config.phoneConfig?.[msg.phoneType]?.frameInterval`.
  - Clear the delayed `wifiPair` timeout on `VideoData`, `AudioData`, and
    `MediaData`.
  - Clear both pair/frame timers on `Unplugged` and stop.
- Built/deployed after `npm run typecheck` passed:
  - `rm -rf node_modules/usb/build && npm run build:armLinux`
  - restored/validated `package.json`
  - verified packaged `usb` prebuilt is Linux ARM64 ELF
  - rsynced to `/home/byron/round-carplay/round-carplay.AppImage`
  - rebooted; fresh boot `01:13:38`

Post-deploy result:

- User reported the CarPlay screen felt very responsive after the protocol
  restoration build.
- Strict continuous-drag test over Ethernet:
  - User continuously dragged/wiggled for ~35 seconds starting around `01:21:47`.
  - `usbmon` showed steady 32-byte touch packets every second (`32:~53-57`) and
    healthy incoming video/data traffic (~600-1000 kB/s) throughout.
  - This means renderer → main → dongle touch delivery is healthy under
    continuous input.
- User later observed a hang; `usbmon` showed low/tiny incoming traffic around
  that moment. Do **not** overinterpret raw low bitrate alone, because static
  CarPlay screens can legitimately send tiny frames. User-perceived touch delay
  remains the deciding signal.

Local-only, not deployed yet:

- `src/renderer/src/components/useCarplayTouch.ts` has a local pointer-capture
  fix:
  - `setPointerCapture` on pointer down.
  - release capture on pointer up/cancel.
  - no longer treats `pointerout` as a fake `Up`; while pressed, `pointerout`
    sends a `Move`.
  - `preventDefault()` added.
- Typecheck passes with this patch.
- This was **not deployed yet** to keep the protocol-restoration A/B clean.

Recommended next steps:

1. Let the user test the currently deployed protocol-restoration build in plain
   mode for a few more minutes.
2. If it is clearly better, deploy the pointer-capture patch as a separate small
   correctness fix and retest.
3. Then flip `diagnosticPlainCarplay` back to `false`, reboot, and test normal
   UI with gauges/backdrop behavior restored. If normal UI regresses while plain
   stays good, investigate renderer/backdrop separately. If normal UI remains
   good, keep the protocol restoration.
4. If intermittent hangs persist even in plain mode with the protocol
   restoration, use strict user-timed tests, not raw bitrate alone:
   - "continuous drag for 30 seconds" should produce steady 32-byte OUT packets.
   - a perceived hang while 32-byte OUT packets are still flowing points at the
     phone/dongle/session responding late.
   - a perceived hang with no 32-byte OUT packets points at renderer/input/main
     delivery.
