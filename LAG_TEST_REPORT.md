# CarPlay Lag Test Report

Updated: 2026-06-12 02:41 UTC / 2026-06-11 22:41 EDT

Current deployed diagnostic AppImage SHA256:

```text
dba6f0b9ae1f08a40b53ea51e01f59deb30f83e3567510bb4e5b49a2be3fe09b
```

## Current Test Harness

Primary probe:

```bash
tools/perf/cdp_carplay_lag_probe.py
```

USB trace summarizer:

```bash
tools/perf/usbmon_summarize.py
```

Run on the Pi while the app is started with:

```bash
--remote-debugging-port=9222 --remote-allow-origins=*
```

The probe installs a renderer rAF/pointer/long-task monitor through CDP, applies
one settings mode, performs a controlled drag over the CarPlay square, then
parses `~/.config/round-carplay/diagnostics.log` for the same test window.

Harness update, 2026-06-12: the lag probe now writes a unique diagnostics
start/end marker (`renderer lag-probe`) and parses only the marked window.
This avoids stale lines if `diagnostics.log` rotates during a test. Future
touch-lag tests should also run `cdp_visual_motion_probe.py` first and use a
verified direction (`swipe-left` or `swipe-right`) that produces visible
CarPlay pixel motion. The old circular drag can be invalid on a static home
screen.

The most useful metrics are:

- `ui.rafMaxGap` and `rendererLongTask.max`: whether the Electron renderer is
  actually blocked.
- `touch.maxAgeMs`, `touch.failed`, `dongle.sendSlow`: whether touch events are
  delayed before they reach the dongle.
- `latency.p95Ms` and `latency.maxMs`: time from touch send to next incoming
  CarPlay video frame.
- `video.maxGap` and `dongle.readGapMaxMs`: whether incoming dongle/video reads
  are arriving in bursts with long gaps.
- `mainLoop.maxMs`: Electron main-process event-loop delay. This distinguishes
  "WebUSB read loop is blocked inside our app" from "the dongle/phone stream did
  not produce data."
- usbmon `S Bi` -> `C Bi` pending duration: whether the kernel had an IN read
  submitted to the dongle and was waiting for the dongle/device to complete it.

## Measurement Matrix

Command shape for each run:

```bash
python3 /tmp/cdp_carplay_lag_probe.py --seconds 15 --hz 15 --radius 80 \
  --backdrop <on|off> --ambient-fill <on|off>
```

Raw JSON was captured locally in `/tmp/round-lag-results/`.

| Mode | Run | Avg touch-to-video | P95 | Max | Video FPS | Max video gap | Max dongle read gap | Video stalls | UI max rAF gap | Touch max age | Slow sends | Renderer long task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Black | 1 | 205 ms | 1432 ms | 1498 ms | 9.8 | 1523 ms | 1523 ms | 2 | 24.9 ms | 1 ms | 0 | 0 |
| Black | 2 | 106 ms | 725 ms | 725 ms | 9.5 | 2446 ms | 2446 ms | 1 | 25.0 ms | 1 ms | 0 | 0 |
| Backdrop | 1 | 191 ms | 690 ms | 714 ms | 9.2 | 746 ms | 0 ms | 0 | 25.0 ms | 1 ms | 0 | 0 |
| Backdrop | 2 | 143 ms | 644 ms | 644 ms | 8.2 | 1961 ms | 1961 ms | 0 | 24.9 ms | 1 ms | 0 | 0 |
| Ambient | 1 | 1144 ms | 4788 ms | 4932 ms | 4.7 | 5701 ms | 5701 ms | 7 | 25.0 ms | 1 ms | 0 | 0 |
| Ambient | 2 | 89 ms | 368 ms | 368 ms | 8.4 | 2265 ms | 2265 ms | 1 | 24.8 ms | 1 ms | 0 | 0 |

Aggregate from the two-run matrix:

| Mode | Avg latency | Worst P95 | Worst max latency | Avg video FPS | Worst read gap | Total stalls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Black | 155.5 ms | 1432 ms | 1498 ms | 9.7 | 2446 ms | 3 |
| Backdrop | 167.0 ms | 690 ms | 714 ms | 8.7 | 1961 ms | 0 |
| Ambient | 616.5 ms | 4788 ms | 4932 ms | 6.6 | 5701 ms | 8 |

Additional black test with a 20 Hz `frame` command pump:

| Mode | Avg touch-to-video | P95 | Max | Video FPS | Max video gap | Max dongle read gap | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Black + 20 Hz frame pump | 357 ms | 1504 ms | 1569 ms | 6.1 | 1579 ms | 1579 ms | Did not improve responsiveness |

Additional ambient run while sampling Electron process CPU with `top`:

| Mode | Avg touch-to-video | P95 | Max | Video FPS | Max video gap | Max dongle read gap | CPU observation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Ambient + top | 90 ms | 535 ms | 535 ms | 9.2 | 3227 ms | 3227 ms | System mostly idle; no CPU saturation visible |

## Follow-up Isolation Tests

These were run after deploying the main-process event-loop diagnostic build.

| Test | Avg touch-to-video | P95 | Max | Video FPS | Max video gap | Max dongle read gap | Main loop max | Session drop | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Black, normal UI | 224 ms | 1380 ms | 1447 ms | 8.4 | 3131 ms | 1482 ms | 11.5 ms | no | Lag reproduced while Electron main stayed clean |
| Plain CarPlay only | 63 ms | 375 ms | 375 ms | 10.0 | 2975 ms | 2975 ms | 11.1 ms | no | Dashboard features removed; video gaps still happened |
| Black, sensor services stopped | 836 ms | 2700 ms | 2846 ms | 3.4 | 3496 ms | 3496 ms | 10.8 ms | no | Stopping sensor event emitters did not help |
| Black, negotiated 30 FPS | n/a | n/a | n/a | 11.0 | 3776 ms | 6161 ms | 11.1 ms | yes | Not an improvement; caused phone-unplugged/session churn |
| Black + usbmon | 103 ms | 1025 ms | 1025 ms | 13.9 | 1059 ms | 1059 ms | 13.0 ms | no | Kernel-level IN transfer wait matched app-level read gap |
| Black, GPS present + usbmon | 67 ms | 379 ms | 379 ms | 7.8 | 4990 ms | 4989 ms | 12.4 ms | no | Valid GPS-present baseline; kernel bulk-IN max 4910 ms |
| Black, GPS USB unbound + usbmon | 80 ms | 287 ms | 287 ms | 11.8 | 3667 ms | 3667 ms | 11.1 ms | no | First unbound run improved in-window USB max, but app gap began before capture |
| Black, GPS USB unbound repeat + usbmon | 193 ms | 1201 ms | 1201 ms | 8.3 | 1469 ms | 1469 ms | 11.0 ms | no | Logical GPS removal did not eliminate bulk-IN waits; USB max 4765 ms |
| Black, Wi-Fi 5 GHz baseline + usbmon | 152 ms | 1029 ms | 1100 ms | 14.5 | 1123 ms | 1123 ms | 11.1 ms | no | Current band baseline; USB bulk-IN max 3233 ms |
| Black, Wi-Fi 2.4 GHz first run + usbmon | 79 ms | 368 ms | 368 ms | 13.3 | 419 ms | 0 ms | 11.2 ms | no | Active-touch window improved; USB bulk-IN max 440 ms |
| Black, Wi-Fi 2.4 GHz repeat + usbmon | 405 ms | 1951 ms | 1964 ms | 3.5 | 16836 ms | 16836 ms | 11.2 ms | no | Repeat was poor; USB bulk-IN max 1879 ms |

## 2026-06-12 Verified-Motion Runs

Deployed AppImage `412d20a57e57e855ef212ede0f683b9632f5cf46c4235f6209e4e02f29f9a14f`.

Changes in this build:

- `diagnosticTouchFrameKick` defaults to `false`; normal touch no longer sends
  extra `frame` commands after every touch. Earlier command-pump testing did
  not improve latency.
- Backdrop sampling is reduced from ~5 Hz / 64 px worker snapshots to ~1 Hz /
  32 px snapshots, with a 96 px renderer canvas and no full-screen CSS filter.
- `cdp_carplay_lag_probe.py` now marks the diagnostics window so old rotated log
  lines do not contaminate a run.

Visual validation:

- `swipe-left` and `swipe-right` both produced real CarPlay crop motion in the
  36-42% changed-pixel range before the measured runs.

| Test | Avg touch-to-video | P95 | Max | Video FPS | Max video gap | Max dongle read gap | Main loop max | UI max rAF gap | usbmon bulk-IN p95 | usbmon bulk-IN max | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Black/off, reduced-touch-command build | 77 ms | 1172 ms | 1172 ms | 17.4 | 1812 ms | 1812 ms | 11.8 ms | 24.5 ms | 84.3 ms | 1811.8 ms | Still reproduced lower-layer ingress stall |
| Reduced-cost backdrop on | 96 ms | 954 ms | 954 ms | 16.5 | 2097 ms | 2097 ms | 13.4 ms | 25.0 ms | 98.1 ms | 2595.8 ms | Backdrop no renderer jank, but lower-layer stalls remain |
| Pi Wi-Fi radio off, marked repeat | 55 ms | 711 ms | 711 ms | 13.4 | 3258 ms | 3258 ms | 13.0 ms | 25.0 ms | 85.3 ms | 4841.6 ms | Not a proven fix; still saw multi-second bulk-IN wait |
| Pi Wi-Fi radio back on, marked repeat | 42 ms | 414 ms | 414 ms | 18.7 | 453 ms | 0 ms | 13.2 ms | 25.0 ms | 79.4 ms | 452.0 ms | Best run; shows high normal variability |

Config experiments during the same session:

| Test | Avg touch-to-video | P95 | Max | Max dongle read gap | usbmon bulk-IN max | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Restart baseline, `mediaDelay=500` | 167 ms | 1368 ms | 1371 ms | 1365 ms | 1365 ms | Restart alone could reproduce lag |
| `mediaDelay=0` | 1594 ms | 6495 ms | 6732 ms | 6731 ms | 6730 ms | Clearly worse; restored to 500 |
| CarPlay `frameInterval=0` | 118 ms | 1289 ms | 1291 ms | 1286 ms | 1286 ms | Not an improvement; restored to 5000 ms |

Current Pi config after tests: `mediaDelay=500`, `phoneConfig[3].frameInterval=5000`,
`wifiType=5ghz`, `backdropEnabled=false`, `ambientFillEnabled=false`,
`diagnosticPlainCarplay=false`, `diagnosticPointerCaptureTouch=false`,
`diagnosticTouchFrameKick=false`. Pi Wi-Fi radio was restored to enabled.

Notes:

- The no-sensor test stopped `gps.service`, `cht-temp.service`, `imu.service`,
  `ambient-temp.service`, and `pi-temp.service`, then restarted all five. This
  isolates sensor event/software load, not USB power draw.
- The 30 FPS test was restored to `fps: 45` afterward. Current config is
  `backdropEnabled: false`, `ambientFillEnabled: false`,
  `diagnosticPlainCarplay: false`, `fps: 45`.
- The GPS USB-unbound tests stopped `gps.service` and unbound the CP210x GPS
  USB device (`1-2`) from the kernel USB driver. This removes the GPS serial
  driver and `/dev/gps`, but it does not physically remove the device or its
  power draw from the motorcycle dash USB setup.

## USB-Level Capture

Capture command:

```bash
sudo timeout 24 cat /sys/kernel/debug/usb/usbmon/3u > /tmp/usbmon_black_1.txt
```

The paired app-level test was:

```bash
python3 /tmp/cdp_carplay_lag_probe.py --seconds 15 --hz 15 --radius 80 \
  --backdrop off --ambient-fill off
```

Summary from `tools/perf/usbmon_summarize.py`:

| Direction | Count | Median pending | P95 pending | Max pending |
| --- | ---: | ---: | ---: | ---: |
| Bulk IN (`Bi`) | 473 | 1.201 ms | 165.295 ms | 3729.750 ms |
| Bulk OUT (`Bo`) | 398 | 0.048 ms | 0.070 ms | 2.472 ms |

Important matched evidence:

- During the controlled lag window, the app reported `dongle.readGapMaxMs:
  1059` and `video.maxGap: 1059`.
- usbmon reported a matching submitted bulk-IN read pending for `1058.023 ms`:
  the kernel submitted `S Bi:3:003:1 ... 16 <`, then did not receive the
  matching `C Bi:3:003:1 ... 16` completion for about 1.058 seconds.
- The same usbmon capture also saw larger bulk-IN pending waits after the drag
  window: `1839.363 ms` and `3729.750 ms`.
- Bulk-OUT writes stayed fast. The worst matched OUT pending time in the capture
  was `2.472 ms`, so the Pi/app could still send commands quickly while reads
  waited for device data.

GPS logical-removal evidence:

| Condition | App max read gap | App video FPS | usbmon bulk-IN median | usbmon bulk-IN P95 | usbmon bulk-IN max |
| --- | ---: | ---: | ---: | ---: | ---: |
| GPS present, valid baseline | 4989 ms | 7.8 | 2.208 ms | 151.634 ms | 4910.312 ms |
| GPS USB unbound, first pass | 3667 ms | 11.8 | 0.960 ms | 195.226 ms | 1241.582 ms |
| GPS USB unbound, repeat | 1469 ms | 8.3 | 0.621 ms | 194.623 ms | 4765.443 ms |

Interpretation of the GPS-unbound tests: logical GPS removal does not eliminate
the dongle bulk-IN waits. It may change the shape of a given run, but repeated
testing still produced multi-second dongle read gaps and a 4765 ms pending
bulk-IN transfer. A real physical unplug/power isolation test is still useful,
but the GPS service, serial driver, and ordinary GPS USB traffic are not the
sole source.

Wi-Fi band evidence:

| Band | Run | App max read gap | Touch-to-video P95 | App video FPS | usbmon bulk-IN P95 | usbmon bulk-IN max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 GHz | baseline | 1123 ms | 1029 ms | 14.5 | 218.777 ms | 3233.149 ms |
| 2.4 GHz | first | 0 ms | 368 ms | 13.3 | 173.013 ms | 439.724 ms |
| 2.4 GHz | repeat | 16836 ms | 1951 ms | 3.5 | 180.843 ms | 1878.778 ms |

Interpretation of Wi-Fi band tests: 2.4 GHz is not a proven fix. The first
2.4 GHz active-touch window was much better than the 5 GHz baseline, which
supports the idea that the phone-to-dongle wireless stream is involved. The
repeat 2.4 GHz run was poor, however, and still had second-scale bulk-IN waits.
After the experiment, config was restored to `wifiType: "5ghz"`.

Interpretation: the app was not late consuming already-available USB data.
During lag, the kernel had an IN transfer outstanding and the dongle did not
complete it for the lag interval.

## Findings

1. The renderer main thread is not the primary lag source in these tests.
   Every measured run had `ui.rafMaxGap` around 25 ms and no renderer long tasks.

2. The touch path to the dongle is not backing up.
   Touch max age stayed at 1 ms, there were no failed touch sends, and dongle
   send stats did not show slow writes.

3. The visible lag lines up with incoming video/dongle read gaps.
   Bad runs show `dongle.read-gap` and `video.maxGap` in the 1.5-5.7 second
   range. Touch-to-video p95 rises when those gaps happen.

4. Electron main is not blocking the WebUSB read loop during reproduced lag.
   In the black main-loop run, touch-to-video p95 was 1380 ms while main-loop max
   delay was only 11.5 ms. That means the app was waiting for dongle/phone data;
   it was not stuck running JavaScript in the main process.

5. Dashboard features are not the root cause.
   Plain CarPlay-only mode still showed a 2975 ms dongle/video gap. Removing
   gauges, graphs, nav, camera detection, backdrop, and overlay UI does not make
   the lower-layer video gaps disappear.

6. Sensor event traffic is not the root cause.
   Stopping sensor services made the measured run worse, not better, while the
   main loop stayed clean.

7. The visual mode is not a complete explanation.
   Ambient had the worst single run, but black also had multi-second read gaps,
   and backdrop was not consistently worse in this matrix. This matches the
   user observation that backdrop can add lag, but the CarPlay surface can still
   become sluggish with backdrop off.

8. Pumping `frame` commands is not the fix.
   A 20 Hz frame pump did not improve latency or FPS. The bottleneck appears
   lower than "the app is not asking for frames often enough."

9. Lowering negotiated FPS to 30 is not a safe improvement.
   It caused a `phone-unplugged` cycle in the test window and did not remove
   read gaps. The app was restored to 45 FPS afterward.

10. No USB hardware disconnect occurred during the measurement windows after
   boot.
   Kernel logs only show the known early boot Auto Box reset. The lag tests did
   not produce a fresh USB re-enumeration.

11. usbmon places the source below Electron/WebUSB consumption.
   In the paired usbmon run, the kernel had a bulk-IN transfer submitted to the
   dongle for 1058 ms during the same window where the app measured a 1059 ms
   dongle/video read gap. Later in the same capture, bulk-IN waits reached 3729
   ms. Bulk-OUT sends stayed fast.

12. Logical GPS removal does not eliminate the problem.
   Unbinding the GPS USB device and stopping `gps.service` did not remove
   multi-second dongle bulk-IN waits. The repeat unbound run still reached 4765
   ms at usbmon level.

13. Wi-Fi band changes affect the symptom but do not provide a proven fix.
   A 2.4 GHz run was excellent in-window, but the repeat was poor. This keeps
   the phone-to-dongle wireless link high on the suspect list, but does not
   justify switching bands permanently yet.

14. Extra software `frame` commands are not a fix.
   A 20 Hz frame pump, disabling the 5 s periodic CarPlay frame interval, and
   the per-touch frame-kick experiment did not remove the lag pattern. The
   deployed build now keeps per-touch frame kicks off by default.

15. `mediaDelay=0` is not a fix.
   The low-delay restart test was worse, with p95 touch-to-video around 6.5 s
   and a matching 6.73 s usbmon bulk-IN wait. The Pi was restored to
   `mediaDelay=500`.

16. Pi onboard Wi-Fi is not a proven factor.
   Temporarily disabling the Pi Wi-Fi radio produced one decent p95 but still
   had multi-second bulk-IN waits; turning Wi-Fi back on immediately produced
   the best marked run of the cluster. The variability is larger than this
   system-radio change.

## Current Working Hypothesis

The perceived touch lag is mostly "touch reaches the dongle, but the next
CarPlay video frame arrives late." The app remains responsive, and the dongle
write path remains responsive, but the main process observes long gaps between
incoming dongle messages/video frames.

This now points at one of these next layers:

- dongle/phone wireless CarPlay stream intermittently stalls, or
- dongle USB read completion is delayed below Electron/WebUSB even while the app
  event loops are clean.

Visual/GPU load may still increase stall probability, but the source is now
measured below the React renderer, below the touch queue, below sensor event
traffic, below Electron main-loop JavaScript delay, and below app-level WebUSB
read consumption.

## Next Probes

1. Focus outside the UI:
   dongle, phone wireless link, USB bus behavior, cable/power/hub, or GPS/power
   interaction.
2. If possible, run the same touch test with physical GPS unplugged again, then
   with dongle power/cable/USB port changes. Software-stopping sensors did not
   help, and logical GPS USB unbind did not eliminate the issue, so the
   remaining GPS angle is electrical/power/bus, not event load or serial driver
   traffic.
3. Use usbmon again when testing physical changes. The key metric is max/p95
   bulk-IN pending duration for bus `3`, device `003` or whatever `lsusb` shows
   for the Auto Box after reboot.
4. Test phone/dongle wireless conditions with the user present: phone position,
   5 GHz vs 2.4 GHz feel-test over several minutes, Bluetooth/Wi-Fi reset on the
   phone, and possibly a different CarPlay adapter. The automated band test was
   too variable to call 2.4 GHz a fix.
4. Before ending a debug session, remove the Pi CDP autostart flags and reboot.

## 2026-06-12 Continuation: Self-Test Harness + Touch Capture Default

Deployed AppImage:

```text
dba6f0b9ae1f08a40b53ea51e01f59deb30f83e3567510bb4e5b49a2be3fe09b
```

Changes made:

- `tools/perf/cdp_carplay_lag_probe.py` now has built-in usbmon capture
  (`--usbmon-bus`, `--usbmon-device`) and can flip the pointer/touch diagnostic
  toggles. It also fixes the diagnostics-marker race by taking the log offset
  before writing the start marker.
- `pointerCaptureTouch` now defaults to `true`. Real drags stay captured by the
  CarPlay surface instead of a masked/edge pixel creating a fake `pointerout`
  -> `Up`. The old `diagnosticPointerCaptureTouch` key remains as a test
  override.

Post-deploy checks:

- Motion guard: `cdp_visual_motion_probe.py --gesture swipe-left` showed real
  CarPlay crop motion, ~38% average changed pixels.
- Active baseline, backdrop off, pointer capture on:
  - renderer: `rafMaxGap 24.8 ms`, no long tasks.
  - touch: `155/155` sent, max queue age `1 ms`, no slow/failed sends.
  - latency: avg `67 ms`, p95/max `512 ms`.
  - video: ~`21.6 fps`, app-level max gap `2248 ms`.
  - usbmon: bulk-IN p95 `53 ms`, max `554 ms`.
- Short repeat with usbmon caught a real lower-layer wait:
  - latency p95/max `316 ms`, touch still clean.
  - usbmon bulk-IN max `1990 ms`, confirming occasional dongle/device-side
    waits still happen below the app.
- Backdrop-on short check:
  - renderer/touch stayed clean; latency p95/max `691 ms`.
  - usbmon bulk-IN max `748 ms`.

Final Pi state after cleanup:

- CDP debug flag removed from autostart and Pi rebooted.
- App running normally with `4000` open and `9222` closed.
- Config: `backdropEnabled=false`, `ambientFillEnabled=false`,
  `pointerCaptureTouch=true`, `diagnosticPointerCaptureTouch=false`,
  `diagnosticTouchFrameKick=false`, `diagnosticPlainCarplay=false`,
  `fps=45`, `mediaDelay=500`, `phoneConfig["3"].frameInterval=5000`.

Interpretation update: the app/touch/UI path is now very consistently clean
under synthetic motion. The remaining intermittent long waits are still best
explained by dongle/phone/wireless/USB ingress stalls rather than gauges,
graphs, React, or the touch queue. Pointer capture is still worth keeping
because it removes a real edge-drag failure mode, but it is not expected to fix
multi-second dongle bulk-IN waits by itself.

## 2026-06-12 Three-Mode Matrix: Black vs Backdrop vs Ambient

Harness updates before this matrix:

- Added `tools/perf/run_lag_mode_matrix.py` to run the same active swipe test in
  `black`, `backdrop`, and `ambient` modes.
- Added `--warmup-seconds` to `cdp_carplay_lag_probe.py`. The probe now does an
  unmeasured warmup drag before writing diagnostics markers, so idle/static
  CarPlay gaps that began before the test window are less likely to pollute the
  active-touch measurement.
- Updated `usbmon_summarize.py` to report submitted USB reads that are still
  pending at capture end. This matters because a lag can extend past the end of
  the capture and otherwise disappear from the completed-transfer-only max.

Final matrix command:

```bash
python3 /tmp/round-carplay-perf/run_lag_mode_matrix.py \
  --reps 3 \
  --seconds 10 \
  --warmup-seconds 3 \
  --hz 12 \
  --gesture swipe-left \
  --usbmon-bus 3 \
  --usbmon-device 3:003 \
  --out-dir /tmp/round-lag-matrix-final-20260611-220215
```

Motion guard before the matrix: `cdp_visual_motion_probe.py --gesture
swipe-left` confirmed visible CarPlay crop motion, though this screen was less
visually busy than earlier runs (`maxChangedPct=5.14`, `avgChangedPct=3.76`).

Primary lag amount is touch-to-next-video p95. All modes had clean touch
delivery (`touchFailedTotal=0`, `touchMaxAgeWorstMs=1`) and no renderer jank
(`uiRafMaxWorstMs=25.0`).

| Mode | Runs | Touch-to-video p95 avg | Worst p95 | Worst max | Avg video FPS | Worst app video gap | USB bulk-IN p95 avg | USB bulk-IN max* | Touch/UI result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Black | 3 | 976 ms | 1022 ms | 1022 ms | 28.5 | 1235 ms | 52.8 ms | 2752.8 ms | clean |
| Backdrop | 3 | 2725 ms | 6366 ms | 6547 ms | 18.1 | 6777 ms | 323.4 ms | 2726.7 ms | clean |
| Ambient | 3 | 1062 ms | 1161 ms | 1170 ms | 28.4 | 1383 ms | 52.9 ms | 2740.3 ms | clean |

Per-run p95 samples:

| Mode | Touch-to-video p95 samples | App video gap samples | USB bulk-IN max samples |
| --- | --- | --- | --- |
| Black | `1022, 1002, 904 ms` | `1235, 1213, 958 ms` | `2721, 2743, 2753 ms` |
| Backdrop | `6366, 1254, 555 ms` | `6777, 1462, 818 ms` | `1940, 2719, 2727 ms` |
| Ambient | `1161, 1023, 1002 ms` | `1383, 1210, 1211 ms` | `2717, 2740, 2716 ms` |

`*` USB bulk-IN max includes reads still pending when the capture ended. This
is useful for catching read starvation that extends past the capture, but it can
also include the normal post-gesture/static-screen wait after motion stops. USB
bulk-IN p95 is the steadier "during flow" signal.

Interpretation:

1. Ambient fill is not the source of the lag in this build. Its lag amount was
   close to black mode: roughly `1.06 s` p95 average vs black's `0.98 s`, with
   the same clean touch/UI path.
2. Backdrop can still make the symptom worse or increase variability. One of
   three backdrop runs hit a `6.37 s` p95 and `6.55 s` max touch-to-video delay,
   while the other two were near or better than the black/ambient range.
3. Even in the bad backdrop run, the renderer and touch path stayed clean:
   no touch failures, max touch age `1 ms`, and rAF max `25 ms`. That means the
   lag was not React, gauges, graph rendering, or touch-event queuing.
4. The remaining source is still below the app's UI path: incoming CarPlay
   video cadence / dongle USB ingress / phone-to-dongle stream behavior. The
   visual mode can affect probability or severity, especially backdrop, but the
   baseline black screen is already near `1 s` p95 and the app is not blocking
   touch delivery.

## 2026-06-12 Continuation: Band and Plain-CarPlay Repeat

Harness update:

- `tools/perf/run_lag_mode_matrix.py` can now run selected modes with
  `--modes`, apply `--wifi-type`, and toggle `--plain`. This makes repeat tests
  for one variable less hand-assembled.

Motion guard:

```bash
python3 /tmp/round-carplay-perf/cdp_visual_motion_probe.py \
  --seconds 4 --hz 10 --gesture swipe-left --samples 4 --threshold 10
```

Result: valid visible motion, `avgChangedPct=39.868`, `maxChangedPct=39.870`.

### Wi-Fi Band Repeat

Both runs used black mode, 5 GHz or 2.4 GHz persisted through settings,
`--restart-first`, three 10-second active swipe reps, 3-second warmup, and
paired usbmon capture.

| Band | Runs | Touch-to-video p95 avg | Worst p95 | Worst max | Avg video FPS | Worst app video gap | USB bulk-IN p95 avg | USB bulk-IN max* | Touch/UI result | Session drops |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 5 GHz | 3 | 1236 ms | 1494 ms | 1582 ms | 24.3 | 1582 ms | 55.1 ms | 2763.8 ms | clean | 0 |
| 2.4 GHz | 3 | 1390 ms | 2040 ms | 2124 ms | 24.7 | 2206 ms | 53.5 ms | 2734.4 ms | clean | 0 |

Per-run samples:

| Band | Touch-to-video p95 samples | App video gap samples | USB bulk-IN max samples |
| --- | --- | --- | --- |
| 5 GHz | `1494, 1202, 1013 ms` | `1582, 1433, 1223 ms` | `2764, 2696, 2735 ms` |
| 2.4 GHz | `1134, 2040, 997 ms` | `1347, 2206, 1214 ms` | `2734, 2205, 2722 ms` |

Interpretation: this repeat does not support switching permanently to 2.4 GHz.
The band still plausibly affects the phone-to-dongle wireless stream, but the
measured symptom remained on both bands and 2.4 GHz was slightly worse in this
run.

### Plain-CarPlay Baseline Repeat

Both runs used 5 GHz, black mode, `--restart-first`, three 10-second active
swipe reps, 3-second warmup, and paired usbmon capture.

| Mode | Runs | Touch-to-video p95 avg | Worst p95 | Worst max | Avg video FPS | Worst app video gap | USB bulk-IN p95 avg | USB bulk-IN max* | Touch/UI result | Session drops |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| Plain CarPlay | 3 | 1034 ms | 1058 ms | 1058 ms | 29.0 | 1281 ms | 54.4 ms | 2763.8 ms | clean | 0 |
| Normal dashboard | 3 | 1039 ms | 1070 ms | 1084 ms | 29.0 | 1323 ms | 54.4 ms | 2733.9 ms | clean | 0 |

Per-run samples:

| Mode | Touch-to-video p95 samples | App video gap samples | USB bulk-IN max samples |
| --- | --- | --- | --- |
| Plain CarPlay | `1004, 1039, 1058 ms` | `1213, 1281, 1188 ms` | `2483, 2764, 2722 ms` |
| Normal dashboard | `1021, 1025, 1070 ms` | `1236, 1250, 1323 ms` | `2719, 2734, 2718 ms` |

Interpretation: plain-CarPlay mode is a good self-test baseline, but it did not
remove the ~1 second active touch-to-video delay in this build. The normal dash
repeat was effectively identical to plain mode. This further supports that
gauges, graphs, nav, camera detection, backdrop-off layout, and React dashboard
updates are not the decisive lag source.

`*` USB bulk-IN max includes reads still pending when the capture ended; USB
bulk-IN p95 plus app video/read gap remains the better "active flow" signal.

Post-session Pi state:

- CDP debug flag removed from autostart and Pi rebooted.
- App running normally with `4000` open and `9222` closed.
- Config restored to `wifiType=5ghz`, `backdropEnabled=false`,
  `ambientFillEnabled=false`, `diagnosticPlainCarplay=false`,
  `pointerCaptureTouch=true`, `diagnosticPointerCaptureTouch=false`,
  `diagnosticTouchFrameKick=false`, `fps=45`, `mediaDelay=500`,
  `phoneConfig["3"].frameInterval=5000`.
- `gps.service`, `cht-temp.service`, `imu.service`,
  `ambient-temp.service`, and `pi-temp.service` are active.

## 2026-06-12 Continuation: Physical GPS Unplugged

The USB GPS was physically unplugged. `lsusb` confirmed the CP210x GPS device
(`10c4:ea60`) was absent while the Auto Box remained present as bus/device
`3:003`. The dash overlay showed `NO GPS`, and the motion guard confirmed live
CarPlay pixel motion (`avgChangedPct=67.841`, `maxChangedPct=94.745`).

### Passive No-Touch, GPS Physically Unplugged

Command shape:

```bash
python3 /tmp/round-carplay-perf/cdp_carplay_lag_probe.py \
  --seconds 24 \
  --no-drag \
  --backdrop off \
  --ambient-fill off \
  --plain off \
  --usbmon-bus 3 \
  --usbmon-device 3:003 \
  --usbmon-top 8
```

| Condition | Video FPS | App video max gap | App dongle read max gap | Video stalls | Main loop max | UI rAF max | USB bulk-IN p95 | USB bulk-IN max | USB bulk-OUT max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GPS plugged, passive | 0.9 | 8323 ms | 8322 ms | 27 | 11.2 ms | 24.7 ms | 4565.6 ms | 8320.9 ms | 0.065 ms |
| GPS physically unplugged, passive | 0.8 | 12620 ms | 10697 ms | 22 | 11.3 ms | 24.7 ms | 2526.2 ms | 5536.6 ms | 0.061 ms |

Longest no-GPS usbmon waits were still decoded as `VideoData` headers:
`5536.6 ms`, `4934.0 ms`, `2573.6 ms`, `2526.2 ms`, and `1544.8 ms`.

### Active Swipe, GPS Physically Unplugged

Command shape:

```bash
python3 /tmp/round-carplay-perf/run_lag_mode_matrix.py \
  --modes black \
  --wifi-type 5ghz \
  --plain off \
  --reps 3 \
  --seconds 8 \
  --warmup-seconds 3 \
  --hz 12 \
  --gesture swipe-left \
  --usbmon-bus 3 \
  --usbmon-device 3:003
```

| Condition | Runs | Touch-to-video p95 avg | Worst p95 | Worst max | Avg video FPS | Worst app video gap | USB bulk-IN p95 avg | USB bulk-IN max | Touch/UI result | Session drops |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| GPS physically unplugged, active | 3 | 2528 ms | 6425 ms | 6605 ms | 18.7 | 6795 ms | 90.1 ms | 6794.8 ms | clean | 0 |

Per-run active samples: touch-to-video p95 `760, 399, 6425 ms`; app video gap
`810, 515, 6795 ms`; USB bulk-IN max `2731, 1831, 6795 ms`.

Interpretation: physically unplugging GPS did not eliminate the lag. The
passive no-touch stall still happened with the same signature: clean UI/main
loop, sub-millisecond bulk-OUT, and multi-second waits for Auto Box
`VideoData` headers. GPS power draw or GPS USB traffic may still influence
noise in a given run, but it is not the root cause.

Post-session Pi state:

- CDP debug flag removed from autostart and Pi rebooted.
- App running normally with `4000` open and `9222` closed.
- `lsusb` still shows no CP210x GPS device and shows Auto Box at `3:003`.
- Config restored to `width=565`, `height=565`, `fps=45`,
  `mediaDelay=500`, `wifiType=5ghz`, `audioTransferMode=true`,
  `backdropEnabled=false`, `ambientFillEnabled=false`,
  `diagnosticPlainCarplay=false`, `pointerCaptureTouch=true`,
  `diagnosticPointerCaptureTouch=false`, and
  `diagnosticTouchFrameKick=false`.

## 2026-06-12 Continuation: Passive VideoData USB Waits

Harness updates:

- `tools/perf/cdp_carplay_lag_probe.py` now supports
  `--audio-transfer-mode on|off`.
- `tools/perf/run_lag_mode_matrix.py` now forwards `--audio-transfer-mode`,
  `--width`, `--height`, `--fps`, and `--media-delay`.
- `tools/perf/usbmon_summarize.py` now decodes 16-byte dongle headers in
  completed bulk-IN rows, so long waits can be identified as `VideoData`,
  `Command`, etc. instead of only raw hex.

### Audio Transfer A/B

Both runs used black mode, 5 GHz, normal dashboard, `565x565 @45fps`,
`mediaDelay=500`, `--restart-first`, five 8-second active swipe reps,
3-second warmup, and paired usbmon capture.

| Audio transfer | Runs | Touch-to-video p95 avg | Worst p95 | Worst max | Avg video FPS | Worst app video gap | USB bulk-IN p95 avg | USB bulk-IN max* | Touch/UI result | Session drops |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| Off | 5 | 795 ms | 880 ms | 880 ms | 16.2 | 1041 ms | 100.0 ms | 8208.7 ms | clean | 0 |
| On | 5 | 773 ms | 990 ms | 990 ms | 19.7 | 1144 ms | 71.5 ms | 2705.0 ms | clean | 0 |

Interpretation: audio transfer is not a proven fix. A smaller 3-rep run had a
bad audio-on outlier (`3035 ms` p95), but the 5-rep repeat did not reproduce a
meaningful advantage for audio-transfer off. Config was restored to
`audioTransferMode=true`.

### Resolution Test

`480x480 @45fps` was tried as a throughput isolation test. It was not a valid
lag comparison: the CarPlay session sent `phone-unplugged`, video did not stay
visible for the reps, and the matrix returned failures (`returnCode=2`) with
no video FPS/latency samples. The app was restored to `565x565 @45fps`.

Interpretation: lowering the negotiated square to `480x480` is not safe as a
quick fix with this dongle/phone combination.

### Passive No-Touch Capture

Command shape:

```bash
python3 /tmp/round-carplay-perf/cdp_carplay_lag_probe.py \
  --seconds 30 \
  --no-drag \
  --backdrop off \
  --ambient-fill off \
  --plain off \
  --usbmon-bus 3 \
  --usbmon-device 3:003 \
  --usbmon-top 10
```

Result:

| Test | Video FPS | App video max gap | App dongle read max gap | Video stalls | Main loop max | UI rAF max | USB bulk-IN p95 | USB bulk-IN max | USB bulk-OUT max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Passive, no touch | 0.9 | 8323 ms | 8322 ms | 27 | 11.2 ms | 24.7 ms | 4565.6 ms | 8320.9 ms | 0.065 ms |

The longest usbmon wait decoded as a `VideoData` header:

```text
S Bi:3:003:1 ... 16 <
... 8320.937 ms later ...
C Bi:3:003:1 ... 16 = aa55aa55 1b630000 06000000 f9ffffff
decodedHeader: VideoData, messageLength=25371, typeCheckOk=true
```

The next longest waits were also decoded `VideoData` headers:
`4999.6 ms`, `4990.4 ms`, `4565.6 ms`, and `1240.1 ms`.

Interpretation: this is the clearest isolation so far. The same stall happens
with no synthetic touch input at all. The kernel already has a bulk-IN read
submitted to the Auto Box and waits seconds for the dongle to complete a
`VideoData` header. The app main loop and renderer remain responsive, and
bulk-OUT writes remain sub-millisecond. The center-screen "touch lag" is
therefore a visible symptom of passive CarPlay video ingress starvation, not
touch event handling, React, graphs, sensors, or dashboard rendering.

### Hardware/OS Checks

- Auto Box USB autosuspend is already disabled:
  `/sys/bus/usb/devices/3-1/power/control = on`.
- Display and GPS USB devices also have `power/control = on`.
- Pi throttle/power state was clean during the debug session:
  `vcgencmd get_throttled = 0x0`, temperature about `55.4 C`.

Current source assessment: the measured source is now below app code that can
reasonably be optimized. The best remaining suspects are the phone-to-dongle
wireless CarPlay stream, dongle firmware/behavior, USB electrical/power/cable
conditions, or the adapter itself.

Post-session Pi state:

- CDP debug flag removed from autostart and Pi rebooted.
- App running normally with `4000` open and `9222` closed.
- Config restored to `width=565`, `height=565`, `fps=45`,
  `mediaDelay=500`, `wifiType=5ghz`, `audioTransferMode=true`,
  `backdropEnabled=false`, `ambientFillEnabled=false`,
  `diagnosticPlainCarplay=false`, `pointerCaptureTouch=true`,
  `diagnosticPointerCaptureTouch=false`, and
  `diagnosticTouchFrameKick=false`.
- `gps.service`, `cht-temp.service`, `imu.service`,
  `ambient-temp.service`, and `pi-temp.service` are active.

## New Pi 5 8GB Minimal-Hardware Baseline

The existing SD card/AppImage was moved from the old Pi 5 2GB to the new Pi 5
8GB. The new board reported `7.9Gi` RAM. Baseline hardware was intentionally
minimal: display HDMI/touch USB and Carlinkit only. GPS and GPIO sensors were
not connected, and `gps.service`, `cht-temp.service`, `imu.service`,
`ambient-temp.service`, and `pi-temp.service` were stopped during the tests.

USB state:

```text
Bus 001 Device 002: ID 0483:5750 STMicroelectronics LED badge -- mini LED display -- 11x44
Bus 003 Device 003: ID 1314:1520 Magic Communication Tec. Auto Box
```

Config during the clean baseline:

- `width=565`, `height=565`, `fps=45`
- `mediaDelay=500`
- `wifiType=5ghz`
- `backdropEnabled=false`
- `ambientFillEnabled=false`
- `diagnosticPlainCarplay=false`

### Visual Guard

The visual motion guard was run after the user confirmed CarPlay was visible:

```bash
python3 /tmp/round-carplay-perf/cdp_visual_motion_probe.py \
  --seconds 4 \
  --hz 10 \
  --gesture swipe-left \
  --samples 4 \
  --threshold 10
```

Result: valid visual motion. The canvas was visible at `565x565`, and the
average changed-pixel percentage was `34.933%`.

### Passive No-Touch Baseline

An earlier passive attempt began while CarPlay was still searching, so it is
diagnostic only. Even in that confounded run, once video became visible the app
showed multi-second dongle/video gaps (`dongle read max 6301 ms`, app video max
gap `4937 ms`, usbmon bulk-IN max `6300.5 ms`).

The clean passive repeat started and ended with video visible:

| Test | Video FPS | App video max gap | App dongle read max gap | Video stalls | Main loop max | UI rAF max | USB bulk-IN p95 | USB bulk-IN max | USB bulk-OUT max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| New Pi minimal, passive no touch | 1.5 | 5255 ms | 5255 ms | 20 | 10.5 ms | 24.6 ms | 4950.2 ms | 5254.1 ms | 0.065 ms |

The longest paired usbmon waits decoded as `VideoData` headers:

```text
5254.101 ms -> VideoData, messageLength=24972
4957.198 ms -> VideoData, messageLength=24970
4956.338 ms -> VideoData, messageLength=25025
4950.166 ms -> VideoData, messageLength=24972
```

Interpretation: the new Pi and minimal hardware do not eliminate the core
stall. In a no-touch window, the renderer/UI remained responsive while the
kernel was waiting seconds for the Auto Box to complete bulk-IN reads,
primarily for `VideoData` headers.

### Active Swipe Baseline

Normal dashboard shell, backdrop off, ambient fill off:

```bash
python3 /tmp/round-carplay-perf/run_lag_mode_matrix.py \
  --modes black \
  --wifi-type 5ghz \
  --plain off \
  --reps 3 \
  --seconds 8 \
  --warmup-seconds 3 \
  --hz 12 \
  --gesture swipe-left \
  --usbmon-bus 3 \
  --usbmon-device 3:003
```

| Mode | Runs | Video FPS avg | Latency p95 avg | Latency p95 worst | Video gap worst | USB bulk-IN p95 avg | USB bulk-IN max worst | UI rAF max | Touch age worst | Phone unplugged |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Dashboard shell | 3 | 27.6 | 733 ms | 860 ms | 1101 ms | 54.3 ms | 2741.8 ms | 25.0 ms | 1.0 ms | 0 |

Plain CarPlay diagnostic mode, same active swipe:

```bash
python3 /tmp/round-carplay-perf/run_lag_mode_matrix.py \
  --modes black \
  --wifi-type 5ghz \
  --plain on \
  --reps 2 \
  --seconds 8 \
  --warmup-seconds 3 \
  --hz 12 \
  --gesture swipe-left \
  --usbmon-bus 3 \
  --usbmon-device 3:003
```

| Mode | Runs | Video FPS avg | Latency p95 avg | Latency p95 worst | Video gap worst | USB bulk-IN p95 avg | USB bulk-IN max worst | UI rAF max | Touch age worst | Phone unplugged |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Plain CarPlay | 2 | 29.4 | 483 ms | 486 ms | 537 ms | 52.9 ms | 2741.9 ms | 25.0 ms | 1.0 ms | 0 |

Interpretation: removing the dashboard shell improves active perceived latency
by roughly `250 ms` p95 in this small sample and cuts the worst app-level video
gap about in half, so the shell still has some cost. However, the same test
still showed a `2741.9 ms` worst bulk-IN wait below the renderer/UI layer, so
the remaining long stalls are not explained by gauges, graphs, CSS, backdrop,
ambient fill, or touch event handling.

The app was restored to `diagnosticPlainCarplay=false`,
`backdropEnabled=false`, and `ambientFillEnabled=false` after the comparison.

Post-baseline Pi state:

- CDP debug flag removed from autostart and Pi rebooted.
- App running normally with `4000` open and `9222` closed.
- Autostart command restored to
  `/home/byron/round-carplay/round-carplay.AppImage --ignore-gpu-blocklist`.
- `gps.service`, `cht-temp.service`, `imu.service`,
  `ambient-temp.service`, and `pi-temp.service` stopped again to preserve the
  minimal-hardware baseline for the next staged sensor test.

### Staged Sensor Re-Enable

`pi-temp.service` was started by itself with GPS/CHT/IMU/ambient services still
inactive. User-observed result: CarPlay remained responsive with no adapter
drops.

The Pi was then powered down, both MAX31856 cylinder-head temperature boards
were moved to the new Pi, and the Pi was powered back on. After boot,
GPS/IMU/ambient services were stopped again, leaving only `pi-temp.service` and
`cht-temp.service` active. `/dev/spidev0.0` and `/dev/spidev0.1` were present.
Socket verification saw CHT events flowing:

```text
cht {'left': 25.41, 'right': 25.74}
cht {'left': 25.46, 'right': 25.74}
cht {'left': 25.52, 'right': 25.74}
```

CHT/Pi-temp were then toggled off/on twice while the user tested CarPlay by
touch. User-observed result: any difference was too subtle to call. During the
last ON interval, the user also toggled backdrop on and reported it was still
OK. Current sensor state after the A/B: `cht-temp.service` and
`pi-temp.service` active; GPS/IMU/ambient inactive.

The user then did a normal/backdrop-on/backdrop-off feel test with CHT and
Pi-temp still active. User-observed result: all good.

The Pi was then powered down, the BNO055 IMU UART wiring was moved to the new
Pi, and the Pi was powered back on. After boot, GPS and ambient services were
stopped again, leaving `pi-temp.service`, `cht-temp.service`, and `imu.service`
active. `/dev/ttyAMA0` was present. Socket verification over 6 seconds:

```text
counts {'lean': 57, 'pitch': 57, 'gforce': 57, 'cht': 3, 'pi-temp': 3}
last {'lean': -2.44, 'pitch': 3.62, 'gforce': {'x': 0.004, 'y': 0},
      'pi-temp': {'cpu': 48}, 'cht': {'left': 25.86, 'right': 26.09}}
```

User-observed result after adding IMU: CarPlay was good with no reported lag or
drops.

The Pi was then powered down, the DS18B20 ambient 1-Wire probe was moved to the
new Pi, and the Pi was powered back on. The 1-Wire device appeared as
`28-062592207716`. After boot, GPS was stopped again, leaving
`pi-temp.service`, `cht-temp.service`, `imu.service`, and
`ambient-temp.service` active. Socket verification saw all non-GPS sensors:

```text
counts {'lean': 28, 'pitch': 28, 'gforce': 28, 'cht': 2, 'pi-temp': 2, 'ambient': 1}
last {'lean': -2.44, 'pitch': 3.75, 'gforce': {'x': 0.004, 'y': 0.001},
      'pi-temp': {'cpu': 49}, 'cht': {'left': 25.99, 'right': 26.05},
      'ambient': 25.44}
```

User-observed result after adding ambient temp: CarPlay remained responsive with
no issues.

The GPS USB was then connected without powering down. It enumerated as:

```text
Bus 001 Device 003: ID 10c4:ea60 Silicon Labs CP210x UART Bridge
/dev/gps -> ttyUSB0
```

`gps.service` was started, leaving all sensor services active. Socket
verification saw GPS data, sky data, and fix status:

```text
counts {'gps': 4, 'gps-sky': 4, 'gps-status': 4, 'lean': 31,
        'cht': 2, 'ambient': 1, 'pi-temp': 2}
last gps-status {'fix': True, 'sats': 5}
last gps {'speed': 0.9, 'heading': 0, 'altitude': 121.8}
last gps-sky {'fixType': 3, 'satsUsed': 5, 'satsInView': 20, ...}
```

User-observed result after adding GPS and testing normal/backdrop-on/backdrop-off:
CarPlay remained responsive with no issues or drops.

### Rounded CarPlay Corner Clip Retest

A hidden `diagnosticRoundedCarplayClip` flag was added and deployed in build
`90d4aacb8eecbd5aff2d594840a7b9512e0229706c342d6223cc38923d1e75ea`.
This restores the older rounded/clipped center CarPlay path:

- center square: `borderRadius: 36`, `overflow: hidden`
- `#videoContainer`: `borderRadius: 36`, `overflow: hidden`

The user tested with rounded corners on while backdrop was on, then with rounded
corners on and backdrop off. User-observed result: all responsive in both cases.
Because this now appears acceptable on the new Pi 5 8GB setup, the flag was
promoted to a visible Settings toggle labeled `ROUND CORNERS`. Toggle build
`c97b314353b99c21cf32d0ae645a9ef4fcf288c76fb942d6dc4e349cdb6e261a` was deployed
to the Pi with `diagnosticRoundedCarplayClip=true`, `backdropEnabled=false`,
and all sensor services active. User-observed result after reboot/final feel
check: all good.

### WebCodecs Hardware Decode Probe

A hidden `diagnosticHardwareDecode` flag was added in build
`c7970925b08e10af3121cbcfb36497c01bdcbed4e5ece624ad1c6104fe249eb7` to test a
hardware-first WebCodecs decode path. The render worker now logs
`decoder-selection` and `decoder-config`.

Default boot (`diagnosticHardwareDecode=false`) selected software decode:

```text
decoder-selection {
  renderer: "webgl",
  decodeMode: "software",
  forceHardwareDecode: false,
  caps: {
    webgl2: { hw: false, sw: false, available: false },
    webgl:  { hw: false, sw: true,  available: true },
    webgpu: { hw: false, sw: true,  available: true }
  }
}
decoder-config { hardwareAcceleration: "prefer-software" }
```

Forced boot (`diagnosticHardwareDecode=true`) still selected software because
Chromium/WebCodecs reported no hardware-supported decode path:

```text
decoder-selection {
  renderer: "webgl",
  decodeMode: "software",
  forceHardwareDecode: true,
  caps: {
    webgl2: { hw: false, sw: false, available: false },
    webgl:  { hw: false, sw: true,  available: true },
    webgpu: { hw: false, sw: true,  available: true }
  }
}
```

Runtime device handles showed DRI/GPU render nodes in use for drawing, but no
`/dev/video*`/media hardware decode device opened by `round-carplay`.
`diagnosticHardwareDecode` was restored to `false` after the probe.
