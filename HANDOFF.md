# Handoff: CarPlay "sluggish" investigation (2026-06-11)

User symptom: native gauges/graphs are fully responsive, but the inner CarPlay
square feels laggy; noticeably worse with the BACKDROP effect on. After the
fixes below the user reports it **still feels sluggish** — the investigation is
NOT finished. Re-verify everything; don't assume my conclusions are complete.

## Environment (verified live)
- Pi 5, `byron@motocarplay.local`, passwordless sudo. 800×800 round display,
  CarPlay center square 565×565. Dongle config: 565×565 @ 60fps (config.json).
- H.264 decode is **software** (Pi 5 has no H.264 HW decoder — hardware fact).
- GPU compositing/WebGL is **hardware V3D** (confirmed via CDP SystemInfo;
  `--ignore-gpu-blocklist` in autostart). Render worker gets **WebGL1** only —
  `getContext('webgl2')` returns null inside workers on this Mesa/V3D.
- No thermal throttling on the desk (≤60°C, `throttled=0x0`). Untested on bike.
- Read `CLAUDE.md` first: build/deploy rules (restore package.json after every
  build!), autostart-flag debug method (NEVER pkill the app), CDP worker-attach
  + settings-toggle + synthetic-drag workflows.

## What I measured on the OLD build (CDP prototype-patching, tools/perf/)
- 60 chunks/s arrived, only ~49/s drawn; 18% of draw gaps were 24–40ms+.
  Decoder queue depth was ALWAYS 0. CPU had big headroom everywhere
  (decode thread ~10%, render worker ~8%, GPU process ~19%, renderer main
  ~11% — of 400% total). So: scheduling problem, not horsepower.
- Backdrop ON stalled the render worker up to 8.9ms every 200ms sample
  (CPU clone+convert of the frame on the decode thread) — a 5Hz hitch.
- ~53 createImageBitmap/s (CPU YUV→RGBA per frame) and ~50 canvas
  reallocations/s (canvas.width set every frame) in the draw path.
- Chunk inter-arrival was smooth (~17ms median, only 2% bursts <8ms).

## Fixes shipped (commit 008e6ec, deployed + verified 2026-06-11)
1. Render.worker: draw immediately in decoder-output callback (removed the
   rAF deferral + 12.5ms throttle that was phase-slipping against vsync).
2. Backdrop tap: GPU→GPU copy from the drawn canvas into a tiny OffscreenCanvas
   + transferToImageBitmap (no more VideoFrame.clone + CPU convert).
3. GL renderers: texImage2D directly from the VideoFrame; resize canvas only
   when stream dims change.
4. VideoDecoder `optimizeForLatency: true`.
5. processRaw: early-exit keyframe scan; SPS hunt only while unconfigured.
6. CarplayService: `resolution` event once/on-change (was 60/s); cache reset
   on start/stop/attachRenderer so reloads still re-announce.

Post-fix verification (same probes): chunks:draws exactly 1:1 (860/860 in a
sustained map-pan), worker stall 1.1ms with backdrop ON, 0 bitmaps/s,
0 canvas reallocations, queue still 0.

## NOT ruled out — next steps (re-analyze freely)
1. **Touch-to-photon latency was never measured.** "Sluggish" may be input
   latency, not frame rate. The chain: pointer → renderer main → IPC → main →
   USB SendTouch → phone → wireless H.264 encode → dongle → USB → main →
   IPC → renderer main → MessagePort → worker decode → draw. Measure it
   (timestamp at sendTouch vs next-draw, or 240fps phone camera).
2. **Renderer main-thread hop for every video chunk** (preload onVideoChunk →
   postMessage to worker). Sensor events (lean/pitch/gforce/cht/gps over
   socket.io) drive React re-renders at possibly 20–50Hz and compete with
   chunk forwarding. Check emit rates, long tasks on the main thread, and
   consider an Electron MessageChannelMain pipe main→worker that bypasses the
   renderer main thread entirely.
3. **Main-process latency spikes** — DongleDriver does serial awaited
   transferIn (header, then body) on the same loop as socket.io sensor relay
   and config writes. Averages were fine; look at p99.
4. **Wireless link** — 5GHz phone↔dongle. On the bike (tank bag, jacket,
   interference) retransmits could dominate. A/B test wired USB CarPlay feel.
   Also inspect dongle knobs: `mediaDelay: 500`, `phoneConfig.frameInterval`.
5. **Phone-side**: Low Power Mode throttles the CarPlay encoder. Check.
6. **Thermals on the bike** — hidden Pi monitor: two-finger hold ~1s, TEMP row;
   `vcgencmd get_throttled`.
7. **Confirm what build the user is feeling** — re-run tools/perf probes on the
   running unit before trusting anything.
8. Consider trying fps 30 in config.json as an experiment (halves decode work;
   may feel better or worse — measure, don't guess).
9. When CarPlay content is static the dongle sends ~no frames — synthetic-drag
   load tests need `clickCount: 1` on mousePressed (see CLAUDE.md) and a
   non-idle phone screen; verify chunks/s >50 before trusting a measurement.

## SESSION 2 (2026-06-10) — new findings, re-verified live

Pi had been **reflashed** (SSH host key + authorized_keys wiped; re-ran
`ssh-copy-id`). App + sensors survived (persistent storage).

### ROOT CAUSE of the lag: CPU governor was `ondemand`, stuck at ~1.7 GHz
- `scaling_governor=ondemand`, `up_threshold=50`. Under CarPlay load all 4
  cores sat at **1.7 GHz** (min 1.5, max 2.4). Per-frame software-decode bursts
  never pegged a core long enough to clock up → the "headroom everywhere"
  Session-1 saw was the governor *refusing to clock up*, not spare capacity.
  Software H.264 decode latency is ~linear in clock, so frames cost ~40% more
  and jitter as the clock dithers. Native SVG gauges are cheap → felt fine,
  hence "video laggy, rest responsive."
- FIX (shipped, persistent): systemd unit `cpu-performance.service` pins
  `performance` (all cores 2.4 GHz) at boot. Verified across reboot; temp 59°C,
  `throttled=0x0`. To revert: `sudo systemctl disable --now cpu-performance`.
- Post-fix live CDP probes (phone paired, 20 s synthetic full-screen drag):
  - 58.4 chunks/s = 58.4 decode calls/s (1:1), decoder queue 0, **0 decode errors**.
  - decode submit→draw latency **avg 2.2 ms, max 7.4 ms**, no backlog.
  - renderer main-thread jank **avg 0.13 ms, max 3.0 ms** over 15 s → main
    thread is NOT contended. **Rules out Session-1 hypotheses #2 and #3.**

### RULED OUT: the 512KB chunk-fragmentation bug (latent, not firing)
`CarplayService.sendChunked` splits frames >512KB into multiple IPC msgs sharing
one `id`/`offset`/`total`/`isLast`, BUT `Carplay.tsx handleVideo` ignores those
fields and forwards each chunk straight to the decoder — so a >512KB frame
WOULD be decoded as corrupt fragments. Measured: at 565×565 the **largest frame
in 20 s of motion was 57 KB** (0 full-512KB chunks, 0 decode errors). So it
never triggers today. Still worth a defensive fix (reassemble by `id` until
`isLast`, or raise chunk size) before anyone bumps resolution/bitrate.

### USB DISCONNECT symptom — CONFIRMED, it's the DONGLE/wireless, not the Pi
`dmesg` shows the dongle (`1314:1520` "Auto Box", Bus 001, its own USB2 bus,
`Driver=[none]` = userspace libusb, normal) **cleanly disconnects + re-enumerates
on its own** every few minutes (~160–300 s apart), e.g. dev#2→#3→#4→#5. Each gap
~4 s = phone drops + re-searches. Key evidence:
- Disconnects are **CLEAN**: no `-71/-110/EPROTO/over-current/PMIC` errors before them.
- Power is healthy: `EXT5V=5.19V` steady, `throttled=0x0`, no undervoltage.
  (`usb_max_current_enable=0`, but PSU isn't sagging on the desk.)
- Disconnects **continue with the performance governor** → independent of the lag fix.
- ⇒ The dongle's own firmware re-enumerates its USB, almost certainly when its
  5GHz link to the phone drops/re-associates. App recovers (USBService detach→
  renderer `ipc.stop()`; attach→`autoStartIfNeeded`+renderer `ipc.start()`),
  but recovery = the visible "searching again."
- App-side robustness gaps found (worth hardening): on USB **detach** the main
  side only does `markDongleConnected(false)` — it does NOT call `carplay.stop()`,
  so the dead `readLoop` spins on `transferIn` errors until `MAX_ERROR_COUNT=5`
  → `failure` → renderer `window.location.reload()`. And on **attach** both
  `autoStartIfNeeded()` (main) and renderer `ipc.start()` race (guarded by
  `if(this.started)return`, usually benign). Tightening these would make
  re-pair faster/cleaner but won't stop the dongle dropping.

### NOT yet done (for next session)
- Catch a disconnect WHILE riding / correlate with phone (Low Power Mode off?
  5GHz vs 2.4 — `config.json wifiType:'5ghz'`; try `2.4ghz` for range).
- A/B a **wired** CarPlay dongle or a different unit to prove it's this dongle.
- Touch-to-photon end-to-end (the wireless H.264 round trip is the only big
  unmeasured latency; no Pi-side change touches it).
- Background USB monitor pattern: `sudo dmesg -w | grep 'usb 1-1'` to a /tmp log.

## Tools
- `tools/perf/cdp_chunk_probe.py` — chunk sizes + fragmentation + decode errors.
- `tools/perf/cdp_latency_probe.py` — decode submit→draw latency + main-thread jank.
- `tools/perf/cdp_pipeline_probe.py` — run ON the Pi with the debug-port
  autostart flag active; A/B's backdrop ON/OFF under synthetic drag, reports
  chunks/draws/queue/stalls + arrival & draw-gap histograms.
- `tools/perf/top_thread_agg.py` — aggregates `top -b -H` by process role
  (needs /tmp/tidmap.out from `ps -eLo pid,tid,comm,args | grep -i carplay`).
- /tmp on the Pi is tmpfs — re-upload scripts after every reboot.

## SESSION 4 (2026-06-11) — no-phone audit + deployed hardening

User left the Pi powered/networked but took the phone, so **no live CarPlay
touch/video feel-test was possible**. Treat the changes below as plausible
hardening for the lag/reconnect symptoms, not as proven final fixes.

### Current deployed Pi state after this session
- Deployed AppImage:
  `/home/byron/round-carplay/round-carplay.AppImage`
- Autostart is clean:
  `Exec=/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- `gps.service`, `cht-temp.service`, and `cpu-performance.service` are active.
- `vcgencmd get_throttled` reports `0x0`.
- Sparse diagnostics log is enabled at:
  `/home/byron/.config/round-carplay/diagnostics.log`
- Current config: `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.

### No-phone measurements
- Passive CDP idle probe on the deployed build remained clean on the root dash:
  no long tasks, rAF ~16.7 ms, timer lag p99 ~1 ms. Settings route still has a
  one-off route-change long task, not relevant to live CarPlay lag.
- One earlier boot during the session showed the familiar early Auto Box reset:
  enumerate at `03:40:44`, disconnect at `03:40:54`, re-enumerate at `03:40:58`.
  This happened with no phone present and no backdrop stream, so it still cannot
  be blamed on gauges/backdrop rendering. After the final diagnostics build
  deployment, the boot at `03:49:26` showed only normal enumeration and a 120 s
  passive `dmesg -wT` watch showed no additional USB events.

### History/audit findings
- Commit `41fb24f` introduced several risky changes together: live backdrop
  sampling, huge CSS blur, rounded clipping/overscan of the live video canvas,
  center-square clipping, and gauge drop-shadows. Later work fixed the CPU
  sampler and current deployed code removes the live canvas clipping/overscan,
  but the CSS backdrop layer can still only be judged with a live stream.
- Graph/data logging is throttled to 1 Hz per metric and passive idle stayed
  clean, so it is unlikely to explain 5-8 second center-only lag by itself.
- The most suspicious untested path was **input backlog**, not frame decode:
  every `pointermove` used to fire-and-forget an IPC message and async USB
  `SendTouch`. If the dongle/phone consumed touch commands slower than the
  renderer produced moves, old coordinates could queue for seconds while gauges
  stayed responsive.
- The renderer also forwarded video/audio IPC chunks using whole backing
  `ArrayBuffer`s instead of exact view ranges. That is usually harmless when the
  backing store is exact, but it is a bad assumption at this boundary and can
  create rare corrupt/oversized worker inputs.

### Changes deployed in this session
- `CarplayService`: coalesces touch moves so only the latest move is retained
  while a USB send is in flight; `down` and `up` stay ordered. It logs throttled
  warnings for slow touch sends (`>50 ms`) with queued count.
- `DongleDriver`: serializes outgoing USB `transferOut` calls globally. This
  prevents heartbeats, frame commands, key commands, and touch writes from
  stacking concurrent writes on the same endpoint.
- `Carplay.tsx`: reassembles split video chunks by `id`/`offset`/`total` before
  sending them to the render worker, and transfers exact chunk byte ranges.
- Audio forwarding now transfers exact audio chunk byte ranges and sends only
  metadata instead of duplicating the full audio `data` payload in every IPC
  chunk.
- Physical dongle detach now calls `carplay.stop()`, and driver failure /
  logical phone-unplug handling stop and restart cleanly if the dongle is still
  present.
- `DongleDriver.readLoop` resets `errorCount` after any successful message so
  non-consecutive read hiccups do not accumulate into a false failure.
- Sparse persistent diagnostics now logs app start config, USB attach/detach,
  dongle-present-at-startup, settings saves/toggles, logical phone unplug,
  driver failure, start/stop, and slow touch sends to
  `/home/byron/.config/round-carplay/diagnostics.log`. It rotates at 512 KB and
  does not log per-frame video. After the final reboot it correctly logged:
  `usb dongle-present-at-startup` followed by `carplay started`.
- Type-only import boundaries were tightened so renderer bundles no longer pull
  main-process `fs/path/electron` code through the message/driver barrel.

### Verification performed
- `npm run typecheck` passed.
- Built with `rm -rf node_modules/usb/build && npm run build:armLinux`.
- Restored and parsed `package.json` after the build.
- Packaged USB native module verified as ARM aarch64 ELF; no packaged
  `node_modules/usb/build` directory.
- Deployed and rebooted the Pi; verified clean production autostart, `4000`
  listening, `9222` closed, services active, no throttling, diagnostics log
  created with startup entries. During the intentional reboot, the log captured
  one `LIBUSB_TRANSFER_NO_DEVICE` read error after `carplay stopping/stopped`;
  that is expected during reboot/detach and should not be treated as a live
  disconnect unless it appears during normal running.

### Next live-phone test checklist
1. Test normal config first: backdrop off, ambient fill off, fps 45. Drag/pan
   CarPlay and note whether multi-second touch lag is improved.
2. If still laggy, watch app logs for `[CarplayService] slow touch send` lines;
   these would directly support the input-backlog hypothesis. The durable source
   is now:
   `tail -f /home/byron/.config/round-carplay/diagnostics.log`
3. Then test backdrop on. If lag/disconnect returns mainly with backdrop on,
   avoid more rounded-canvas experiments; A/B the backdrop CSS/filter layer
   itself or leave backdrop off.
4. If logical `phone-unplugged` events occur without kernel USB disconnects,
   prioritize wireless/dongle session stability, 2.4 GHz vs 5 GHz, and phone
   Low Power Mode.
5. If physical `usb 3-1` disconnects return, that is still a dongle/power/cable
   path; app-side changes only improve recovery.

## SESSION 5 (2026-06-11) — no-phone follow-up + cleanup deploy

Still no phone/live CarPlay stream available, so this session could not prove or
disprove touch feel under real CarPlay video load.

### Current deployed Pi state after this session
- Deployed a new AppImage to:
  `/home/byron/round-carplay/round-carplay.AppImage`
- Autostart is clean:
  `Exec=/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- `gps.service`, `cht-temp.service`, and `cpu-performance.service` are active.
- `vcgencmd get_throttled` reports `0x0`.
- Current config remains: `565x565`, `fps=45`, `dpi=140`,
  `backdropEnabled=false`, `ambientFillEnabled=false`,
  `diagnosticPlainCarplay=false`, `diagnosticPointerCaptureTouch=false`,
  `wifiType=5ghz`, `audioTransferMode=true`.

### Measurements / findings
- Re-ran passive CDP idle probing on the actual deployed app with no phone:
  root dashboard was clean (`rAF` ~16.67 ms, no long tasks, timer lag p99
  ~1.2 ms). Settings route still showed a one-off route-load long task
  (~111 ms), but that is not a 5-8 second center-only CarPlay lag mechanism.
- The Auto Box again performed an early clean USB re-enumeration with no phone
  and no backdrop stream:
  - debug boot: enumerate `04:03:36`, disconnect `04:03:45`, re-enumerate
    `04:03:50`.
  - final deployed boot: enumerate `04:11:35`, disconnect `04:11:45`,
    re-enumerate `04:11:49`, app restarted CarPlay at `04:11:50`.
  This keeps the dongle/power/cable/firmware path in scope independent of
  CarPlay rendering.
- Important correction to the Session 4 note: video is not currently forwarded
  as a pure exact H.264 byte range. `VideoData.data` is a subarray after the
  20-byte dongle video header, but `CarplayService` forwards `msg.data.buffer`,
  and `Render.worker` intentionally strips `vendorHeaderSize = 20`. Do not
  "fix" only one side. A future cleanup can send the exact H.264 range from
  main and remove the worker strip, but that must be live-video tested.

### Changes deployed in this session
- Added real preload unsubscribe methods for settings/carplay IPC callbacks.
- Updated `Carplay.tsx` cleanup to use those unsubscribe methods instead of
  `window.electron`, which is not exposed by this preload.
- Updated `Settings.tsx` USB listeners so repeated settings visits do not
  accumulate anonymous callbacks.
- `CarplayService.autoStartIfNeeded()` now defers and retries if a USB attach
  arrives while `stop()` is still finishing, covering a reconnect race.
- `DongleDriver` now invalidates queued `transferOut` sends when the driver
  closes, so stale touch/heartbeat/startup writes cannot leak into a later
  dongle session.

### Verification performed
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build && npm run build:armLinux`.
- Restored and parsed `package.json` after the build.
- Verified packaged `usb` uses linux-arm64 prebuilds and no packaged
  `node_modules/usb/build` directory exists.
- Deployed, rebooted, verified production autostart, `4000` open, `9222`
  closed, services active, no throttling, and diagnostics logging startup.

### Still needs phone/live test
1. Backdrop off, ambient fill off, fps 45: drag/pan CarPlay and note whether
   the multi-second touch lag is improved.
2. Tail `/home/byron/.config/round-carplay/diagnostics.log` during the test and
   look for `[touch] slow-send` or `phone-unplugged`.
3. Then test backdrop on only if the backdrop-off path is acceptable. If
   backdrop-on reintroduces lag or disconnects, treat it as a separate
   compositor/backdrop cost problem, not the whole baseline lag problem.
4. If physical `usb 3-1` disconnects occur, continue hardware isolation:
   cable/port/power/dongle, and consider a 2.4 GHz wireless A/B for range.

## SESSION 6 (2026-06-11) — startup timing audit

Still no phone/live stream available.

### Finding: boot-time Auto Box reset is not caused by backdrop or app start
- Code audit found `USBService` was constructed before the BrowserWindow, so an
  already-present dongle could trigger `carplay.autoStartIfNeeded()` before any
  renderer was attached. That was a real race: the main process could open and
  configure the dongle while the UI was not ready to receive CarPlay events.
- Changed startup/attach behavior so auto-start waits for an attached renderer
  and uses a short settle delay (`1500 ms` for already-present startup dongle,
  `1000 ms` after hot attach). Direct `start()` now refuses to run before a
  renderer is attached and logs `start-no-renderer`.
- Deployed and reboot-tested this build. The Auto Box still performed the same
  early clean reset before a successful CarPlay start:
  - enumerate `04:17:43`
  - USB disconnect `04:17:53`
  - re-enumerate `04:17:57`
  - app started CarPlay cleanly at `04:17:59`
- Diagnostics showed `autostart-deferred-no-renderer` during the reset window,
  then a clean start after reattach. This strongly suggests the first boot-time
  re-enumeration is dongle firmware / USB-device behavior, not the app opening
  the device and not any renderer/backdrop work.

### USB/power topology evidence
- Auto Box is isolated on its own USB2 root bus:
  `Bus 003.Port 001 -> 1314:1520 Auto Box`, `Driver=usbfs`, `480M`.
- Touchscreen and GPS UART are on a different root bus:
  `Bus 001` (`0483:5750` touchscreen, `10c4:ea60` CP210x GPS UART).
- Power remains healthy: `EXT5V` about `5.16 V`, `throttled=0x0`, and no
  undervoltage / over-current / USB protocol errors around the reset.
- A 150 s post-reattach `dmesg -wT` watch produced no additional Auto Box events.

### Changes deployed in this session
- `CarplayService.attachRenderer()` now schedules auto-start if a dongle is
  already connected.
- `autoStartIfNeeded()` now refuses to start before renderer attach and defers
  if `stop()` is in progress.
- `USBService` now schedules delayed auto-start for startup-present and
  hot-attached dongles instead of starting immediately.

### Verification performed
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build && npm run build:armLinux`.
- Restored and parsed `package.json` after the build.
- Verified packaged `usb` uses the linux-arm64 ELF prebuild and no packaged
  `node_modules/usb/build` directory exists.
- Deployed, rebooted, verified production autostart, `4000` open, `9222`
  closed, services active, no throttling, and clean CarPlay start after the
  dongle's early re-enumeration.

## SESSION 7 (2026-06-11) — overnight no-phone review

Still no phone/live CarPlay stream available. No runtime source changes were
made in this pass; this was a conservative audit + non-invasive Pi testing
session.

### Local verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- `npm run build` passed, so the current main/preload/renderer graph bundles.
- `package.json` and `package-lock.json` both parse as JSON.
- Note: `package-lock.json` still has unrelated metadata churn removing
  optional dependency `libc` fields. Treat that as lockfile noise unless it was
  intentionally produced.

### Pi state / no-phone measurements
- Pi remained production-clean: autostart is
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`,
  port `4000` is open, debug port `9222` is closed.
- Config still matches the intended baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.
- Power/clocks were healthy: all CPUs on `performance` at `2.4 GHz`, temp about
  `53 C`, `EXT5V` about `5.19 V`, `throttled=0x0`.
- A 30 s socket sample showed modest sensor rates:
  `lean/pitch/gforce` about `9.5 Hz` each, GPS/GPS sky/status `1 Hz`,
  CHT/Pi temp `0.5 Hz`, ambient `0.1 Hz`.
- A 60 s process sample showed the whole round-carplay process tree idling at
  about `3.8%` CPU with no phone connected.
- A 5 min `dmesg -wT` watch produced no new Auto Box events after the known
  boot-time reset. Final diagnostics tail still ended at the clean
  `04:17:59` CarPlay start.

### Code review conclusions
- Hidden graph views do **not** render continuously. `MetricGraph` is mounted
  only behind `activeGraph && <MetricGraph />`; always-on graph history is
  throttled to 1 sample/sec/metric.
- With `backdropEnabled=false`, the backdrop React component is not mounted and
  `Carplay.tsx` sends `set-backdrop=false` to the render worker. That means the
  live backdrop should not consume recurring canvas/filter resources while off.
- The current code has already removed the riskiest `41fb24f` compositor costs
  from the live center path: no gauge drop-shadows, no center-square rounded
  clipping, no video-container rounded clipping, and no canvas overscan under a
  clipped parent. The remaining expensive path is the backdrop itself when
  enabled (`BackdropGlow` still applies `blur(6px) saturate(...)` to the scaled
  canvas).
- Do **not** do a one-sided "exact H.264 bytes" cleanup. Today main forwards the
  full video message buffer and `Render.worker` strips a 20-byte vendor header.
  If future cleanup sends exact H.264 from main, remove the worker strip in the
  same change and live-test video.
- The Settings save-button issue is likely addressed by the current App diff:
  arc hit zones have `pointerEvents: none` off the root route, and the center
  square is raised above the arcs on non-root routes.

### Remaining live-phone test plan
1. Test with the current baseline first: backdrop off, ambient fill off, fps 45.
   Drag/pan CarPlay and watch for multi-second touch lag.
2. While testing, tail:
   `tail -f /home/byron/.config/round-carplay/diagnostics.log`
   and look for `[touch] slow-send`, `phone-unplugged`, `driver-failure`, or
   physical `usb dongle-detach`.
3. If the screen feels laggy but no `[touch] slow-send` appears, the main-to-USB
   touch path is probably not the backlog; focus on phone/dongle/wireless
   response or compositor presentation.
4. If `[touch] slow-send` appears during lag, keep investigating the outgoing
   USB command queue / dongle command consumption.
5. Only after backdrop-off behavior is characterized, test backdrop on. If it
   regresses mainly with backdrop on, treat backdrop as a separate compositor
   feature and avoid more rounded-canvas/layer-promotion experiments.

## SESSION 8 (2026-06-11) — deployed read-loop reconnect guard

Still no phone/live CarPlay stream available.

### Finding / fix
- Reviewed the remaining `DongleDriver` reconnect hardening and found a subtle
  stale-read-loop race: a pending old `transferIn` loop could remain marked as
  running across a fast detach/reattach. In the best case the next session
  waited for the old loop to unwind; in the worst case a stale read error could
  increment the new session's shared `errorCount`.
- Deployed a low-risk guard in `DongleDriver`:
  - added `_readGeneration`;
  - each read loop captures its generation and exits after close/restart;
  - stale read errors after a generation change do not increment `errorCount`;
  - `close()` now invalidates read loops and clears timers/send queue even if
    `_device` is already null.
- This does **not** prove the lag root cause. It is reconnect hygiene for the
  occasional dongle/drop path and prevents stale USB reads from contaminating a
  later session.

### Build / deploy verification
- `npm run typecheck` passed before and after the patch.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build && npm run build:armLinux`.
- Restored and parsed `package.json` after the build.
- Verified the packaged `usb` native module is
  `ELF 64-bit ... ARM aarch64` at
  `node_modules/usb/prebuilds/linux-arm64/node.napi.armv8.node`, with no
  packaged `node_modules/usb/build` directory.
- Deployed to the correct autostart path:
  `/home/byron/round-carplay/round-carplay.AppImage`
- Rebooted and verified:
  - port `4000` listening;
  - debug port `9222` closed;
  - autostart still
    `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`;
  - `gps.service`, `cht-temp.service`, and `cpu-performance.service` active;
  - `throttled=0x0`;
  - config unchanged (`565x565`, `fps=45`, backdrop/ambient/plain/pointer
    diagnostics all false, `wifiType=5ghz`, `audioTransferMode=true`).

### Post-deploy Pi observation
- The familiar boot-time Auto Box reset still happened:
  - enumerate `04:37:49`
  - disconnect `04:37:59`
  - re-enumerate `04:38:03/04:38:04`
  - app started CarPlay cleanly at `08:38:06Z`
- A 150 s passive `dmesg -wT` watch after reattach produced no additional Auto
  Box events.
- The boot reset therefore remains independent of this driver guard and still
  looks like dongle firmware/device behavior rather than app/backdrop load.

## SESSION 9 (2026-06-11) — deployed graceful Linux reset path

Still no phone/live CarPlay stream available.

### Finding / fix
- Reviewed `USBService.forceReset()` because Settings uses `usb-force-reset`
  after restart-required config changes. On Linux it previously:
  - broadcast a synthetic detach;
  - set `lastDongleState=false`;
  - reset the dongle;
  - but did **not** stop `CarplayService` first and did **not** mark the main
    CarPlay dongle state false.
- That meant the main process partly relied on the renderer receiving the fake
  detach and calling `carplay-stop`. It also set `lastDongleState=false` before
  the real kernel detach, so the physical detach handler could be suppressed.
- Deployed a safer reset path:
  - Linux `forceReset()` now stops CarPlay and waits 300 ms before resetting;
  - both `forceReset()` and macOS `gracefulForceReset()` now call
    `carplay.markDongleConnected(false)` when they synthesize the detach.
- This is reconnect/reset hygiene. It is not proof of the lag root cause, but it
  removes another main/renderer race in the dongle recovery path.

### Build / deploy verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build && npm run build:armLinux`.
- Restored and parsed `package.json` after the build.
- Verified the packaged `usb` native module is the Linux ARM64 ELF prebuild and
  no packaged `node_modules/usb/build` directory exists.
- Deployed to `/home/byron/round-carplay/round-carplay.AppImage` and rebooted.
- Verified final Pi state:
  - port `4000` listening;
  - debug port `9222` closed;
  - autostart still
    `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`;
  - `gps.service`, `cht-temp.service`, and `cpu-performance.service` active;
  - `throttled=0x0`;
  - config unchanged (`565x565`, `fps=45`, backdrop/ambient/plain/pointer
    diagnostics all false, `wifiType=5ghz`, `audioTransferMode=true`).

### Post-deploy Pi observation
- The familiar boot-time Auto Box reset still happened:
  - enumerate `04:46:36`
  - disconnect `04:46:46`
  - re-enumerate `04:46:50`
  - app started CarPlay cleanly at `08:46:52Z`
- A 150 s passive `dmesg -wT` watch after reattach produced no additional Auto
  Box events.

## SESSION 10 (2026-06-11) — final no-phone audit + deploy

Still no phone/live CarPlay stream available. This pass found small concrete
cleanup items and made settings persistence awaitable, but still could not
live-verify touch feel or backdrop-on behavior.

### Findings / fixes
- Backdrop-off now means off from worker startup:
  - `Render.worker` now defaults `backdropEnabled=false` instead of true.
  - `Carplay.tsx` clears the retained backdrop `ImageBitmap` when backdrop is
    disabled/plain mode is active, so the last ambient frame is not kept around.
- `DongleDriver` now converts WebUSB `DataView` transfers using the exact
  `byteOffset`/`byteLength` range before parsing headers/body. This avoids
  relying on the transfer's backing `ArrayBuffer` being exactly sized.
- `preload.onUSBResetStatus()` now returns an unsubscribe function. It is not
  currently used by the renderer, but it closes the same listener-leak class
  fixed elsewhere.
- Settings persistence was made awaitable:
  - main now registers the already-exposed `getSettings` and `save-settings`
    IPC handlers;
  - renderer `saveSettings()` uses the IPC save when available, with socket
    fallback for non-Electron/demo contexts;
  - main `saveSettings()` normalizes numeric fields once, updates the live
    `config`, writes `config.json`, and then broadcasts settings.

### Additional audit notes
- Git history still points to `41fb24f` as the risky regression cluster: it
  added live backdrop sampling, huge CSS blur, rounded clipping on the center
  square and live video, canvas overscan, gauge drop-shadows, and a shadow ring
  all at once. Current deployed code has removed the rounded/clipped/overscan
  live video path and gauge drop-shadows. The remaining costly feature is the
  backdrop itself when enabled.
- `MetricGraph` is only mounted behind `activeGraph && <MetricGraph />`; hidden
  graph views are not rendering. Data history remains throttled to 1 sample/sec
  per metric.
- `SysMonitor` is cheap while closed: passive pointer listeners only, no polling.
- Candidate for a later live A/B, not patched tonight: `HomeView` remains mounted
  above the center square at `opacity:0`, high z-index, transform, and
  `pointerEvents:none` while CarPlay streams. It should not steal touches, but
  if backdrop-off still feels worse than the old bare-CarPlay test, try a live
  diagnostic build that fully unmounts or `display:none`s this hidden layer.

### No-phone measurements
- Baseline config remained:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.
- 60 s socket sample after deploy:
  - lean/pitch/gforce about `9.48 Hz` each;
  - gps/gps-status/gps-sky about `1.02 Hz`;
  - cht/pi-temp about `0.52 Hz`;
  - ambient about `0.12 Hz`.
  These rates are modest and still do not look like a source of 5-8 second
  center-only lag.
- 60 s no-phone process sample after deploy:
  - main app process about `1.6%` CPU;
  - renderer about `2.3%` CPU;
  - no alarming memory value observed.
- A 5 minute no-phone USB watch after the prior deploy produced no Auto Box
  events beyond the boot-time re-enumeration.

### Deployed Pi state
- Deployed to `/home/byron/round-carplay/round-carplay.AppImage`.
- Autostart clean:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` listening; debug port `9222` closed.
- `gps.service`, `cht-temp.service`, and `cpu-performance.service` active.
- `vcgencmd get_throttled` reported `0x0`; temperature about `53 C`.
- Packaged `usb` native module verified as Linux ARM64 ELF prebuild; no packaged
  `node_modules/usb/build` directory.
- `package.json` restored after build and parses as JSON.

### Post-deploy Pi observation
- Familiar boot-time Auto Box reset still happened with no phone and backdrop off:
  - enumerate `05:05:09`
  - disconnect `05:05:19`
  - re-enumerate `05:05:23`
  - app started CarPlay cleanly at `09:05:25Z`
- A 150 s `dmesg -WT` new-event watch after reattach produced no matches.
  This further supports the boot reset being dongle firmware/device behavior,
  not app/backdrop rendering.

## SESSION 11 (2026-06-11) — Settings save-before-reset ordering fix

Still no phone/live CarPlay stream available.

### Finding / fix
- Follow-up audit found `Settings.handleSave()` still reset the dongle before
  saving restart-required settings. Session 10 made saves awaitable, but this UI
  path was still calling `usb.forceReset()` first and `saveSettings()` second.
- Deployed a direct ordering fix:
  - Settings now shows `Saving...`;
  - awaits `saveSettings(activeSettings)`;
  - only then calls `usb.forceReset()` when a dongle is connected;
  - clears `hasChanges` only after the save succeeds.
- This is not a proven lag root cause, but it does fix a real reset/autostart
  race for changes like `fps`, `dpi`, `wifiType`, `audioTransferMode`, etc.

### Build / deploy verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build && npm run build:armLinux`.
- Restored and parsed `package.json` after the build.
- Verified packaged `usb` native module is the Linux ARM64 ELF prebuild and no
  packaged `node_modules/usb/build` directory exists.
- Deployed to `/home/byron/round-carplay/round-carplay.AppImage` and rebooted.
- Verified:
  - production autostart still includes only `--ignore-gpu-blocklist`;
  - port `4000` listening;
  - debug port `9222` closed;
  - `gps.service`, `cht-temp.service`, and `cpu-performance.service` active;
  - `throttled=0x0`;
  - config unchanged (`565x565`, `fps=45`, backdrop/ambient/plain/pointer
    diagnostics all false, `wifiType=5ghz`, `audioTransferMode=true`).

### Post-deploy Pi observation
- Familiar boot-time Auto Box reset still happened:
  - enumerate `05:11:15`
  - disconnect `05:11:25`
  - re-enumerate `05:11:29`
  - app started CarPlay cleanly at `09:11:31Z`
- A 120 s post-reattach `dmesg -WT` new-event watch produced no matches.

### Next live-phone test
1. Start with baseline: backdrop off, ambient fill off, fps 45.
2. Tail `/home/byron/.config/round-carplay/diagnostics.log` while dragging
   CarPlay. Look for `[touch] slow-send`, `phone-unplugged`, `driver-failure`,
   or physical `usb dongle-detach`.
3. If lag occurs and no `[touch] slow-send` appears, the main-to-USB touch queue
   is less likely; focus on phone/dongle/wireless response or compositor
   presentation.
4. If backdrop-off is good, test backdrop on separately. If it regresses, treat
   backdrop as its own compositor/backdrop feature problem.
5. If backdrop-off is still worse than the old bare-CarPlay test, A/B the hidden
   `HomeView` layer described above before changing more USB code.

## SESSION 12 (2026-06-11) — post-reset reconcile deploy + no-phone audit

Still no phone/live CarPlay stream available. Do not treat this as a proven lag
fix; it only tightens reset/reconnect behavior and re-verifies the no-phone
baseline.

### Finding / fix
- Deployed the pending `USBService` post-reset reconcile patch:
  - after a successful `dongle.reset()`, schedule checks at 750 ms, 2000 ms,
    and 4000 ms;
  - if the app still thinks the dongle is detached but `findDongle()` sees it,
    log `usb post-reset-reconcile`, mark it connected, broadcast attach/plugged,
    and schedule autostart;
  - clear those timers when one succeeds or when USB monitoring stops.
- Rationale: after a synthetic Settings reset, a successful USB reset can return
  without the app receiving a normal attach event. This patch keeps the app from
  getting stuck in "adapter gone" after a reset. It does not target baseline
  rendering lag directly.

### Build / deploy verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build && npm run build:armLinux`.
- Restored and parsed `package.json` and parsed `package-lock.json` after the
  build.
- Verified the packaged `usb` native module is the Linux ARM64 ELF prebuild and
  no packaged `node_modules/usb/build` directory exists.
- Deployed to `/home/byron/round-carplay/round-carplay.AppImage` and rebooted.

### Final Pi state
- Production autostart is clean:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- `gps.service`, `cht-temp.service`, and `cpu-performance.service` are active.
- `vcgencmd get_throttled` reports `0x0`.
- Config remains baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.

### No-phone measurements after deploy
- Sensor event rates over 30 s:
  `lean/pitch/gforce` about `9.47 Hz` each, GPS/GPS sky/status `1 Hz`,
  CHT/Pi temp `0.5 Hz`, ambient `0.1 Hz`.
- 60 s process sample:
  main app process about `1.25%` CPU, renderer about `2.07%` CPU, no alarming
  memory values.
- Passive CDP idle probe with the safe autostart debug-flag method:
  - root dashboard 20 s: rAF avg `16.71 ms`, p99 `16.71 ms`, max `24.63 ms`,
    timer lag p99 `0.72 ms`, no long tasks;
  - settings route 15 s: one route/render long task around `115 ms`, with rAF
    max `133.6 ms`; this is a settings-open blip, not a 5-8 s live CarPlay lag
    mechanism;
  - root after returning 10 s: rAF avg `16.72 ms`, timer lag p99 `0.85 ms`, no
    long tasks.
- USB observation:
  - each reboot still shows the familiar early clean Auto Box re-enumeration
    with no phone and backdrop off;
  - a 150 s post-reattach `dmesg -WT` watch after deploy and a final 90 s watch
    after restoring production autostart produced no additional Auto Box events.

### Code-audit notes
- The suspected regression commit remains `41fb24f`: it added the live backdrop,
  huge CSS blur, rounded clipping/overscan, gauge drop-shadows, and the shadow
  ring together. Current code has removed the rounded/clipped/overscan live
  video path and gauge drop-shadows when backdrop is off. The remaining obvious
  expensive live feature from that cluster is `BackdropGlow` when enabled.
- Hidden graph views are still conditional (`activeGraph && <MetricGraph />`);
  history logging is throttled to 1 sample/sec/metric. Offline evidence does not
  support graph history/sensors as a multi-second center-only lag cause.
- `HomeView` has no timer while hidden, but its invisible overlay DOM remains
  mounted above the center square while streaming. If backdrop-off still feels
  worse than the old bare-CarPlay diagnostic, A/B fully unmounting/display-none
  for this hidden layer before changing more USB/video code.
- Be careful with future video byte-range cleanup. Session 13 fixed main-side
  forwarding to send the exact dongle video body while preserving the current
  worker-visible protocol: the worker still receives the 20-byte dongle video
  metadata header and strips `vendorHeaderSize = 20`. A future cleanup could
  send exact H.264 bytes instead, but that must change both sides together and
  be live-video tested.

### Next live-phone test
1. Start with current baseline: backdrop off, ambient fill off, fps 45.
2. Tail `/home/byron/.config/round-carplay/diagnostics.log` while dragging
   CarPlay. Look for `[touch] slow-send`, `phone-unplugged`, `driver-failure`,
   or physical `usb dongle-detach`.
3. If lag occurs and no `[touch] slow-send` appears, the main-to-USB touch queue
   is less likely; focus on phone/dongle/wireless response or compositor
   presentation.
4. If baseline is good, test backdrop on separately. If it regresses, treat
   backdrop as its own visual feature/cost problem.
5. If baseline is still worse than the plain CarPlay diagnostic, do a small live
   A/B that removes the hidden `HomeView` layer while streaming.

## SESSION 13 (2026-06-11) — exact video-body forwarding patch

Still no phone/live CarPlay stream available.

### Finding / fix
- Found a concrete byte-boundary assumption in the live video path:
  `VideoData.data` is a `Buffer.subarray(20)` after the dongle's 20-byte video
  metadata header, but `CarplayService` forwarded `msg.data.buffer`. That loses
  the Buffer view's `byteOffset`/`byteLength`. If the backing `ArrayBuffer` is
  larger than the exact USB transfer body, the render worker can receive extra
  backing bytes and strip the wrong first 20 bytes before decoding.
- Patched conservatively:
  - `VideoData` now also stores `rawData`, the exact dongle video body including
    the 20-byte metadata header;
  - `CarplayService` forwards `viewToArrayBuffer(msg.rawData)`;
  - `Render.worker` is unchanged and still strips `vendorHeaderSize = 20`.
- This keeps the worker-visible protocol the same as before. It is intended to
  be behavior-preserving when USB buffers are exact and protective when they are
  not. Live video still needs a phone test.

### Touch-path note
- The pointer-capture touch fix is present but still gated behind
  `diagnosticPointerCaptureTouch=false`, so the deployed baseline does not
  change touch semantics. If baseline still feels laggy with no `[touch]
  slow-send`, flip this as a single isolated live A/B variable before changing
  the main USB queue again.

### History/audit note
- Another pass through history still points to this live A/B order:
  1. `41fb24f` visual cluster (`BackdropGlow`, huge blur, rounded
     clipping/overscan, drop-shadows, shadow ring);
  2. `87df7d0` / later `HomeView` overlay while streaming;
  3. only then deeper USB/touch changes if diagnostics show `[touch] slow-send`
     or missing OUT touch packets.

### Build / deploy verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build && npm run build:armLinux`.
- Restored and parsed `package.json` and parsed `package-lock.json` after the
  build.
- Verified the packaged `usb` native module is the Linux ARM64 ELF prebuild and
  no packaged `node_modules/usb/build` directory exists.
- Deployed to `/home/byron/round-carplay/round-carplay.AppImage` and rebooted.
- Verified final Pi state:
  - production autostart only has `--ignore-gpu-blocklist`;
  - port `4000` listening, `9222` closed;
  - `gps.service`, `cht-temp.service`, and `cpu-performance.service` active;
  - `throttled=0x0`;
  - config unchanged (`565x565`, `fps=45`, backdrop/ambient/plain/pointer
    diagnostics all false, `wifiType=5ghz`, `audioTransferMode=true`).

### Post-deploy observation
- Familiar boot-time Auto Box reset still happened:
  - enumerate `05:33:42`
  - disconnect `05:33:52`
  - re-enumerate `05:33:56`
  - app started CarPlay cleanly at `09:33:59Z`
- A 90 s post-reattach `dmesg -WT` watch produced no additional Auto Box
  events.
- No live phone test was possible, so video correctness and touch feel remain
  unverified until the phone is available.

## SESSION 14 (2026-06-11) — low-rate touch pipeline stats

Still no phone/live CarPlay stream available.

### Finding / fix
- Added sparse `touch stats` diagnostics in `CarplayService` so the next live
  test can separate three cases:
  - no stats while the user is dragging → renderer/preload/main is not receiving
    touch events;
  - stats show `received` increasing, `sending:true`, and little/no `sent` →
    an outgoing USB send is stuck or very slow;
  - stats show `received` and `sent/ok` increasing with no `[touch] slow-send`,
    but CarPlay still visually lags → touch is reaching the dongle and the delay
    is more likely phone/dongle/wireless response or video presentation.
- Stats are rate-limited to roughly once per second while touch events are
  flowing. They include `received`, `sent`, `ok`, `failed`, `coalesced`, `slow`,
  current `queued`, `sending`, and `lastAction`.
- This does not change touch behavior. It only adds low-rate diagnostics.

### Build / deploy verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build && npm run build:armLinux`.
- Restored and parsed `package.json` and parsed `package-lock.json` after the
  build.
- Verified packaged `usb` is the Linux ARM64 ELF prebuild and no packaged
  `node_modules/usb/build` directory exists.
- Deployed to `/home/byron/round-carplay/round-carplay.AppImage` and rebooted.
- Verified final Pi state:
  - production autostart only has `--ignore-gpu-blocklist`;
  - port `4000` listening, `9222` closed;
  - `gps.service`, `cht-temp.service`, and `cpu-performance.service` active;
  - `throttled=0x0`;
  - config unchanged (`565x565`, `fps=45`, backdrop/ambient/plain/pointer
    diagnostics all false, `wifiType=5ghz`, `audioTransferMode=true`).

### Post-deploy observation
- Familiar boot-time Auto Box reset still happened:
  - enumerate `05:40:46`
  - disconnect `05:40:56`
  - re-enumerate `05:41:00`
  - app started CarPlay cleanly at `09:41:02Z`
- A 90 s post-reattach `dmesg -WT` watch produced no additional Auto Box
  events.
- No live touch stats exist yet because the phone is not connected and nobody is
  touching the CarPlay surface.

## SESSION 15 (2026-06-11) — video stats + exact audio payload deploy

Still no phone/live CarPlay stream available. This session adds evidence hooks
for the next live test and fixes one more exact-byte-range boundary. Do not
claim the lag is fixed until the user tests with the phone connected.

### Finding / fix
- Added sparse main-process `[video] stats` diagnostics in `CarplayService`.
  While video frames flow, the diagnostics log now records roughly once per
  second: `frames`, `fps`, `bytes`, `kbps`, `maxGap`, `width`, and `height`.
  This is meant to correlate user-perceived lag with dongle/video starvation:
  if `maxGap` spikes or `fps` collapses during a hang, the incoming stream is
  stalling before the renderer; if video stays healthy while touch stats stay
  healthy, focus on phone/dongle/wireless response or presentation.
- Cleaned the stats windows so the first frame/touch starts a real one-second
  sample instead of logging a misleading near-zero first interval.
- Found the same backing-buffer assumption in `AudioData` that had already been
  fixed for video: PCM was created with `new Int16Array(data.buffer, 12)`,
  ignoring the `Buffer` view's `byteOffset` and exact length. Patched it to copy
  only the exact PCM payload range before audio IPC forwarding.
- The worker-visible video protocol is still unchanged: main forwards the exact
  dongle video body including the 20-byte metadata header, and `Render.worker`
  still strips `vendorHeaderSize = 20`.

### Build / deploy verification
- `npm run typecheck` passed after the video stats patch and again after the
  exact-audio patch.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build && npm run build:armLinux`.
- Restored and parsed `package.json` and parsed `package-lock.json` after each
  build.
- Verified the packaged `usb` native module is the Linux ARM64 ELF prebuild and
  no packaged `node_modules/usb/build` directory exists.
- Deployed to the correct autostart path:
  `/home/byron/round-carplay/round-carplay.AppImage`

### Final Pi state after deploy
- Boot time after the final intentional reboot: `2026-06-11 05:54:55 EDT`.
- Production autostart is clean:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- `gps.service`, `cht-temp.service`, and `cpu-performance.service` are active.
- `vcgencmd get_throttled` reports `0x0`; temp about `54.3 C`; `EXT5V` about
  `5.18 V`.
- Config remains baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.

### No-phone measurements / observations
- The familiar boot-time Auto Box reset still happened on the final boot:
  - enumerate `05:54:58`
  - disconnect `05:55:08`
  - re-enumerate `05:55:12`
  - app started CarPlay cleanly at `09:55:14Z`
- A 75 s post-reattach `dmesg -WT` watch produced no additional Auto Box or USB
  error lines.
- 15 s sensor-rate sample:
  `lean/pitch/gforce` about `9.47 Hz` each, GPS/GPS sky/status `1 Hz`,
  CHT/Pi temp about `0.47 Hz`, ambient about `0.13 Hz`.
- Settled `top` sample after boot showed the system mostly idle
  (`97.5-97.8%` idle in the later samples). The first top sample was higher
  immediately after boot and should not be overinterpreted.
- One unexplained reboot occurred after the first Session 15 diagnostics deploy
  while long SSH checks were running: the next boot started at
  `2026-06-11 05:49:19 EDT`. Persistent previous-boot journal is unavailable
  (`journalctl --list-boots` only had the current boot), so the cause is
  unknown. There was no evidence in the diagnostics log tying it to backdrop or
  live CarPlay; record it as a stability clue to watch, not a conclusion.

### Updated live-phone test plan
1. Start with the current baseline: backdrop off, ambient fill off, fps 45.
2. Tail `/home/byron/.config/round-carplay/diagnostics.log` while the user
   drags/pans CarPlay.
3. Interpret lag this way:
   - no `[touch] stats` while dragging: renderer/preload/main is not receiving
     touch events;
   - `[touch] stats` received increases but `sent/ok` stalls or
     `[touch] slow-send` appears: outgoing USB send path is slow/stuck;
   - `[video] stats` `maxGap` spikes or fps collapses during lag: dongle/video
     stream is starving before the renderer;
   - touch stats healthy and video stats healthy but user still feels lag:
     focus on phone/dongle/wireless response or compositor presentation.
4. Test backdrop on only after the baseline is characterized. If backdrop-on
   regresses or triggers `phone-unplugged`/USB resets, treat the backdrop as a
   separate visual/compositor problem.
5. If baseline still feels worse than the old plain-CarPlay diagnostic, A/B the
   hidden `HomeView` layer next by fully unmounting or `display:none` while
   streaming before changing more USB/touch logic.

## SESSION 16 (2026-06-11) — renderer long-task diagnostics + idle stability watch

Still no phone/live CarPlay stream available. This pass added one more live-test
diagnostic and completed another non-invasive no-phone stability window.

### Finding / fix
- Added renderer main-thread long-task diagnostics:
  - `App.tsx` installs a `PerformanceObserver` for `longtask` entries when the
    Chromium runtime supports it.
  - It logs throttled `[renderer] long-task` lines to
    `/home/byron/.config/round-carplay/diagnostics.log` for tasks >= 100 ms,
    including `count`, `max`, `total`, and route hash.
  - Main/preload got a narrow `renderer-diagnostics` IPC path for this log.
- This is meant to distinguish a renderer/UI-thread stall from a healthy
  renderer where touch/video diagnostics point elsewhere. If the user reports
  lag while gauges stay responsive and no `[renderer] long-task` appears, the
  renderer main thread is less likely to be the bottleneck.
- Finished the exact byte-range sweep for the mic/audio send path:
  - `CarplayService` now converts microphone `Buffer` chunks to an exact
    even-length `Int16Array`;
  - `SendAudio` now serializes the `Int16Array` using its exact
    `byteOffset`/`byteLength` instead of the whole backing buffer.
  - Current config has `audioTransferMode=true`, so this is not expected to
    affect the baseline lag path, but it removes the same bug class found in
    video/audio receive forwarding.

### Additional code/history audit
- Re-reviewed `41fb24f`, `4121d2d`, `d7acdb6`, and `008e6ec`.
- Current backdrop-off path is genuinely gated:
  - `<BackdropGlow />` is mounted only when `settings.backdropEnabled !== false`;
  - `Render.worker` now defaults `backdropEnabled=false`;
  - `Carplay.tsx` sends `set-backdrop=false` and clears the retained backdrop
    frame when backdrop/plain mode disables it.
- Current code has removed the riskiest always-on visual costs from the original
  backdrop cluster: gauge drop-shadows, center-square rounded clipping, live
  video rounded clipping, canvas overscan under a clipped parent, and the outer
  shadow ring.
- The remaining live A/B suspects are narrower:
  1. baseline touch/video/renderer diagnostics first;
  2. `BackdropGlow` compositor cost when enabled;
  3. the hidden `HomeView` overlay while streaming (opacity 0, transform,
     z-index 1300, pointer-events none). Its clock timer now stops while hidden,
     but the DOM/layer still exists above the center square.
- Settings save-button overlap appears addressed in current layout: arc hit
  zones use `pointerEvents:none` off the root route, and the center square rises
  above the arcs on non-root routes.

### Pre-deploy idle stability watch
- Ran a detached 20-sample idle watch over ~10 minutes before the final deploy.
- Result:
  - same boot throughout: `2026-06-11 05:54:55 EDT`;
  - port `4000` stayed listening and debug port `9222` stayed absent;
  - `throttled=0x0` throughout;
  - temp about `52-54 C`;
  - `EXT5V` stayed healthy, roughly `5.16-5.19 V`;
  - diagnostics tail did not advance beyond the known boot attach/start;
  - concurrent `dmesg -WT` USB watch produced `0` Auto Box / USB error lines.
- This supports the no-phone idle baseline being stable after the known
  boot-time Auto Box reset.

### Build / deploy verification
- `npm run typecheck` passed after the renderer diagnostics and exact-audio-send
  patches.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build && npm run build:armLinux`.
- Restored and parsed `package.json` and parsed `package-lock.json` after the
  build.
- Verified the packaged `usb` native module is the Linux ARM64 ELF prebuild and
  no packaged `node_modules/usb/build` directory exists.
- Deployed to `/home/byron/round-carplay/round-carplay.AppImage` and rebooted.

### Final Pi state after deploy
- Boot time after the final intentional reboot: `2026-06-11 06:09:38 EDT`.
- Production autostart is clean:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- `gps.service`, `cht-temp.service`, and `cpu-performance.service` are active.
- `vcgencmd get_throttled` reports `0x0`; temp about `54.3 C`; `EXT5V` about
  `5.19 V`.
- Config remains baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.

### Post-deploy observation
- Familiar boot-time Auto Box reset still happened:
  - enumerate `06:09:41/06:09:42`
  - disconnect `06:09:51`
  - re-enumerate `06:09:55/06:09:56`
  - app started CarPlay cleanly at `10:09:58Z`
- A 75 s post-reattach `dmesg -WT` watch produced no additional Auto Box or USB
  error lines.
- 15 s sensor-rate sample after final deploy matched prior baseline:
  `lean/pitch/gforce` about `9.47 Hz` each, GPS/GPS sky/status `1 Hz`,
  CHT/Pi temp about `0.47 Hz`, ambient about `0.13 Hz`.
- `top` after final deploy settled back to about `97%` idle after initial
  boot/sample activity.

### Live-phone log interpretation now available
During tomorrow's live test, tail diagnostics and classify a lag event with all
four signals:
- `[touch] stats` / `[touch] slow-send` for pointer-to-USB send health.
- `[video] stats` for incoming dongle/video starvation or frame gaps.
- `[renderer] long-task` for renderer main-thread stalls.
- `phone-unplugged`, `driver-failure`, and `[usb] dongle-detach` for logical or
  physical disconnect/reconnect paths.

## SESSION 17 (2026-06-11) — passive CDP verification of renderer diagnostics

Still no phone/live CarPlay stream available. This pass used the documented
autostart debug-flag method, then restored production autostart afterward.

### Pre-CDP production check
- Before enabling CDP, the unit was still on the final Session 16 boot
  (`2026-06-11 06:09:38 EDT`), with production autostart
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`,
  port `4000` open, and `9222` closed.
- No extra Auto Box kernel events had appeared after the known boot-time reset.
- Power/thermal remained healthy: `throttled=0x0`, temp about `53 C`, `EXT5V`
  about `5.18 V`; `gps.service`, `cht-temp.service`, and
  `cpu-performance.service` active.

### CDP probe
- Temporarily added:
  `--remote-debugging-port=9222 --remote-allow-origins=*`
  to `~/.config/autostart/round-carplay.desktop`, rebooted, waited for ports
  `4000` and `9222`, and ran `tools/perf/cdp_idle_probe.py` on the Pi.
- Probe results:
  - root idle 20 s: rAF avg `16.73 ms`, p99 `16.70 ms`, max `83.32 ms`
    (`2` gaps >20 ms), timer lag p99 `0.77 ms`, `0` long tasks;
  - settings route 15 s: one route-load long task, `122 ms`; rAF max
    `133.6 ms`; timer lag max `184.93 ms`;
  - root after returning 10 s: rAF avg `16.71 ms`, p99 `18.86 ms`, max
    `22.91 ms`, timer lag p99 `0.89 ms`, `0` long tasks.
- The new persistent renderer diagnostic path was proven end-to-end:
  diagnostics log recorded
  `[renderer] long-task {"count":1,"max":122,"total":122,"route":"#/settings"}`
  at the same settings-route event.
- Interpretation: the root/dashboard no-phone renderer path remains clean. The
  settings route still has a one-off load long task, but that is not evidence
  for a 5-8 second center-only CarPlay lag while driving. During live testing,
  absence/presence of `[renderer] long-task` during a reported lag is now useful
  evidence.

### Restored final state
- Removed the debug flags from autostart and rebooted back to production mode.
- Final boot after restoring production: `2026-06-11 06:19:31 EDT`.
- Verified final state:
  - autostart:
    `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`;
  - port `4000` listening;
  - debug port `9222` closed;
  - `gps.service`, `cht-temp.service`, and `cpu-performance.service` active;
  - `throttled=0x0`;
  - config still baseline (`565x565`, `fps=45`, `dpi=140`,
    backdrop/ambient/plain/pointer diagnostics all false, `wifiType=5ghz`,
    `audioTransferMode=true`).
- Familiar boot-time Auto Box reset still happened:
  - enumerate `06:19:34`
  - disconnect `06:19:44`
  - re-enumerate `06:19:48/06:19:49`
  - app started CarPlay cleanly at `10:19:51Z`
- A final 60 s post-reattach `dmesg -WT` watch produced no additional Auto Box
  or USB error lines.

## SESSION 18 (2026-06-11) — hidden center-layer cleanup deploy

Still no phone/live CarPlay stream available. This session removed two remaining
center-square layers from the non-idle/default path and re-verified the Pi.
Treat this as compositor/input-path cleanup, not a proven live CarPlay fix.

### Changes deployed
- `HomeView`: when the idle overlay is hidden (`showIdle=false`), it is now
  `display:none` instead of an invisible/scaled full center-square layer at
  `zIndex:1300`. Its clock interval also only runs while the idle overlay is
  shown.
- `App`: removed the always-mounted transparent center-square overlay that had
  been reserved for future border experiments (`zIndex:11`,
  `pointerEvents:none`). It was visually inert, but it still lived above the
  CarPlay square in the DOM/compositor stack.

### Build / deploy verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build` followed by
  `npm run build:armLinux`.
- Restored and parsed `package.json`, and parsed `package-lock.json`.
- Verified packaged `usb` ARM64 native file:
  `ELF 64-bit LSB shared object, ARM aarch64`.
- Verified no packaged `node_modules/usb/build` directory.
- Deployed AppImage hash:
  `b41de72f2f5e6b63286183f8efd30b2bcaea97176bdcd890ee483c5c8e39eddb`.

### No-phone CDP probe
- Used the autostart debug-flag method, ran `tools/perf/cdp_idle_probe.py`,
  then restored production autostart and rebooted.
- Root idle 20 s: rAF avg `16.75 ms`, p99 `16.71 ms`, timer lag p99
  `1.35 ms`, `0` long tasks.
- Settings route 15 s: one route-load long task, `103 ms`.
- Root after returning 10 s: rAF avg `16.66 ms`, p99 `16.71 ms`, timer lag p99
  `1.12 ms`, `0` long tasks.
- Interpretation: no-phone root/dashboard remains clean. This does not prove
  live CarPlay feel because there was no phone/video/touch round trip.

### Final Pi state
- Final production boot: `2026-06-11 06:33:02 EDT`.
- Autostart:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- `gps.service`, `cht-temp.service`, and `cpu-performance.service` active.
- `throttled=0x0`, temp about `54 C`, `EXT5V` about `5.19 V`.
- Config remains baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.
- Familiar boot-time Auto Box reset still happened on each intentional reboot,
  then the app started cleanly. The final boot sequence ended with CarPlay
  started at `10:33:22Z`.
- Final 60 s post-reattach `dmesg -WT` watch produced no additional Auto Box or
  USB error lines.

### Live-phone test next
Start with the current baseline (backdrop off, ambient fill off, fps 45) and
tail `/home/byron/.config/round-carplay/diagnostics.log`. A real lag event needs
classification against `[touch] stats` / `[touch] slow-send`, `[video] stats`,
`[renderer] long-task`, `phone-unplugged`, `driver-failure`, and physical
`[usb] dongle-detach` lines.

## SESSION 19 (2026-06-11) — gate hidden PCM/FFT work outside Info route

Still no phone/live CarPlay stream available. This session continued the
"normal route should be closer to plain CarPlay" cleanup.

### Finding
- `CarPlay.worker` always converted every audio chunk into mono `Float32Array`
  data and posted `pcmData` back to the renderer store for the FFT spectrum,
  even when the Info screen was not visible.
- That code is from the upstream baseline rather than a recent visual commit,
  so it is not a proven regression. It is still avoidable worker CPU,
  worker->renderer messaging, and Zustand store churn during normal CarPlay.

### Change deployed
- Added a typed `setPcmEnabled` message to `CarPlay.worker`.
- `Carplay.tsx` enables PCM/FFT extraction only while on `/info` and not in
  diagnostic plain mode.
- Audio playback still receives and pushes the original PCM into the ring
  buffers; only the hidden FFT visualization path is gated.

### Build / deploy verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build` followed by
  `npm run build:armLinux`.
- Restored and parsed `package.json`, and parsed `package-lock.json`.
- Verified packaged `usb` ARM64 native file:
  `ELF 64-bit LSB shared object, ARM aarch64`.
- Verified no packaged `node_modules/usb/build` directory.
- Deployed AppImage hash:
  `8f5f333ed3b27c1177f32402f5bf76a0c2bc735b208a1a5738bab3399fc0e4fb`.

### Final Pi state
- Final production boot: `2026-06-11 06:40:36 EDT`.
- Autostart:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- `gps.service`, `cht-temp.service`, and `cpu-performance.service` active.
- `throttled=0x0`, temp about `54 C`, `EXT5V` about `5.18 V`.
- Config remains baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.
- Familiar boot-time Auto Box reset still happened, then the app started
  cleanly at `10:40:56Z`.
- Final 120 s post-reattach `dmesg -WT` watch produced no additional Auto Box
  or USB error lines.

### No-phone measurements after deploy
- 20 s socket sample:
  - `lean`, `pitch`, `gforce`: about `9.45 Hz` each;
  - `gps`, `gps-status`, `gps-sky`: `1.0 Hz`;
  - `cht`, `pi-temp`: `0.5 Hz`;
  - `ambient`: `0.1 Hz`.
- 60 s process sample with no phone:
  - round-carplay process tree idled around `5.4-6.7%` summed CPU;
  - temp stayed about `52.7-54.9 C`;
  - `throttled=0x0` throughout.

### Live-phone test note
If the user tests while audio is active, this build removes hidden FFT work from
the normal CarPlay route. It still cannot be judged without a phone stream;
tail diagnostics during real lag events as described above.

## SESSION 20 (2026-06-11) — cache CarPlay touch bounds during drag

Still no phone/live CarPlay stream available. This pass tightened the renderer
touch path directly.

### Finding / change
- `useCarplayTouch` read `getBoundingClientRect()` for every pointer event,
  including every drag move.
- That layout read is small, and plain mode uses the same touch hook, so it is
  not a proven regression. But during real dragging it sits directly on the
  pointer-to-USB path and can force style/layout work when the dashboard is
  otherwise updating.
- Changed the hook to capture the CarPlay element rect on `pointerdown`, reuse
  it for move/up/out coordinates, and clear it after the press ends. Pointer
  capture diagnostic behavior is unchanged.

### Build / deploy verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build` followed by
  `npm run build:armLinux`.
- Restored and parsed `package.json`, and parsed `package-lock.json`.
- Verified packaged `usb` ARM64 native file:
  `ELF 64-bit LSB shared object, ARM aarch64`.
- Verified no packaged `node_modules/usb/build` directory.
- Deployed AppImage hash:
  `0d8451e988dd97c3e0266ca62a7c656cc515b892da7776d8b9d8b5ee57445bb8`.

### Final Pi state
- Final production boot: `2026-06-11 06:47:40 EDT`.
- Autostart:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- `gps.service`, `cht-temp.service`, and `cpu-performance.service` active.
- `throttled=0x0`, temp about `54 C`, `EXT5V` about `5.18 V`.
- Config remains baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.
- Familiar boot-time Auto Box reset still happened, then the app started
  cleanly at `10:48:00Z`.
- Final 90 s post-reattach `dmesg -WT` watch produced no additional Auto Box or
  USB error lines.

### No-phone measurements after deploy
- 15 s socket sample matched prior baseline:
  `lean/pitch/gforce` about `9.47 Hz`, GPS/GPS sky/status `1 Hz`,
  CHT/Pi temp about `0.47 Hz`, ambient about `0.07 Hz`.
- Short process sample after reboot showed round-carplay CPU settling from
  about `18.6%` to `11.7%` summed CPU with `throttled=0x0`; this was taken soon
  after boot and while probes were connected, so compare it cautiously to the
  longer idle samples from Session 19.

### Live-phone test note
This change reduces renderer work during real finger drags, but cannot be felt
or classified without the phone. During tomorrow's test, a lag event with no
`[renderer] long-task` and no `[touch] slow-send` would push suspicion away
from renderer/touch dispatch and toward phone/dongle/wireless presentation.

## SESSION 21 (2026-06-11) — make live backdrop explicit opt-in

Still no phone/live CarPlay stream available. This pass focused on the
backdrop/disconnect concern.

### Finding
- Several code paths still treated `backdropEnabled: undefined` as backdrop ON:
  App route gating, the worker `set-backdrop` command, the Settings checkbox,
  and `BackdropGlow` itself.
- The current Pi config already has `backdropEnabled:false`, so the deployed
  baseline was not accidentally using backdrop. But a fresh config, migrated
  config, or partial settings object could silently enable the expensive live
  backdrop path.

### Change deployed
- `loadConfig()` now writes `backdropEnabled:false` as a real default.
- App/worker/Settings/BackdropGlow now treat only
  `backdropEnabled === true` as ON.
- Updated stale comments so backdrop is described as explicit opt-in, not
  default-on.

### Build / deploy verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build` followed by
  `npm run build:armLinux`.
- Restored and parsed `package.json`, and parsed `package-lock.json`.
- Verified packaged `usb` ARM64 native file:
  `ELF 64-bit LSB shared object, ARM aarch64`.
- Verified no packaged `node_modules/usb/build` directory.
- Deployed AppImage hash:
  `230e7472bb501416e1b5e572bd763a3d5eef2e966329c6b9e2645e25ca447985`.

### Final Pi state
- Final production boot: `2026-06-11 06:53:37 EDT`.
- Autostart:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- `gps.service`, `cht-temp.service`, and `cpu-performance.service` active.
- `throttled=0x0`, temp about `52 C`, `EXT5V` about `5.19 V`.
- Config remains baseline and explicit:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.
- Familiar boot-time Auto Box reset still happened, then the app started
  cleanly at `10:53:57Z`.
- Final 90 s post-reattach `dmesg -WT` watch produced no additional Auto Box or
  USB error lines.

### Live-phone test note
If backdrop is toggled ON tomorrow, it is now definitely an explicit test of
the expensive backdrop path. Baseline/backdrop-off should not retain worker
frame taps or mount the blurred canvas when the setting is false or missing.

## SESSION 22 (2026-06-11) — gate backdrop work by actual visibility

Still no phone/live CarPlay stream available. This pass closed one more
backdrop-off escape hatch before the next live test.

### Finding
- Session 21 made backdrop an explicit opt-in, but when the setting was on the
  worker frame tap was still controlled mostly by the setting, not by whether
  the backdrop layer was actually visible.
- That meant settings/idle/plain/non-root routes could keep a hidden live
  backdrop path warmer than necessary during A/B testing.

### Change deployed
- `BackdropGlow` now uses `display:none` whenever it is not actually visible
  (`enabled && isStreaming && !homeMode`), not merely when the setting is off.
- `Carplay.tsx` now sends `set-backdrop:true` to the render worker only when
  all of these are true:
  `!diagnosticPlainCarplay`, root route, streaming, not home mode, and
  `backdropEnabled === true`.
- When disabled, the renderer clears the stored backdrop frame.

### Build / deploy verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build` followed by
  `npm run build:armLinux`.
- Restored and parsed `package.json`, and parsed `package-lock.json`.
- Verified packaged `usb` ARM64 native file:
  `ELF 64-bit LSB shared object, ARM aarch64`.
- Verified no packaged `node_modules/usb/build` directory.
- Deployed AppImage hash:
  `ae30be860fa749a30ad216ed61c4bf4e76dc8130d98f877e98ebc84666106ebb`.

### No-phone verification
- Pi was reached directly at `192.168.4.4` because `.local` mDNS was failing
  from the Mac; the Pi also had Wi-Fi at `192.168.4.8`.
- Production boot was clean: normal autostart, port `4000` open, port `9222`
  closed, `throttled=0x0`, baseline config unchanged.
- Final 90 s `dmesg -WT --follow` watch produced no additional Auto Box USB
  messages.
- Temporary CDP probe was run by the documented autostart-flag/reboot method,
  then flags were removed and the Pi was rebooted back to production-clean
  state.
- Passive no-phone CDP results:
  - root idle: 1199 rAF samples over 20 s, avg/p50/p95/p99 all about
    `16.67 ms`, max `18.92 ms`, no long tasks;
  - settings route: one route-load long task around `107 ms`;
  - root after settings: recovered to 60 Hz, no long tasks.

### Live-phone test note
This should make "backdrop off" a true no-backdrop baseline, and make
"backdrop on" an explicit live-stream-only test. It still cannot prove the
actual CarPlay touch feel without the phone.

## SESSION 23 (2026-06-11) — make diagnostics logging non-blocking

Still no phone/live CarPlay stream available. This pass reduced risk in the
diagnostic build itself.

### Finding
- `diagLog()` used synchronous `statSync`, `appendFileSync`, and occasional
  synchronous rotation from the Electron main process.
- The diagnostic calls are rate-limited, so this was not a proven root cause.
  But the Electron main process forwards CarPlay video/touch, and sync SD-card
  I/O is not something to leave in that path while investigating intermittent
  multi-second CarPlay stalls.

### Change deployed
- Reworked `src/main/diagnosticsLog.ts` to buffer log lines and flush with
  async `fs.appendFile`.
- Rotation is now async and checked at most every 5 seconds.
- Queue is capped so diagnostics cannot grow unbounded if the filesystem stalls.
- The log path and line format are unchanged:
  `/home/byron/.config/round-carplay/diagnostics.log`.

### Build / deploy verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build` followed by
  `npm run build:armLinux`.
- Restored and parsed `package.json`, and parsed `package-lock.json`.
- Verified packaged `usb` ARM64 native file:
  `ELF 64-bit LSB shared object, ARM aarch64`.
- Verified no packaged `node_modules/usb/build` directory.
- Deployed AppImage hash:
  `2cdd695fce69f55a4986655027e9375d4b23a6d679dd7e9332ace6d267a2785c`.

### Final Pi state
- Final production boot: `2026-06-11 07:18:05 EDT`.
- Autostart:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- AppImage hash on Pi matches the deployed hash above.
- `gps.service` and `cht-temp.service` active.
- `cpu-performance.service` reports inactive, but the actual CPU governor is
  `performance`.
- `throttled=0x0`, temp about `53.2 C`, `EXT5V` about `5.19 V`.
- Config remains baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.
- Diagnostics still write after the async logger change; latest clean start was
  logged at `2026-06-11T11:18:25Z`.
- Final 60 s `dmesg -WT --follow` watch produced no additional Auto Box USB
  messages.

### No-phone measurements
- 30 s socket sample:
  - `lean`, `pitch`, `gforce`: `9.47 Hz`;
  - `gps`, `gps-status`, `gps-sky`: `1.0 Hz`;
  - `cht`, `pi-temp`: `0.5 Hz`;
  - `ambient`: `0.07 Hz`.
- Short process sample after boot showed renderer around `2.7%`, browser/main
  around `2.2%`, and no swap usage.

### Current interpretation
- The strongest live evidence remains from Session 3: during user-perceived
  slow/hang periods, `usbmon` saw incoming dongle traffic starve even without a
  kernel USB disconnect. That points more toward dongle/session/protocol or
  wireless CarPlay delivery than toward graph/sensor React work.
- The risky visual regression cluster is still `41fb24f`: live backdrop,
  rounded/clipped center/video surfaces, gauge drop-shadows, and shadow ring.
  Current code now removes/gates those costs from the default baseline.
- Hidden graph rendering, history logging, HomeView idle work, hidden FFT work,
  and backdrop-off work are all now either naturally low-rate or gated.

### Live-phone test plan
When the user returns with the phone:
1. Keep baseline first: backdrop off, ambient fill off, `fps=45`,
   `diagnosticPlainCarplay=false`.
2. Tail diagnostics:
   `ssh -o ConnectTimeout=6 byron@192.168.4.4 "tail -f /home/byron/.config/round-carplay/diagnostics.log"`
3. During a real lag event, classify:
   - no `[touch] stats`: renderer/preload/main did not receive touch;
   - `[touch] stats` received increases but sent/ok stalls, or
     `[touch] slow-send`: USB OUT/dongle command consumption is blocked;
   - `[video] stats` fps drops or `maxGap` spikes: incoming video/dongle stream
     is starving;
   - `[renderer] long-task`: renderer main-thread stall;
   - all healthy but touch still feels delayed: phone/dongle/wireless or
     compositor presentation.
4. Only after baseline is characterized, turn backdrop on as a separate test.
   With the current code, backdrop should only mount and sample frames while the
   root CarPlay stream is visible.

## SESSION 24 (2026-06-11) — add dongle send/read timing diagnostics

Still no phone/live CarPlay stream available. This pass adds better evidence
for the next live test without changing USB protocol behavior.

### Finding
- The existing diagnostics could classify renderer long tasks, video cadence,
  and touch queue stalls.
- But if the dongle OUT endpoint stalls on non-touch messages
  (heartbeat/frame/wifi/audio/startup sends), the only direct evidence would be
  generic send errors or an indirect touch slow-send.
- Session 3's strongest evidence was incoming dongle traffic starvation during
  user-perceived lag. We also need to know whether USB OUT sends stay healthy
  at the same time.

### Change deployed
- `DongleDriver.send()` now records send timing by message type without adding
  timeouts or changing transfer behavior.
- New diagnostics:
  - `[dongle] send-slow`: any send over `50 ms` or failed send, throttled to
    at most once per second;
  - `[dongle] send-stats`: 5-6 s aggregate count/ok/failed/slow/bytes/max
    timing by type;
  - `[dongle] read-gap`: when an inbound dongle message arrives after a gap
    over `1000 ms`, logs the gap, message type, and length.
- This is intentionally observational only. It does not abort or reorder USB
  transfers, so it should not introduce a new reconnection behavior.

### Build / deploy verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build` followed by
  `npm run build:armLinux`.
- Restored and parsed `package.json`, and parsed `package-lock.json`.
- Verified packaged `usb` ARM64 native file:
  `ELF 64-bit LSB shared object, ARM aarch64`.
- Verified no packaged `node_modules/usb/build` directory.
- Deployed AppImage hash:
  `738b682222bc19916570227813e1a929c178d512f54f22219c8adeacf546b583`.

### Final Pi state
- Final production boot: `2026-06-11 07:24:36 EDT`.
- Autostart:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- AppImage hash on Pi matches the deployed hash above.
- `gps.service` and `cht-temp.service` active.
- CPU governor is `performance`.
- `throttled=0x0`, temp about `54.3 C`, `EXT5V` about `5.19 V`.
- Config remains baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.
- Final 60 s `dmesg -WT --follow` watch produced no additional Auto Box USB
  messages.
- Memory steady: about `887 MiB` used, `1.1 GiB` available, no swap used.

### No-phone observations after deploy
- Startup send diagnostics showed a few slow startup/setup sends while the
  dongle initialized, e.g. a `Command` send at `138 ms` and `SendFile` setup
  sends up to about `367 ms`. They completed successfully.
- After startup, steady-state heartbeat/frame-command sends were healthy:
  `[dongle] send-stats` showed `ok`, no failures, no slow sends, about 3 sends
  per 6 s, and max send time `0-1 ms`.
- No-phone `[dongle] read-gap` entries appeared after long idle gaps, including
  an unknown `0x25` zero-length message and a `Command`. That is expected-ish
  without a live CarPlay stream; during live testing, read gaps attached to
  `VideoData` or paired with video `maxGap` spikes would be more meaningful.

### Updated live-phone classification
During a real lag event, compare the new driver lines with the existing
touch/video/renderer lines:
- `[touch] stats` received but sent/ok stalls and `[dongle] send-stats` also
  slow/failed: USB OUT/dongle command consumption is blocked.
- `[touch] stats` sent/ok stays healthy and `[dongle] send-stats` stays healthy,
  but `[video] stats` maxGap/fps collapses or `[dongle] read-gap` appears:
  incoming dongle/video stream is starving.
- `[renderer] long-task` appears: renderer main thread stall.
- all of the above stay healthy while the user still feels lag: suspect
  phone/dongle/wireless presentation or compositor/display path.

## SESSION 25 (2026-06-11) - deploy quiet idle dongle diagnostics

Still no phone/live CarPlay stream available. This pass deployed the already
built follow-up that keeps the useful dongle send/read diagnostics but stops
logging boring heartbeat-only send stats forever while idle.

### Change deployed
- `DongleDriver` now only emits aggregate `[dongle] send-stats` when the window
  is interesting: failed sends, slow sends, more than 4 sends, or more than 128
  bytes.
- Individual `[dongle] send-slow` warnings still log immediately for slow or
  failed sends.
- `[dongle] read-gap` remains unchanged so the next live phone test can still
  catch incoming dongle/video starvation.

### Build / deploy verification
- This was the AppImage built after `npm run typecheck` and `git diff --check`
  passed.
- Built with `rm -rf node_modules/usb/build` followed by
  `npm run build:armLinux`.
- Restored and parsed `package.json`, and parsed `package-lock.json`.
- Verified AppImage is Linux ARM64.
- Verified packaged `usb` native file is Linux ARM64.
- Verified no packaged `node_modules/usb/build` directory.
- Deployed AppImage hash:
  `e5a3afaacb48c2c033af063b59deff4b5672b540b6f459045796f224a5be82ae`.

### Final Pi state
- Final production boot: `2026-06-11 07:30 EDT`.
- Autostart:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- AppImage hash on Pi matches the deployed hash above.
- `gps.service` and `cht-temp.service` active.
- CPU governor is `performance`.
- `throttled=0x0`, temp about `52.7 C`.
- Memory steady: about `885 MiB` used, `1.1 GiB` available, no swap used.
- Config remains baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.

### No-phone observations after deploy
- Boot/startup had one Auto Box USB detach/reattach during initialization:
  kernel `usb 3-1` disconnect at `07:30:20`, re-enumeration at `07:30:24`.
  No repeats were seen during the later idle watch.
- Startup still logged useful send timing:
  `[dongle] send-stats` for the startup burst (`count=19`, `bytes=62567`,
  `slow=4`, max `SendFile` around `412 ms`) plus two `send-slow` lines.
  These startup sends completed successfully.
- A 70 s idle watch produced no recurring heartbeat-only `[dongle] send-stats`
  spam after startup.
- The same idle watch logged two no-phone `[dongle] read-gap` entries:
  `30840 ms` before an unknown zero-length `0x25` message, then `2133 ms`
  before a small `Command`. This is useful context but not proof of a live
  lag bug; in no-phone idle, the dongle can simply be quiet.

### Morning phone-test priority
Use this deployed build as the baseline. Keep backdrop and ambient fill off
first, then tail:

`ssh -o ConnectTimeout=6 byron@192.168.4.4 "tail -f /home/byron/.config/round-carplay/diagnostics.log"`

During real lag, the highest-value evidence is whether touch/video/driver logs
line up with the user's feel:
- `[touch] stats` missing: input is not reaching renderer/preload/main.
- `[touch] stats` received but sent/ok stalls, especially with
  `[dongle] send-slow` or interesting `[dongle] send-stats`: USB OUT/dongle
  command delivery is blocked.
- `[video] stats` maxGap/fps collapses or `[dongle] read-gap` appears during a
  moving/live CarPlay stream: incoming dongle/video delivery is starving.
- `[renderer] long-task`: renderer main thread is blocked.
- Everything healthy while the screen still feels late: suspect
  phone/dongle/wireless session, compositor/presentation, or the display path.

## SESSION 26 (2026-06-11) - keep live video fresh under decoder/backlog stalls

Still no phone/live CarPlay stream available. This pass addressed a code path
that can explain the user's strongest symptom shape: gauges/graphs remain fast,
but the center CarPlay screen feels seconds late.

### Finding
- Preload queued every `carplay-video-chunk` and `carplay-audio-chunk` if the
  renderer handler was not attached yet, then replayed the whole queue later.
  That is fine for reliable file transfer, but bad for live CarPlay: stale
  frames should be dropped, not decoded seconds late.
- `Render.worker` fed every frame into `VideoDecoder.decode()` and never checked
  `decodeQueueSize`. If decode/draw fell behind briefly, especially with
  backdrop/compositor work, WebCodecs could build a stale queue. That can make
  the center video presentation late while React gauges stay responsive.

### Change deployed
- `src/preload/index.ts`
  - Removed live video/audio chunk queues.
  - If no handler is attached, live video/audio chunks are now dropped instead
    of replayed later.
- `src/renderer/src/components/worker/render/Render.worker.ts`
  - Added a freshness guard around `VideoDecoder.decodeQueueSize`.
  - Drops delta frames while the decoder queue is above 2.
  - If the queue reaches 10, resets the decoder to discard stale queued work and
    waits for/reconfigures from a fresh keyframe.
  - Rechecks SPS on keyframes so reset recovery can use the current stream
    config.
- `src/renderer/src/components/Carplay.tsx`
  - Forwards render-worker backlog diagnostics into the existing diagnostics
    log as:
    `[renderer] decoder-backlog`.

### Build / deploy verification
- `npm run typecheck` passed before the build.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build` followed by
  `npm run build:armLinux`.
- Restored and parsed `package.json`, and parsed `package-lock.json`.
- Verified AppImage is Linux ARM64.
- Verified packaged `usb` native file includes Linux ARM64 prebuild.
- Verified no packaged `node_modules/usb/build` directory.
- Deployed AppImage hash:
  `be779aa39e08e0ad9a8adba0aa4ed6ec178af1aa6f9a4b7d021286d699a00f11`.

### Final Pi state
- Final production boot: `2026-06-11 07:37 EDT`.
- Autostart:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- AppImage hash on Pi matches the deployed hash above.
- `gps.service` and `cht-temp.service` active.
- CPU governor is `performance`.
- `throttled=0x0`, temp about `54.3 C`.
- Memory steady: about `887 MiB` used, `1.1 GiB` available, no swap used.
- Config remains baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.

### No-phone observations after deploy
- Boot/startup again had one Auto Box detach/reattach during initialization:
  kernel `usb 3-1` disconnect at `07:37:51`, re-enumeration at `07:37:55`.
  No repeats were seen during the later idle watch.
- Startup send timing remained successful:
  `[dongle] send-stats` for startup burst (`count=19`, `bytes=62567`,
  `slow=4`, max `SendFile` around `353 ms`) plus one `send-slow` line.
- A 75 s idle watch produced no recurring heartbeat-only `[dongle] send-stats`
  spam and no additional kernel Auto Box USB messages.
- The same no-phone idle `read-gap` pattern appeared as before:
  about `30854 ms` before unknown zero-length `0x25`, then `2145 ms` before a
  small `Command`. Since this repeated with no phone connected and no video, it
  still looks like idle dongle silence rather than evidence of the lag bug.

### Morning phone-test priority
Use this deployed build as the baseline. Keep backdrop and ambient fill off
first. Tail diagnostics:

`ssh -o ConnectTimeout=6 byron@192.168.4.4 "tail -f /home/byron/.config/round-carplay/diagnostics.log"`

New thing to watch for:
- `[renderer] decoder-backlog`: the render worker caught stale video backlog and
  dropped/reset to keep the center stream fresh. If the user feels a lag event
  and this line appears, decoder/compositor backlog was likely part of it.

If lag still happens without `[renderer] decoder-backlog`, use the existing
classification:
- `[touch] stats` missing: input is not reaching renderer/preload/main.
- `[touch] stats` received but sent/ok stalls, especially with
  `[dongle] send-slow` or interesting `[dongle] send-stats`: USB OUT/dongle
  command delivery is blocked.
- `[video] stats` maxGap/fps collapses or `[dongle] read-gap` appears during a
  moving/live CarPlay stream: incoming dongle/video delivery is starving.
- Everything healthy while the center still feels late: suspect
  phone/dongle/wireless session, compositor/presentation, or display path.

## SESSION 27 (2026-06-11) - drop stale worker-queue video before decode

Still no phone/live CarPlay stream available. This pass extends Session 26's
freshness guard. Session 26 dropped stale work once frames reached WebCodecs,
but there could still be an old MessagePort queue between renderer and render
worker after a worker/compositor stall.

### Finding
- The center CarPlay video can lag while gauges stay responsive if stale video
  frames accumulate anywhere in the live media path.
- Session 26 handled `VideoDecoder.decodeQueueSize`, but worker message queue
  backlog can exist before `processRaw()` calls `VideoDecoder.decode()`.
- Live CarPlay should prefer the newest frame over faithfully decoding old
  frames. A 5-second backlog should be skipped, not displayed 5 seconds late.

### Change deployed
- `src/main/carplay/CarplayService.ts`
  - `sendChunked()` now stamps each live media packet with `sentAt`.
- `src/renderer/src/components/Carplay.tsx`
  - Forwards `sentAt` with each reassembled video frame to `Render.worker`.
- `src/renderer/src/components/worker/render/Render.worker.ts`
  - Accepts `{ buffer, sentAt }` messages on the video port.
  - Drops video frames older than `500 ms` before parsing H.264 or feeding
    WebCodecs.
  - Logs stale drops as `[renderer] stale-video-drop` with drop count and age.
- The Session 26 decoder guard is still present:
  `[renderer] decoder-backlog` if WebCodecs itself backs up.

### Build / deploy verification
- `npm run typecheck` passed before the build and again after deployment.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build` followed by
  `npm run build:armLinux`.
- Restored and parsed `package.json`, and parsed `package-lock.json`.
- Verified AppImage is Linux ARM64.
- Verified packaged `usb` Linux ARM64 prebuild.
- Verified no packaged `node_modules/usb/build` directory.
- Deployed AppImage hash:
  `f3be8d08dba1556b4ea4e9a740101e1e5faf47578eb5d10793252b7a086beb81`.

### Final Pi state
- Final production boot: `2026-06-11 07:43 EDT`.
- Autostart:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- AppImage hash on Pi matches the deployed hash above.
- `gps.service` and `cht-temp.service` active.
- CPU governor is `performance`.
- `throttled=0x0`, temp about `53.8 C`.
- Memory steady: about `885 MiB` used, `1.1 GiB` available, no swap used.
- Config remains baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.

### No-phone observations after deploy
- Boot/startup again had one Auto Box detach/reattach during initialization:
  kernel `usb 3-1` disconnect at `07:43:59`, re-enumeration at `07:44:03`.
  No repeats were seen during the later idle watch.
- Startup send timing remained successful:
  `[dongle] send-stats` for startup burst (`count=19`, `bytes=62567`,
  `slow=4`, max `SendFile` around `337 ms`) plus one `send-slow` line.
- A 75 s idle watch produced no recurring heartbeat-only `[dongle] send-stats`
  spam and no additional kernel Auto Box USB messages.
- The same no-phone idle `read-gap` pair repeated:
  about `30351 ms` before unknown zero-length `0x25`, then `2150 ms` before a
  small `Command`.
- No stale-video or decoder-backlog logs are expected without a phone/video
  stream.

### Morning phone-test priority
Use this deployed build as the baseline. Keep backdrop and ambient fill off
first. Tail diagnostics:

`ssh -o ConnectTimeout=6 byron@192.168.4.4 "tail -f /home/byron/.config/round-carplay/diagnostics.log"`

New renderer clues:
- `[renderer] stale-video-drop`: video frames were already too old by the time
  the render worker saw them, so it skipped them to catch up to live.
- `[renderer] decoder-backlog`: WebCodecs decode queue backed up, so the worker
  dropped delta frames or reset to avoid stale presentation.

Interpret those with the existing driver clues:
- If lag improves but these lines appear, the fix is actively preventing stale
  center-video backlog.
- If lag persists and these lines appear repeatedly, the center path is still
  under decode/compositor pressure.
- If lag persists without these lines, look harder at USB IN starvation,
  USB OUT/touch send stalls, phone/dongle/wireless session behavior, or display
  presentation.

## SESSION 28 (2026-06-11) - remove synchronous media sidecar writes from hot path

Still no phone/live CarPlay stream available. This pass removed another
main-process stall candidate: synchronous disk I/O while handling CarPlay
metadata messages.

### Finding
- `CarplayService` handled every `MediaData` message by synchronously reading
  `mediaData.json`, merging metadata/album art, and synchronously writing the
  file back out.
- If the dongle/phone sends playback-time metadata repeatedly, SD-card I/O here
  can block the Electron main process. That same main process forwards CarPlay
  video chunks and touch commands, so a disk hiccup can affect the center
  CarPlay path while React gauges remain responsive.

### Change deployed
- `src/main/carplay/CarplayService.ts`
  - Media payload is cached after the first read.
  - `mediaData.json` writes are now async via `fs.promises.writeFile`.
  - Writes are debounced/coalesced to the latest payload instead of writing
    every metadata packet synchronously.
  - Slow media writes over `50 ms` log as `[media] write-slow`; write failures
    log as `[media] write-error`.
- Renderer media events still fire immediately; only the sidecar JSON
  persistence moved off the main hot path.

### Build / deploy verification
- `npm run typecheck` passed before the build and again after deployment.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build` followed by
  `npm run build:armLinux`.
- Restored and parsed `package.json`, and parsed `package-lock.json`.
- Verified AppImage is Linux ARM64.
- Verified packaged `usb` Linux ARM64 prebuild.
- Verified no packaged `node_modules/usb/build` directory.
- Deployed AppImage hash:
  `c05e9f7ce09bc58e1d305cfb7706d401e87a48b8c48039a2779391fdd3dc117e`.

### Final Pi state
- Final production boot: `2026-06-11 07:49 EDT`.
- Autostart:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- AppImage hash on Pi matches the deployed hash above.
- `gps.service` and `cht-temp.service` active.
- CPU governor is `performance`.
- `throttled=0x0`, temp about `53.8 C`.
- Memory steady: about `886 MiB` used, `1.1 GiB` available, no swap used.
- Config remains baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.

### No-phone observations after deploy
- Boot/startup again had one Auto Box detach/reattach during initialization:
  kernel `usb 3-1` disconnect at `07:49:48`, re-enumeration at `07:49:52`.
  No repeats were seen during the later idle watch.
- Startup send timing remained successful:
  `[dongle] send-stats` for startup burst (`count=19`, `bytes=62567`,
  `slow=4`, max `SendFile` around `364 ms`) plus two `send-slow` lines.
- A 75 s idle watch produced no recurring heartbeat-only `[dongle] send-stats`
  spam and no additional kernel Auto Box USB messages.
- The same no-phone idle `read-gap` pair repeated:
  about `33758 ms` before unknown zero-length `0x25`, then `2068 ms` before a
  small `Command`.
- No `[media] write-slow`/`write-error` logs are expected without a phone
  sending media metadata.

### Morning phone-test priority
Use this deployed build as the baseline. Keep backdrop and ambient fill off
first. Tail diagnostics:

`ssh -o ConnectTimeout=6 byron@192.168.4.4 "tail -f /home/byron/.config/round-carplay/diagnostics.log"`

New media clue:
- `[media] write-slow`: metadata sidecar persistence is slow, but it should now
  be async and should not block the live video/touch path.

Existing renderer clues remain:
- `[renderer] stale-video-drop`: render worker skipped stale queued video.
- `[renderer] decoder-backlog`: WebCodecs decode queue backed up.

If the user still feels lag with no renderer/media/touch/dongle warnings, the
remaining evidence points away from local React/gauge load and toward USB IN
starvation, phone/dongle/wireless session behavior, compositor/presentation, or
the display path.

## SESSION 29 (2026-06-11) - reduce main-process media copy pressure

Still no phone/live CarPlay stream available. This pass reduced avoidable
per-frame memory copy work in the Electron main process while forwarding live
CarPlay video/audio to the renderer.

### Finding
- The current diagnostic/freshness build had already fixed exact byte ranges,
  but `CarplayService` still copied live video into a fresh exact `ArrayBuffer`
  before chunking, then sliced that buffer again for IPC.
- That extra copy work is not expected to explain multi-second hangs alone, but
  it lives on the same Electron main process that forwards video/touch. Reducing
  copy pressure gives more headroom, especially if backdrop/compositor pressure
  or metadata writes also occur.

### Change deployed
- `src/main/carplay/CarplayService.ts`
  - `sendChunked()` now accepts `ArrayBuffer` or any `ArrayBufferView`.
  - Video forwards `msg.rawData` directly instead of first copying it through
    `viewToArrayBuffer()`.
  - Audio forwards its `Int16Array` directly instead of first copying it through
    `viewToArrayBuffer()`.
  - Chunk payloads are `Buffer` views over the original source range instead of
    additional `ArrayBuffer.slice()` copies.
- Renderer chunk handling was already compatible with `ArrayBufferView`
  payloads, so no renderer change was needed in this pass.

### Build / deploy verification
- `npm run typecheck` passed before the build and again after deployment.
- `git diff --check` passed.
- Built with `rm -rf node_modules/usb/build` followed by
  `npm run build:armLinux`.
- Restored and parsed `package.json`, and parsed `package-lock.json`.
- Verified AppImage is Linux ARM64.
- Verified packaged `usb` Linux ARM64 prebuild.
- Verified no packaged `node_modules/usb/build` directory.
- Deployed AppImage hash:
  `d71ada1f4970a35c5e0a964218c203e0c9b7ad0f80649a652ffafe1ca8285688`.

### Final Pi state
- Final production boot: `2026-06-11 07:55 EDT`.
- Autostart:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- AppImage hash on Pi matches the deployed hash above.
- `gps.service` and `cht-temp.service` active.
- CPU governor is `performance`.
- `throttled=0x0`, temp about `52.1 C`.
- Memory steady: about `889 MiB` used, `1.1 GiB` available, no swap used.
- Config remains baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.

### No-phone observations after deploy
- Boot/startup again had one Auto Box detach/reattach during initialization:
  kernel `usb 3-1` disconnect at `07:55:17`, re-enumeration at `07:55:21`.
  No repeats were seen during the later idle watch.
- Startup send timing remained successful:
  `[dongle] send-stats` for startup burst (`count=19`, `bytes=62567`,
  `slow=4`, max `SendFile` around `352 ms`) plus one `send-slow` line.
- A 75 s idle watch produced no recurring heartbeat-only `[dongle] send-stats`
  spam and no additional kernel Auto Box USB messages.
- The same no-phone idle `read-gap` pair repeated:
  about `30696 ms` before unknown zero-length `0x25`, then `2112 ms` before a
  small `Command`.
- The only kernel line during the watch was journald rotating after time sync;
  no Auto Box reset/disconnect occurred after boot.

### Morning phone-test priority
Use this deployed build as the baseline. Keep backdrop and ambient fill off
first. Tail diagnostics:

`ssh -o ConnectTimeout=6 byron@192.168.4.4 "tail -f /home/byron/.config/round-carplay/diagnostics.log"`

The most useful live evidence remains:
- `[renderer] stale-video-drop`: render worker skipped stale queued video.
- `[renderer] decoder-backlog`: WebCodecs decode queue backed up.
- `[media] write-slow`: media sidecar write was slow, now async.
- `[touch] stats` / `[touch] slow-send`: input reached main, then either sent
  normally or stalled on USB OUT.
- `[video] stats` / `[dongle] read-gap`: incoming dongle/video delivery starved.
- `[dongle] send-slow` / interesting `[dongle] send-stats`: USB OUT command
  path stalled.

## SESSION 30 (2026-06-11) - no-phone follow-up audit, not deployed

Still no phone/live CarPlay stream available, so this pass does not prove the
real touch/video feel. The Pi was checked non-invasively and left running the
Session 29 deployed AppImage.

### Current Pi state checked
- AppImage hash still:
  `d71ada1f4970a35c5e0a964218c203e0c9b7ad0f80649a652ffafe1ca8285688`.
- Production autostart is still:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- Port `4000` is listening; debug port `9222` is closed.
- `throttled=0x0`; temp about `53 C`.
- CPU governor remains `performance`, with all cores at `2.4 GHz`.
- No new kernel Auto Box USB disconnects appeared after the familiar boot-time
  reset. The only fresh diagnostic event during idle was a long no-phone
  `[dongle] read-gap`, which is expected when no phone is connected/streaming.

### Audit notes
- Rechecked the always-on paths. Hidden graph views are still conditional,
  audio FFT/PCM work is route-gated to `/info`, and sensor event rates remain
  modest (`lean`/`pitch`/`gforce` about `9.5 Hz`, GPS about `1 Hz`, CHT/Pi temp
  about `0.5 Hz`). This still does not support sensors/graph history as a
  multi-second center-only lag cause.
- Rechecked diagnostics noise. The repeated heartbeat-only `[dongle] send-stats`
  lines seen in older log tails were stale from earlier deploys; the current
  settled build is quiet except for expected no-phone read gaps.
- `WebRTCDecoder.ts` is currently unused by the render worker despite the
  `useWebRTC` init field. Do not chase it as a live-path cause unless the worker
  is changed to instantiate it.

### Local-only change made after Session 29
- `src/renderer/src/App.tsx`: the backdrop React/CSS layer now mounts only on
  the root dashboard route (`routeIsRoot && backdropEnabled`). The render worker
  already disables backdrop frame sampling off-root; this makes the visible CSS
  layer follow the same gate so Settings/Info/Camera do not carry backdrop
  filter/compositor cost while backdrop is enabled.
- This change has **not** been deployed to the Pi yet.

### Verification
- `npm run typecheck` passed.
- `git diff --check` passed.
- `package.json` and `package-lock.json` parse.

### Next live-phone test remains unchanged
Start with the deployed baseline: backdrop off, ambient fill off, fps 45.
Tail diagnostics while the user drags/pans CarPlay:

`ssh -o ConnectTimeout=6 byron@192.168.4.4 "tail -f /home/byron/.config/round-carplay/diagnostics.log"`

Only after the backdrop-off path is characterized should backdrop be enabled.
If backdrop-on causes lag mainly while opening/using settings, deploy the
Session 30 route-gate change before deeper USB/render changes.

## SESSION 31 (2026-06-11) - 5-minute closeout

No further behavior changes or Pi changes were made in this closeout. The
worktree is still intentionally dirty with prior-session changes, plus untracked
handoff/diagnostic/perf helper files.

Current important local-only change:
- `src/renderer/src/App.tsx`: backdrop React/CSS layer is gated to the root
  dashboard route only. This is **not deployed**.

Closeout verification:
- `git diff --check` produced no whitespace errors.
- `HANDOFF.md` already contains the latest Pi state, deployed AppImage hash, and
  next live-phone test plan from Session 30.

Do not call the lag fixed yet. The remaining blocker is live phone CarPlay
testing with diagnostics tailing. Start with backdrop off, ambient fill off,
fps 45, then only test backdrop after the baseline is characterized.

## SESSION 32 (2026-06-11) - continued no-phone audit, local worker safety fix

No Pi runtime changes and no deploy were made in this session. Phone/live
CarPlay was still unavailable, so the lag is still not proven fixed.

### Pi state rechecked
- App still running on port `4000`; debug port `9222` remains closed.
- Autostart still uses:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- AppImage hash still:
  `d71ada1f4970a35c5e0a964218c203e0c9b7ad0f80649a652ffafe1ca8285688`.
- `throttled=0x0`, temp about `52.7 C`.
- Kernel log still only shows the known boot-time Auto Box disconnect/reconnect
  at `07:55`; no repeating kernel USB disconnects since then.
- Config remains performance baseline:
  `565x565`, `fps=45`, `dpi=140`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `diagnosticPointerCaptureTouch=false`, `wifiType=5ghz`,
  `audioTransferMode=true`.

### Code review findings
- Git history still points to `41fb24f` as the big visual/perf regression
  cluster: live backdrop frame sampling, heavy CSS blur, rounded/clipped center
  square/video, overscan, shadows, and transparent center compositing.
- Current code has removed or gated most baseline costs from that cluster:
  backdrop is explicit opt-in, worker backdrop defaults off, the live CarPlay
  canvas is flat/unclipped again, arc drop-shadows are gone, hidden graphs are
  conditional, graph history is throttled to 1 Hz/metric, and audio PCM/FFT work
  is route-gated to `/info`.
- Backdrop-on is still an expensive path by design: the render worker samples
  the just-drawn canvas about 5 Hz and posts ImageBitmaps, then `BackdropGlow`
  paints a 192px canvas with canvas blur plus a small CSS blur/filter. This can
  plausibly worsen an already marginal stream, but it does not explain
  backdrop-off baseline lag by itself.
- The current touch/video diagnostics are the right next proof point. Serialized
  USB OUT sends mean touch is safer for the dongle but any slow heartbeat/frame/
  control send can now show up as touch delay; `[touch] slow-send`,
  `[dongle] send-slow`, and `[video] stats` should distinguish that from
  incoming dongle/video starvation or renderer decode backlog.
- Previous live evidence from earlier sessions remains strongest for baseline
  lag: incoming USB/video starvation without a kernel detach. Keep that as the
  leading hypothesis until diagnostics during a live phone drag contradict it.

### Local-only change made
- `src/renderer/src/components/worker/render/Render.worker.ts` now posts
  `render-ready` only after renderer capability selection has completed and a
  concrete renderer has been created.
- The same worker now closes decoded `VideoFrame`s if one somehow arrives before
  a renderer exists. This avoids a startup/reconnect window where video could be
  forwarded, decoded, then not drawn or closed.
- This is a safety/risk-reduction fix, **not deployed** and not proof of the
  user's intermittent lag.

### Verification
- `npm run typecheck` passed.
- `npm run build` passed.
- `git diff --check` passed.
- `package.json` and `package-lock.json` parse.

### Next live-phone test
Start with backdrop off, ambient fill off, fps 45. Tail diagnostics while the
user drags/pans CarPlay:

`ssh -o ConnectTimeout=6 byron@192.168.4.4 "tail -f /home/byron/.config/round-carplay/diagnostics.log"`

Interpretation priority:
- `[touch] stats` absent during drag: touch is not reaching renderer/preload/main.
- `[touch] slow-send` or low sent/ok counts: USB OUT touch path is blocked/slow.
- `[video] stats` fps drop or maxGap spike, plus `[dongle] read-gap`: incoming
  dongle/video starvation.
- `[renderer] stale-video-drop` or `decoder-backlog`: renderer/decoder could not
  keep up and is now shedding stale work.
- `[renderer] long-task`: renderer main thread stall.
- If all diagnostics stay healthy but the center still feels laggy, suspect the
  phone/dongle/wireless/compositor/display path rather than React gauges.

## SESSION 33 (2026-06-11) - continued no-phone audit, avoid live USB info poke

No Pi runtime changes and no deploy were made in this session. Phone/live
CarPlay was still unavailable, so the lag remains unproven.

### Pi state rechecked
- App still running on port `4000`; debug port `9222` remains closed.
- Autostart still uses:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`
- `throttled=0x0`, temp about `53.2 C`.
- Diagnostics remain quiet except for expected no-phone `[dongle] read-gap`
  entries. No new physical Auto Box detach/re-attach was observed in this
  check.

### Code review finding
- `Info.tsx` calls `window.carplay.usb.getDeviceInfo()` when the adapter is
  connected. `USBService.getDongleInfo()` opened the USB device and read string
  descriptors. That is fine while idle, but while CarPlay is active the WebUSB
  driver already owns the adapter; probing it from the Info screen could create
  avoidable USB contention or a close/open side effect near an active session.
- This is not the main backdrop or center-lag cause, but it is a real adapter
  stability risk and is aligned with the user's "dongle occasionally
  disconnecting" concern.

### Local-only change made
- `src/main/carplay/CarplayService.ts`: added `isActive()` so other main-process
  code can tell when CarPlay is started or starting.
- `src/main/usb/USBService.ts`: `getDongleInfo()` now skips opening/closing the
  USB device while CarPlay is active. It returns descriptor-level IDs/firmware
  and logs `[usb] device-info-skipped-active-carplay` instead.
- `src/renderer/src/components/Info.tsx`: preserves existing device-info fields
  when the safe active-session response has blank string descriptors, and now
  tolerates a null-ish stub response.
- This is **not deployed**.

### Verification
- `npm run typecheck` passed.
- `npm run build` passed.
- `git diff --check` passed.
- `package.json` and `package-lock.json` parse.

### Next live-phone test
Same as Session 32: baseline first with backdrop off, ambient fill off, fps 45,
tail diagnostics during real touch/drag, then test backdrop only after the
baseline path is characterized.

## SESSION 34 (2026-06-11) - continued no-phone audit, stale buffer hardening

No Pi runtime changes and no deploy were made in this session. Phone/live
CarPlay was still unavailable, so the lag remains unproven.

### Pi state rechecked
- App still running on port `4000`; debug port `9222` remains closed.
- `throttled=0x0`, temp about `52.7 C`.
- Memory remains comfortable: about `863 MiB` used, `1144 MiB` available, no
  swap used.
- Diagnostics remain quiet except for expected no-phone `[dongle] read-gap`
  entries.

### Code review finding
- `Carplay.tsx` reassembles chunked video packets in a `Map`, but partial
  multi-chunk packets previously had no age or count cap. Most CarPlay H.264
  frames are likely single chunk with the current `512 KiB` chunk size, so this
  is not the leading lag cause. Still, if a stream disruption ever left a
  partial chunk behind, the renderer could accumulate stale half-frames over a
  long session.
- `CarPlay.worker.ts` could also queue audio buffers while waiting for a player
  for a given decode/audio type. Known types should resolve quickly, but unknown
  decode types had no useful recovery path.

### Local-only change made
- `src/renderer/src/components/Carplay.tsx`: partial video reassembly entries
  now have a `createdAt` timestamp, are pruned after `2 s`, and are capped at
  four pending packets.
- `src/renderer/src/components/worker/CarPlay.worker.ts`: unknown audio
  `decodeType`s are dropped instead of queued, and per-key pending audio is
  capped at 12 buffers until the renderer supplies the ring buffer.
- This is **not deployed**.

### Verification
- `npm run typecheck` passed.
- `npm run build` passed.
- `git diff --check` passed.
- `package.json` and `package-lock.json` parse.

### Next live-phone test
Unchanged: baseline first with backdrop off, ambient fill off, fps 45, tail
diagnostics during real touch/drag, then test backdrop only after baseline is
characterized.

## SESSION 35 (2026-06-11) - continued no-phone audit, baseline comparison

No Pi runtime changes and no deploy were made in this session. Phone/live
CarPlay was still unavailable, so the lag remains unproven.

### Current Pi state rechecked
- Running AppImage hash matches local `dist/round-carplay-0.1.0-arm64.AppImage`:
  `d71ada1f4970a35c5e0a964218c203e0c9b7ad0f80649a652ffafe1ca8285688`.
- App is listening on port `4000`; debug port `9222` is closed.
- Autostart remains clean:
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`.
- Current config remains the test baseline: `565x565`, `fps=45`, `dpi=140`,
  `backdropEnabled=false`, `ambientFillEnabled=false`,
  `diagnosticPlainCarplay=false`, `diagnosticPointerCaptureTouch=false`,
  `wifiType=5ghz`, `audioTransferMode=true`.
- `throttled=0x0`, temp about `53.2 C`, memory comfortable, no swap used.
- `gps.service`, `cht-temp.service`, and `cpu-performance.service` are active.

### Passive Pi findings
- Current boot had the familiar early Auto Box reset only:
  enumerate at `07:55:06`, disconnect at `07:55:16`, re-enumerate at `07:55:20`.
  There were no later kernel `usb 3-1` disconnects in the current boot.
- Persistent diagnostics since the current boot show the same early detach/attach,
  startup sends, then no `phone-unplugged`, no `driver-failure`, no touch stats,
  and no video stats because the phone is absent.
- Sensor socket rates measured over 10 s: `lean`/`pitch`/`gforce` about `9.5 Hz`
  each, GPS/GPS sky/status about `1 Hz`, CHT/Pi temp about `0.5 Hz`, ambient
  about `0.1 Hz`.

### Local validation
- `npm run typecheck` passed.
- `npm run build` passed.
- `git diff --check` passed.
- `package.json` and `package-lock.json` parse.

### Code/history findings
- The old simple baseline (`0eddd7d`) was a much smaller UI: centered CarPlay
  square plus a simple speed placeholder, with none of the current gauge/graph/
  backdrop compositor work.
- The likely regression cluster remains `41fb24f`: it added live backdrop
  sampling, a full-display blurred/scaled backdrop canvas, rounded/clipped center
  square, rounded/clipped/overscanned video canvas, arc drop-shadows, and a
  center shadow ring in one commit.
- Current local code has already moved back toward the fast baseline in the
  important places: backdrop is explicit opt-in, the React backdrop layer only
  mounts on the root route, the render worker backdrop tap is off unless the
  backdrop is actually visible, the center square/video are flat and unclipped
  in normal mode, hidden graphs are conditional, and idle/home timers stop when
  hidden.
- Hidden graphs are not painting while closed. Graph history logging is always
  on, but `dataLog.ts` throttles to one sample per second per metric. This still
  does not look like a multi-second center-only lag mechanism.
- `diagnosticPlainCarplay` is the cleanest A/B switch currently in the tree. It
  removes overlay rendering, nav, routes, graphs, backdrop, camera detection,
  and the worker backdrop tap from the visible test surface. It still leaves the
  module-level sensor socket listeners alive, so it is not a perfect copy of the
  very first app, but it is a strong compositor/UI isolation test.

### Next live-phone test interpretation
1. Normal mode first: backdrop off, ambient fill off, fps 45. Tail:
   `tail -f /home/byron/.config/round-carplay/diagnostics.log`.
2. If normal mode lags, enable `diagnosticPlainCarplay=true` in config and
   reboot for the same drag/pan test.
3. If plain mode is much better, keep simplifying the normal dashboard
   compositor path around the center square.
4. If plain mode still has multi-second stalls, stop chasing gauges/backdrop and
   focus on CarPlay transport/input/video: `[touch] slow-send`, `[touch] stats`,
   `[video] stats maxGap`, `[dongle] read-gap`, `phone-unplugged`, and
   `driver-failure`.
5. If backdrop-on causes a visible disconnect but `dmesg` has no matching USB
   disconnect, treat it as a logical phone/dongle/wireless session drop rather
   than physical USB detach.

## SESSION 36 (2026-06-11) - touch queue age instrumentation

No Pi runtime changes and no deploy were made in this session. Phone/live
CarPlay was still unavailable.

### Code review finding
- Existing touch diagnostics logged send duration and queue length, but not the
  age of the touch command being sent. That left a blind spot for the user's
  symptom: an apparently responsive dashboard with stale CarPlay touches being
  delivered seconds late.
- The current touch move coalescing should prevent unbounded move buildup, but a
  slow in-flight USB send can still make the latest queued touch stale. We need
  to distinguish "USB transfer itself was slow" from "touch waited in the queue
  behind another send."

### Local-only change made
- `src/main/carplay/CarplayService.ts`: touch queue entries now carry `queuedAt`.
- `[touch] slow-send` now includes `ageMs` in addition to USB send `elapsed`.
- `[touch] stats` now includes `maxAgeMs` and `maxQueueDepth`, and the `slow`
  counter increments for either slow USB transfer time or stale queue age.
- This is diagnostic instrumentation only; it does not change the queue policy
  or deploy anything to the Pi.

### Verification
- `npm run typecheck` passed.
- `npm run build` passed.
- `git diff --check` passed.
- `package.json` and `package-lock.json` parse.

### Next live-phone interpretation update
- During a real drag/pan stall, if `[touch] stats maxAgeMs` grows into hundreds
  or thousands of milliseconds, the center lag is at least partly queued/stale
  touch commands before USB send completion.
- If `maxAgeMs` stays low while `[video] stats maxGap` or `[dongle] read-gap`
  spikes, the touch path is probably fine and the visible lag is incoming
  video/dongle/phone transport starvation.
- If both stay healthy while the user still sees lag, suspect compositor/display
  presentation or the phone/dongle wireless round trip rather than React gauges.

## SESSION 37 (2026-06-11) - renderer startup video bridge hardening

No deploy, no reboot, and no intentional Pi runtime changes were made.

### Code review finding
- `src/preload/index.ts` intentionally drops video chunks when no renderer
  handler is installed.
- `src/renderer/src/components/Carplay.tsx` had also been registering the video
  chunk bridge with a `renderReady` guard, so startup/reconnect video arriving
  before the render worker's `render-ready` message could be silently discarded.
- That is not proven as the long-running 5-8 second lag cause. It is, however, a
  plausible reconnect/startup recovery problem because missing an early useful
  keyframe can make the center CarPlay canvas look stale while the rest of the UI
  remains responsive.

### Local-only change made
- `src/renderer/src/components/Carplay.tsx`: removed the `renderReady` gate from
  the video IPC-to-MessagePort bridge and registered that bridge once per
  `videoChannel`.
- The render worker already drops frames older than `500 ms`, so queued startup
  frames should not become a long stale backlog. This change lets the worker see
  early SPS/keyframe data instead of making the preload layer discard it.
- This is not deployed.

### Verification
- `npm run typecheck` passed.
- `npm run build` passed.
- `git diff --check` passed.
- `package.json` and `package-lock.json` parse.
- A non-invasive Pi status/config check was attempted, but
  `motocarplay.local` did not resolve from this Mac during the check. No fallback
  reboot/deploy/debug-port action was taken.

### Next live-phone interpretation update
- If reconnect now gets to visible video faster but steady-state lag remains,
  keep treating this as startup hardening only and continue the baseline vs.
  `diagnosticPlainCarplay=true` A/B.
- During steady-state lag, the decisive signals are still `[touch] stats
  maxAgeMs`, `[video] stats maxGap`, `[dongle] read-gap`, `phone-unplugged`, and
  `driver-failure`.

## SESSION 38 (2026-06-11) - video stall diagnostic

No deploy, no reboot, and no Pi runtime changes were made.

### Code review finding
- The existing `[video] stats maxGap` diagnostic only reports a long frame gap
  after another video frame arrives. During the user's observed symptom, that
  means diagnostics might stay quiet while the center CarPlay screen is actively
  frozen.
- Touch mapping in `src/renderer/src/components/useCarplayTouch.ts` is simple:
  it caches the target rect during a press and sends normalized coordinates.
  Nothing there looked like a plausible multi-second dashboard-fast/CarPlay-only
  stall source.

### Local-only change made
- `src/main/carplay/CarplayService.ts`: added a stream-local video stall timer.
  After real video has been seen, if no further `VideoData` arrives for more
  than `1000 ms` while CarPlay is still started, diagnostics now logs
  `[video] stall {"elapsedMs":...,"width":...,"height":...}` once per second
  until frames resume or the session stops.
- This is diagnostic-only: it does not reset the dongle, alter frame delivery,
  touch rendering, or UI behavior.
- This is not deployed.

### Verification
- `npm run typecheck` passed.
- `npm run build` passed.
- `git diff --check` passed.
- `package.json` and `package-lock.json` parse.
- Non-invasive network checks failed from this Mac:
  `motocarplay.local` and `carplay.local` did not resolve. No fallback
  deploy/reboot/debug-port action was taken.

### Next live-phone interpretation update
- If the center freezes and `[video] stall` appears immediately, the app is not
  receiving video during the freeze. Correlate with `[dongle] read-gap`,
  `phone-unplugged`, and `driver-failure` to distinguish transport starvation
  from logical session drop.
- If the center feels laggy but `[video] stall` does not appear and `[touch]
  stats maxAgeMs` stays low, the stall is more likely in compositor/display
  presentation or phone-side wireless round trip than in incoming USB video.

## SESSION 39 (2026-06-11) - cheaper backdrop-on compositor path

No deploy, no reboot, and no Pi runtime changes were made.

### Code review finding
- The backdrop-off path appears genuinely idle: `<BackdropGlow>` only mounts on
  the root route when `backdropEnabled === true`, and the render worker backdrop
  tap is separately enabled only when the backdrop is actually visible.
- The backdrop-on path still had a full-display CSS `filter:
  blur(6px) saturate(1.5) brightness(0.92)` on the 800x800-ish backdrop canvas.
  Even with a tiny 192px source canvas, that keeps a filtered full-screen layer
  in the compositor, which matches the user's observation that backdrop-on makes
  CarPlay video/touch lag and logical drops more likely.

### Local-only change made
- `src/renderer/src/components/BackdropGlow.tsx`: moved the blur/saturate/
  brightness work into the tiny 192x192 canvas draw (`ctx.filter`) and removed
  the full-screen CSS `filter` from the canvas style.
- Increased the tiny-canvas blur from `9px` to `11px` to preserve roughly the
  same soft fill after removing the display-size CSS blur.
- This only affects backdrop-on. Backdrop-off remains unmounted/no worker tap.
- This is not deployed.

### Verification
- `npm run typecheck` passed.
- `npm run build` passed.
- `git diff --check` passed.
- `package.json` and `package-lock.json` parse.

### Next live-phone interpretation update
- Re-test normal baseline first with backdrop off. Then test backdrop on.
- If backdrop-on still causes lag/drop but diagnostics show no `[video] stall`,
  no touch queue age growth, and no dongle read/failure events, the remaining
  backdrop cost is likely compositor presentation rather than USB/video ingest.

## SESSION 40 (2026-06-11) - live lag probe and frame cadence fix

Phone/live CarPlay was connected. CDP was enabled via the autostart flag for
measurement. A new self-test probe was used from
`tools/perf/cdp_carplay_lag_probe.py`.

### Probe / diagnosis
- Added a passive `--no-drag` mode so renderer/video cadence can be measured
  without synthetic input, plus short controlled drag tests for the actual
  touch/video path.
- Baseline deployed build, backdrop off, no synthetic touch:
  - renderer was healthy (`rafMaxGap` around 25 ms, no long tasks);
  - touch was not involved;
  - incoming video showed ~5 s gaps and about `0.8 fps`.
- Short synthetic drag on the same build:
  - touch path was healthy (`sent` ~143, no slow sends, no stale queue);
  - video still showed ~5 s gaps and about `0.8 fps`.
- Pumping `window.carplay.ipc.sendFrame()` during the probe proved the app can
  influence cadence:
  - `10 Hz` frame requests during a short drag gave about `15 fps`, max video
    gap under 1 s, and no touch/send backlog;
  - `30 Hz` was worse, so more is not always better.

### Code changes made and deployed
- A first production attempt changed the saved/default CarPlay
  `phoneConfig.frameInterval` from `5000` ms to `100` ms. That improved active
  video cadence, but after the tests the app kept sending ~10 Hz `frame`
  commands during an idle video stall and eventually got a logical
  `phone-unplugged` from the dongle. Do not return to a constant 100 ms idle
  timer without more evidence.
- Final deployed approach is adaptive:
  - `src/main/carplay/DongleDriver.ts`: restored the base/idle CarPlay
    `phoneConfig.frameInterval` to `5000` ms.
  - `src/main/index.ts`: migrates the temporary saved `100` ms value from this
    session back to the default `5000` ms.
  - `src/main/carplay/CarplayService.ts`: records `activePhoneType`, starts the
    base 5000 ms frame interval only after the first real `VideoData`, and sends
    throttled `SendCommand('frame')` kicks at most every `100` ms while touch
    events are active. This targets the measured active-touch lag without
    hammering idle/stalled sessions.
- The final adaptive build was deployed to:
  `/home/byron/round-carplay/round-carplay.AppImage`
  with SHA-256:
  `131bbe33ca967a4360cb36c02d23aea20f48eb902ff0ebb370e0724b2bdaa5ad`.

### Post-deploy results
- New boot: usual early Auto Box USB reset occurred, then app started. The
  phone reconnected without the pre-video frame spam. Logs showed:
  `[carplay] plugged`, first resolution/video, then
  `[carplay] frame-interval-started {"intervalMs":100}`.
- Post-deploy short drag, backdrop off:
  - touch OK (`sent` 137, no slow sends, max queue depth 1);
  - video OK for active content (`fpsApprox` 9.7, max gap 681 ms);
  - renderer mostly clean (one ~100 ms rAF warning, no long task).
- Backdrop-on tests after the cheaper compositor path:
  - passive: no session drop, no send slowdowns, max video gap 642 ms;
  - active drag: touch OK (`sent` 148, maxAgeMs 1), video max gap 542 ms,
    renderer OK.
- Backdrop was restored off afterward.
- Important: the constant-100 ms build later showed a long idle video stall
  followed by a logical `phone-unplugged` while still sending ~52 frame commands
  every 5 seconds. That is why the final build switched to touch-driven frame
  kicks and restored the base interval to 5000 ms.
- Final clean-state verification:
  - autostart has no `--remote-debugging-port`;
  - port `4000` open and port `9222` closed;
  - process args are `/home/byron/round-carplay/round-carplay.AppImage
    --ignore-gpu-blocklist`;
  - Pi config now has:
  `backdropEnabled=false`, `ambientFillEnabled=false`,
    `diagnosticPlainCarplay=false`, `phoneConfig["3"].frameInterval=5000`.
- The final adaptive build has not had a live active-drag probe yet because the
  phone did not reconnect after the last reboot during this session. It needs a
  user feel test and/or CDP active probe once the phone is connected again.

### Notes / cautions
- Passive static-screen video can still show lower FPS or occasional video
  stalls. The user's real symptom is active-touch lag; the active drag probe is
  the stronger signal.
- Do not start a fast frame timer at `Plugged`; any frame cadence work must wait
  until real video has arrived, and the final code only boosts while touches are
  active.
- If future testing shows disconnects, check whether they are logical
  `phone-unplugged` events or kernel USB detaches. In this session the bad
  pre-video frame-timer attempt caused a logical unplug without a matching USB
  detach.
