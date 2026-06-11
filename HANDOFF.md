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

## Tools
- `tools/perf/cdp_pipeline_probe.py` — run ON the Pi with the debug-port
  autostart flag active; A/B's backdrop ON/OFF under synthetic drag, reports
  chunks/draws/queue/stalls + arrival & draw-gap histograms.
- `tools/perf/top_thread_agg.py` — aggregates `top -b -H` by process role
  (needs /tmp/tidmap.out from `ps -eLo pid,tid,comm,args | grep -i carplay`).
- /tmp on the Pi is tmpfs — re-upload scripts after every reboot.
