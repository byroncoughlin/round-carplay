#!/usr/bin/env python3
"""Synthetic CarPlay responsiveness probe.

Run on the Pi while the app is started with:
  --remote-debugging-port=9222 --remote-allow-origins=*

The probe uses CDP to:
  - install a renderer-side rAF/pointer-event lag probe,
  - optionally apply a small settings patch,
  - synthesize a repeatable drag/wiggle over the CarPlay square,
  - parse diagnostics.log lines written during the test window.

The output is intentionally boring JSON plus a compact verdict. It is meant to
separate these failure modes:
  - renderer/main-thread jank,
  - stale/slow touch sends,
  - incoming video/dongle starvation,
  - logical phone/dongle disconnects.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

import websocket


DEFAULT_DIAG = Path.home() / ".config/round-carplay/diagnostics.log"
CDP_JSON = "http://127.0.0.1:9222/json"


class Cdp:
    def __init__(self, url: str) -> None:
        self.ws = websocket.create_connection(url, timeout=10)
        self.next_id = 1

    def close(self) -> None:
        self.ws.close()

    def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 10) -> dict[str, Any]:
        msg_id = self.next_id
        self.next_id += 1
        self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            raw = self.ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == msg_id:
                return msg
        raise TimeoutError(method)

    def eval(self, expression: str, await_promise: bool = False, timeout: float = 10) -> Any:
        res = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
            },
            timeout=timeout,
        )
        result = res.get("result", {}).get("result", {})
        if "exceptionDetails" in res.get("result", {}):
            return {"exception": res["result"]["exceptionDetails"]}
        return result.get("value")

    def mouse(self, event_type: str, x: float, y: float, buttons: int) -> None:
        self.call(
            "Input.dispatchMouseEvent",
            {
                "type": event_type,
                "x": x,
                "y": y,
                "button": "left",
                "buttons": buttons,
                "clickCount": 0 if event_type == "mouseMoved" else 1,
            },
            timeout=2,
        )


def get_page_url() -> str:
    targets = json.load(urllib.request.urlopen(CDP_JSON, timeout=3))
    page = next((t for t in targets if t.get("type") == "page"), None)
    if not page:
        raise RuntimeError("no CDP page target found")
    return page["webSocketDebuggerUrl"]


INSTALL_PROBE = r"""
(() => {
  const old = window.__carplayLagProbe;
  if (old && old.stop) old.stop();

  const p = {
    rafCount: 0,
    rafMaxGap: 0,
    rafGapOver50: 0,
    rafGapOver100: 0,
    rafGapOver250: 0,
    rafGapSum: 0,
    pointerDown: 0,
    pointerMove: 0,
    pointerUp: 0,
    pointerCancel: 0,
    pointerMaxGap: 0,
    pointerLastAt: 0,
    longTaskCount: 0,
    longTaskMax: 0,
    longTaskTotal: 0,
    running: true,
    lastRaf: performance.now()
  };

  function raf(t) {
    if (!p.running) return;
    const gap = t - p.lastRaf;
    p.lastRaf = t;
    p.rafCount++;
    p.rafGapSum += gap;
    if (gap > p.rafMaxGap) p.rafMaxGap = gap;
    if (gap > 50) p.rafGapOver50++;
    if (gap > 100) p.rafGapOver100++;
    if (gap > 250) p.rafGapOver250++;
    requestAnimationFrame(raf);
  }

  function onPointer(e) {
    const now = performance.now();
    if (p.pointerLastAt) {
      const gap = now - p.pointerLastAt;
      if (gap > p.pointerMaxGap) p.pointerMaxGap = gap;
    }
    p.pointerLastAt = now;
    if (e.type === "pointerdown") p.pointerDown++;
    else if (e.type === "pointermove") p.pointerMove++;
    else if (e.type === "pointerup") p.pointerUp++;
    else if (e.type === "pointercancel") p.pointerCancel++;
  }

  const events = ["pointerdown", "pointermove", "pointerup", "pointercancel"];
  for (const ev of events) document.addEventListener(ev, onPointer, true);

  let observer = null;
  try {
    if (typeof PerformanceObserver !== "undefined" &&
        PerformanceObserver.supportedEntryTypes &&
        PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          p.longTaskCount++;
          p.longTaskTotal += entry.duration;
          if (entry.duration > p.longTaskMax) p.longTaskMax = entry.duration;
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    }
  } catch {}

  window.__carplayLagProbe = {
    data: p,
    stop() {
      p.running = false;
      for (const ev of events) document.removeEventListener(ev, onPointer, true);
      if (observer) observer.disconnect();
    },
    snapshot() {
      return {
        rafCount: p.rafCount,
        rafMaxGap: Math.round(p.rafMaxGap * 10) / 10,
        rafAvgGap: p.rafCount ? Math.round((p.rafGapSum / p.rafCount) * 10) / 10 : 0,
        rafGapOver50: p.rafGapOver50,
        rafGapOver100: p.rafGapOver100,
        rafGapOver250: p.rafGapOver250,
        pointerDown: p.pointerDown,
        pointerMove: p.pointerMove,
        pointerUp: p.pointerUp,
        pointerCancel: p.pointerCancel,
        pointerMaxGap: Math.round(p.pointerMaxGap * 10) / 10,
        longTaskCount: p.longTaskCount,
        longTaskMax: Math.round(p.longTaskMax * 10) / 10,
        longTaskTotal: Math.round(p.longTaskTotal * 10) / 10
      };
    }
  };
  requestAnimationFrame(raf);
  return "installed";
})()
"""


STATE_EXPR = r"""
(() => {
  const c = document.getElementById("videoContainer");
  const v = document.getElementById("video");
  const cr = c ? c.getBoundingClientRect() : null;
  const vr = v ? v.getBoundingClientRect() : null;
  const cs = c ? getComputedStyle(c) : null;
  return {
    hash: location.hash,
    text: document.body.innerText.slice(0, 300),
    videoVisible: !!(c && cs && cs.visibility !== "hidden" && cr && cr.width > 0 && cr.height > 0),
    videoContainer: cr ? { x: cr.x, y: cr.y, w: cr.width, h: cr.height } : null,
    canvas: vr ? { x: vr.x, y: vr.y, w: vr.width, h: vr.height } : null,
    visibility: cs ? cs.visibility : null,
    zIndex: cs ? cs.zIndex : null
  };
})()
"""


def apply_settings(cdp: Cdp, patch: dict[str, Any]) -> dict[str, Any]:
    expr = f"""
(async () => {{
  const s = await window.carplay.settings.get();
  Object.assign(s, {json.dumps(patch)});
  await window.carplay.settings.save(s);
  return s;
}})()
"""
    value = cdp.eval(expr, await_promise=True, timeout=10)
    return value if isinstance(value, dict) else {"result": value}


def restart_carplay(cdp: Cdp, wait_seconds: float) -> dict[str, Any]:
    expr = f"""
(async () => {{
  await window.carplay.ipc.stop();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await window.carplay.ipc.start();
  const deadline = Date.now() + {int(wait_seconds * 1000)};
  let state = null;
  while (Date.now() < deadline) {{
    state = {STATE_EXPR};
    if (state && state.videoVisible) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }}
  return state;
}})()
"""
    value = cdp.eval(expr, await_promise=True, timeout=wait_seconds + 5)
    return value if isinstance(value, dict) else {"result": value}


LINE_RE = re.compile(r"^\S+ \[(?P<scope>[^\]]+)\] (?P<msg>\S+)(?: (?P<data>\{.*\}))?$")


def read_new_diag(path: Path, offset: int) -> tuple[str, int]:
    if not path.exists():
        return "", 0
    size = path.stat().st_size
    if size < offset:
        offset = 0
    with path.open("r", errors="replace") as f:
        f.seek(offset)
        text = f.read()
        return text, f.tell()


def marker_expr(test_id: str, phase: str, extra: dict[str, Any] | None = None) -> str:
    payload = {"id": test_id, "phase": phase, **(extra or {})}
    return f"""
(() => {{
  try {{ window.carplay?.diagnostics?.log('lag-probe', {json.dumps(payload)}); }} catch {{}}
  return true;
}})()
"""


def extract_marked_window(text: str, test_id: str) -> tuple[str, dict[str, Any]]:
    lines: list[str] = []
    in_window = False
    found_start = False
    found_end = False

    for line in text.splitlines():
      m = LINE_RE.match(line)
      if m and m.group("scope") == "renderer" and m.group("msg") == "lag-probe":
          data: dict[str, Any] = {}
          raw = m.group("data")
          if raw:
              try:
                  data = json.loads(raw)
              except Exception:
                  data = {}
          if data.get("id") == test_id:
              phase = data.get("phase")
              if phase == "start":
                  in_window = True
                  found_start = True
                  lines = []
                  continue
              if phase == "end" and in_window:
                  found_end = True
                  break

      if in_window:
          lines.append(line)

    if found_start:
        return "\n".join(lines), {
            "id": test_id,
            "marked": True,
            "foundStart": found_start,
            "foundEnd": found_end,
            "lines": len(lines),
        }

    return text, {
        "id": test_id,
        "marked": False,
        "foundStart": False,
        "foundEnd": False,
        "lines": len(text.splitlines()),
        "warning": "marker not found; parsed raw offset window",
    }


def parse_diag(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "touch": {"stats": 0, "received": 0, "sent": 0, "failed": 0, "slow": 0, "maxAgeMs": 0, "maxQueueDepth": 0},
        "video": {"stats": 0, "frames": 0, "maxGap": 0, "stall": 0, "stallMaxElapsedMs": 0},
        "dongle": {"readGap": 0, "readGapMaxMs": 0, "sendSlow": 0, "sendFailed": 0},
        "renderer": {"decoderBacklog": 0, "staleVideoDrop": 0},
        "carplay": {"phoneUnplugged": 0, "driverFailure": 0, "resolution": 0},
        "rendererLongTask": {"count": 0, "max": 0},
        "mainLoop": {"count": 0, "maxMs": 0, "p99Ms": 0},
        "latency": {"stats": 0, "count": 0, "avgMs": 0, "p95Ms": 0, "maxMs": 0},
        "lines": 0,
    }
    fps_weighted_frames = 0
    fps_weighted_ms = 0
    latency_weighted_ms = 0

    for line in text.splitlines():
        m = LINE_RE.match(line)
        if not m:
            continue
        out["lines"] += 1
        scope = m.group("scope")
        msg = m.group("msg")
        raw = m.group("data")
        data: dict[str, Any] = {}
        if raw:
            try:
                data = json.loads(raw)
            except Exception:
                data = {}

        if scope == "touch" and msg == "stats":
            t = out["touch"]
            t["stats"] += 1
            for key in ("received", "sent", "failed", "slow"):
                t[key] += int(data.get(key) or 0)
            t["maxAgeMs"] = max(t["maxAgeMs"], int(data.get("maxAgeMs") or 0))
            t["maxQueueDepth"] = max(t["maxQueueDepth"], int(data.get("maxQueueDepth") or 0))
        elif scope == "touch" and msg == "slow-send":
            t = out["touch"]
            t["slow"] += 1
            t["maxAgeMs"] = max(t["maxAgeMs"], int(data.get("ageMs") or 0))
        elif scope == "video" and msg == "stats":
            v = out["video"]
            v["stats"] += 1
            frames = int(data.get("frames") or 0)
            ms = int(data.get("ms") or 0)
            v["frames"] += frames
            v["maxGap"] = max(v["maxGap"], int(data.get("maxGap") or 0))
            fps_weighted_frames += frames
            fps_weighted_ms += ms
        elif scope == "video" and msg == "stall":
            v = out["video"]
            v["stall"] += 1
            v["stallMaxElapsedMs"] = max(v["stallMaxElapsedMs"], int(data.get("elapsedMs") or 0))
        elif scope == "dongle" and msg == "read-gap":
            d = out["dongle"]
            d["readGap"] += 1
            d["readGapMaxMs"] = max(d["readGapMaxMs"], int(data.get("gapMs") or 0))
        elif scope == "dongle" and msg == "send-slow":
            d = out["dongle"]
            d["sendSlow"] += 1
            if data.get("ok") is False:
                d["sendFailed"] += 1
        elif scope == "renderer" and msg == "decoder-backlog":
            out["renderer"]["decoderBacklog"] += 1
        elif scope == "renderer" and msg == "stale-video-drop":
            out["renderer"]["staleVideoDrop"] += 1
        elif scope == "renderer" and msg == "long-task":
            lt = out["rendererLongTask"]
            lt["count"] += int(data.get("count") or 1)
            lt["max"] = max(lt["max"], int(data.get("max") or 0))
        elif scope == "main-loop" and msg == "delay":
            ml = out["mainLoop"]
            ml["count"] += 1
            ml["maxMs"] = max(ml["maxMs"], float(data.get("maxMs") or 0))
            ml["p99Ms"] = max(ml["p99Ms"], float(data.get("p99Ms") or 0))
        elif scope == "latency" and msg == "touch-to-video":
            lat = out["latency"]
            count = int(data.get("count") or 0)
            avg = int(data.get("avgMs") or 0)
            lat["stats"] += 1
            lat["count"] += count
            latency_weighted_ms += count * avg
            lat["p95Ms"] = max(lat["p95Ms"], int(data.get("p95Ms") or 0))
            lat["maxMs"] = max(lat["maxMs"], int(data.get("maxMs") or 0))
        elif scope == "carplay" and msg == "phone-unplugged":
            out["carplay"]["phoneUnplugged"] += 1
        elif scope == "carplay" and msg == "driver-failure":
            out["carplay"]["driverFailure"] += 1
        elif scope == "carplay" and msg == "resolution":
            out["carplay"]["resolution"] += 1

    out["video"]["fpsApprox"] = round((fps_weighted_frames * 1000 / fps_weighted_ms), 1) if fps_weighted_ms else 0
    out["latency"]["avgMs"] = round(latency_weighted_ms / out["latency"]["count"]) if out["latency"]["count"] else 0
    return out


def start_usbmon_capture(bus: int, seconds: float) -> tuple[subprocess.Popen[str], Any, Path, int]:
    """Start a bounded usbmon capture on the Pi.

    This script is normally run on the Pi with passwordless sudo. Using `timeout`
    keeps the capture from surviving a failed CDP/probe run.
    """
    subprocess.run(["sudo", "modprobe", "usbmon"], check=False)
    out_path = Path(f"/tmp/usbmon_lag_{int(time.time() * 1000)}.txt")
    out_file = out_path.open("w")
    duration = str(max(3, int(math.ceil(seconds))))
    start_monotonic_us = int(time.monotonic() * 1_000_000)
    proc = subprocess.Popen(
        [
            "sudo",
            "timeout",
            duration,
            "cat",
            f"/sys/kernel/debug/usb/usbmon/{bus}u",
        ],
        stdout=out_file,
        stderr=subprocess.PIPE,
        text=True,
    )
    return proc, out_file, out_path, start_monotonic_us


def finish_usbmon_capture(
    proc: subprocess.Popen[str],
    out_file: Any,
    out_path: Path,
    start_monotonic_us: int,
    device: str,
    top: int,
) -> dict[str, Any]:
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
    finally:
        end_monotonic_us = int(time.monotonic() * 1_000_000)
        out_file.close()

    stderr = ""
    try:
        stderr = (proc.stderr.read() if proc.stderr else "") or ""
    finally:
        if proc.stderr:
            proc.stderr.close()

    try:
        from usbmon_summarize import summarize

        summary = summarize(out_path, device, top, end_monotonic_us)
        summary["returnCode"] = proc.returncode
        summary["captureStartUs"] = start_monotonic_us
        summary["captureEndUs"] = end_monotonic_us
        summary["captureWallDurationMs"] = round((end_monotonic_us - start_monotonic_us) / 1000, 3)
        if stderr.strip():
            summary["stderr"] = stderr.strip()
        return summary
    except Exception as exc:
        return {
            "file": str(out_path),
            "device": device,
            "returnCode": proc.returncode,
            "captureStartUs": start_monotonic_us,
            "captureEndUs": end_monotonic_us,
            "stderr": stderr.strip(),
            "error": str(exc),
        }


def verdict(result: dict[str, Any]) -> list[str]:
    notes: list[str] = []
    state = result["stateBefore"]
    ui = result["ui"]
    diag = result["diagnostics"]
    usbmon = result.get("usbmon") or {}
    bi_stats = (usbmon.get("pendingStatsIncludingOpen") or {}).get("Bi") or (
        (usbmon.get("pendingStats") or {}).get("Bi") or {}
    )
    usb_bi_max = float(bi_stats.get("maxMs") or 0)
    if not state.get("videoVisible"):
        notes.append("NOT_STREAMING: CarPlay canvas was hidden; synthetic drag is not a valid live CarPlay test.")
    if ui.get("rafMaxGap", 0) > 250 or ui.get("longTaskMax", 0) > 250:
        notes.append("UI_JANK: renderer main thread had >250 ms scheduling/long-task gap.")
    elif ui.get("rafMaxGap", 0) > 100 or ui.get("longTaskMax", 0) > 100:
        notes.append("UI_WARN: renderer main thread had >100 ms scheduling/long-task gap.")
    else:
        notes.append("UI_OK: renderer main thread stayed responsive by rAF/long-task probe.")

    ml = diag.get("mainLoop", {})
    if ml.get("maxMs", 0) > 250:
        notes.append("MAIN_LOOP_LAG: Electron main process event loop had >250 ms delay.")
    elif ml.get("maxMs", 0) > 100:
        notes.append("MAIN_LOOP_WARN: Electron main process event loop had >100 ms delay.")
    elif ml.get("count", 0):
        notes.append("MAIN_LOOP_OK: Electron main loop diagnostics did not show >100 ms delay.")

    t = diag["touch"]
    if t["maxAgeMs"] > 250 or t["failed"]:
        notes.append("TOUCH_LAG: touch queue/send path showed stale or failed sends.")
    elif t["sent"]:
        notes.append("TOUCH_OK: touch sends were observed without stale queue growth.")
    else:
        notes.append("TOUCH_UNKNOWN: no touch stats were observed in diagnostics.")

    lat = diag["latency"]
    if lat["maxMs"] > 1000 or lat["p95Ms"] > 750:
        notes.append("TOUCH_VIDEO_LAG: touch-to-next-video latency was high.")
    elif lat["count"]:
        notes.append("TOUCH_VIDEO_OK: touch-to-next-video latency was measured under 1 s.")

    v = diag["video"]
    d = diag["dongle"]
    if v["stall"] or v["maxGap"] > 1000 or d["readGapMaxMs"] > 1000:
        if usb_bi_max and usb_bi_max <= 1000 and lat["p95Ms"] <= 750:
            notes.append(
                "VIDEO_GAP_WARN: app diagnostics saw a >1 s video/read gap, "
                "but paired usbmon and touch-to-video latency stayed under 1 s."
            )
        else:
            notes.append("VIDEO_INGRESS_LAG: incoming video/dongle reads had >1 s gaps during the window.")
    elif v["stats"]:
        notes.append("VIDEO_INGRESS_OK: video stats did not show >1 s gaps.")
    else:
        notes.append("VIDEO_UNKNOWN: no video stats were observed in diagnostics.")

    if usb_bi_max > 1000:
        notes.append("USB_IN_WAIT: paired usbmon saw a submitted bulk-IN read pending for >1 s.")
    elif usb_bi_max:
        notes.append("USB_IN_OK: paired usbmon did not show >1 s bulk-IN pending waits.")

    if diag["carplay"]["phoneUnplugged"] or diag["carplay"]["driverFailure"]:
        notes.append("SESSION_DROP: phone-unplugged or driver-failure occurred during the test.")
    return notes


def perform_drag(
    cdp: Cdp,
    state: dict[str, Any] | None,
    seconds: float,
    hz: float,
    radius: float,
    gesture: str,
) -> bool:
    center = None
    rect = None
    if state and state.get("videoContainer"):
        rect = state["videoContainer"]
        if rect["w"] > 0 and rect["h"] > 0:
            center = (rect["x"] + rect["w"] / 2, rect["y"] + rect["h"] / 2)
    if center is None:
        center = (400, 400)
    if not rect and gesture in ("swipe-left", "swipe-right"):
        return False

    if gesture == "swipe-left" and rect:
        start_point = (center[0] + rect["w"] * 0.34, center[1])
    elif gesture == "swipe-right" and rect:
        start_point = (center[0] - rect["w"] * 0.34, center[1])
    else:
        start_point = center

    cdp.mouse("mousePressed", start_point[0], start_point[1], 1)
    start = time.time()
    next_tick = start
    while time.time() - start < seconds:
        t = time.time() - start
        progress = min(1.0, t / max(0.001, seconds))
        if gesture == "swipe-left" and rect:
            x = start_point[0] - rect["w"] * 0.68 * progress
            y = start_point[1]
        elif gesture == "swipe-right" and rect:
            x = start_point[0] + rect["w"] * 0.68 * progress
            y = start_point[1]
        elif gesture == "left-right":
            x = center[0] + radius * math.sin(t * 4.0)
            y = center[1]
        else:
            x = center[0] + radius * math.sin(t * 3.0)
            y = center[1] + radius * math.cos(t * 3.0)
        cdp.mouse("mouseMoved", x, y, 1)
        next_tick += 1.0 / hz
        time.sleep(max(0.0, next_tick - time.time()))
    cdp.mouse("mouseReleased", center[0], center[1], 0)
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=20)
    ap.add_argument("--hz", type=float, default=30)
    ap.add_argument("--radius", type=float, default=120)
    ap.add_argument(
        "--gesture",
        choices=["circle", "swipe-left", "swipe-right", "left-right"],
        default="circle",
        help="synthetic pointer gesture to drive over the CarPlay square",
    )
    ap.add_argument("--diag", type=Path, default=DEFAULT_DIAG)
    ap.add_argument("--force-drag", action="store_true", help="drag even if video surface is hidden")
    ap.add_argument("--no-drag", action="store_true", help="passively measure without synthetic touch input")
    ap.add_argument("--warmup-seconds", type=float, default=0, help="optional unmeasured pre-drag to wake active video")
    ap.add_argument("--send-frame-hz", type=float, default=0, help="pump window.carplay.ipc.sendFrame() during the test")
    ap.add_argument("--frame-interval-ms", type=int, help="persist CarPlay phoneConfig frameInterval for this app config")
    ap.add_argument("--fps", type=int, help="persist negotiated CarPlay FPS for this app config")
    ap.add_argument("--width", type=int, help="persist negotiated CarPlay width for this app config")
    ap.add_argument("--height", type=int, help="persist negotiated CarPlay height for this app config")
    ap.add_argument("--media-delay", type=int, help="persist dongle mediaDelay for this app config")
    ap.add_argument("--wifi-type", choices=["5ghz", "2.4ghz"], help="persist dongle Wi-Fi band for this app config")
    ap.add_argument("--audio-transfer-mode", choices=["on", "off"], help="persist dongle audioTransferMode for this app config")
    ap.add_argument("--pointer-capture", choices=["on", "off"], help="persist diagnostic pointer-capture touch mode")
    ap.add_argument("--touch-frame-kick", choices=["on", "off"], help="persist diagnostic touch-triggered frame command mode")
    ap.add_argument("--restart-carplay", action="store_true", help="stop/start CarPlay after settings changes")
    ap.add_argument("--restart-wait", type=float, default=12, help="seconds to wait for visible video after restart")
    ap.add_argument("--backdrop", choices=["on", "off"])
    ap.add_argument("--ambient-fill", choices=["on", "off"])
    ap.add_argument("--plain", choices=["on", "off"])
    ap.add_argument("--usbmon-bus", type=int, help="capture /sys/kernel/debug/usb/usbmon/<bus>u during the probe")
    ap.add_argument("--usbmon-device", default="3:003", help="usbmon device tuple to summarize, e.g. 3:003")
    ap.add_argument("--usbmon-top", type=int, default=8, help="number of top usbmon gaps to include")
    args = ap.parse_args()

    patch: dict[str, Any] = {}
    if args.backdrop:
        patch["backdropEnabled"] = args.backdrop == "on"
        if args.backdrop == "on":
            patch["ambientFillEnabled"] = False
    if args.ambient_fill:
        patch["ambientFillEnabled"] = args.ambient_fill == "on"
        if args.ambient_fill == "on":
            patch["backdropEnabled"] = False
    if args.plain:
        patch["diagnosticPlainCarplay"] = args.plain == "on"
    if args.frame_interval_ms is not None:
        patch["phoneConfig"] = {
            "3": {"frameInterval": args.frame_interval_ms},
            "5": {"frameInterval": None},
        }
    if args.fps is not None:
        patch["fps"] = args.fps
    if args.width is not None:
        patch["width"] = args.width
    if args.height is not None:
        patch["height"] = args.height
    if args.media_delay is not None:
        patch["mediaDelay"] = args.media_delay
    if args.wifi_type is not None:
        patch["wifiType"] = args.wifi_type
    if args.audio_transfer_mode is not None:
        patch["audioTransferMode"] = args.audio_transfer_mode == "on"
    if args.pointer_capture is not None:
        pointer_capture_enabled = args.pointer_capture == "on"
        patch["pointerCaptureTouch"] = pointer_capture_enabled
        patch["diagnosticPointerCaptureTouch"] = pointer_capture_enabled
    if args.touch_frame_kick is not None:
        patch["diagnosticTouchFrameKick"] = args.touch_frame_kick == "on"

    cdp = Cdp(get_page_url())
    usbmon: tuple[subprocess.Popen[str], Any, Path, int] | None = None
    try:
        cdp.call("Page.enable")
        cdp.call("Runtime.enable")
        settings_after = apply_settings(cdp, patch) if patch else None
        if patch:
            time.sleep(0.7)
        restart_state = restart_carplay(cdp, args.restart_wait) if args.restart_carplay else None

        state_before = cdp.eval(STATE_EXPR)
        if (
            args.warmup_seconds > 0
            and not args.no_drag
            and (args.force_drag or bool(state_before and state_before.get("videoVisible")))
        ):
            perform_drag(cdp, state_before, args.warmup_seconds, args.hz, args.radius, args.gesture)
            time.sleep(0.5)
            state_before = cdp.eval(STATE_EXPR)

        cdp.eval(INSTALL_PROBE)
        test_id = f"lag-{int(time.time() * 1000)}-{os.getpid()}"
        diag_offset = args.diag.stat().st_size if args.diag.exists() else 0
        if args.usbmon_bus is not None:
            usbmon = start_usbmon_capture(args.usbmon_bus, args.seconds + 4)
            time.sleep(0.2)
        cdp.eval(marker_expr(test_id, "start", {
            "gesture": args.gesture,
            "seconds": args.seconds,
            "backdrop": args.backdrop,
            "ambientFill": args.ambient_fill,
            "plain": args.plain,
            "audioTransferMode": args.audio_transfer_mode,
            "pointerCapture": args.pointer_capture,
            "touchFrameKick": args.touch_frame_kick,
        }))
        if args.send_frame_hz > 0:
            interval_ms = max(16, int(1000 / args.send_frame_hz))
            cdp.eval(
                f"""
(() => {{
  if (window.__carplayFramePump) clearInterval(window.__carplayFramePump);
  window.__carplayFramePump = setInterval(() => {{
    try {{ window.carplay.ipc.sendFrame(); }} catch {{}}
  }}, {interval_ms});
  return {interval_ms};
}})()
"""
            )

        should_drag = (
            False
            if args.no_drag
            else args.force_drag or bool(state_before and state_before.get("videoVisible"))
        )

        if should_drag:
            perform_drag(cdp, state_before, args.seconds, args.hz, args.radius, args.gesture)
        else:
            time.sleep(args.seconds)

        time.sleep(1.0)
        if args.send_frame_hz > 0:
            cdp.eval("(() => { if (window.__carplayFramePump) clearInterval(window.__carplayFramePump); window.__carplayFramePump = null; return true; })()")
        cdp.eval(marker_expr(test_id, "end"))
        time.sleep(0.2)
        ui = cdp.eval("window.__carplayLagProbe && window.__carplayLagProbe.snapshot()")
        state_after = cdp.eval(STATE_EXPR)
        diag_text, _ = read_new_diag(args.diag, diag_offset)
        marked_diag_text, diag_window = extract_marked_window(diag_text, test_id)
        usbmon_summary = (
            finish_usbmon_capture(
                usbmon[0],
                usbmon[1],
                usbmon[2],
                usbmon[3],
                args.usbmon_device,
                args.usbmon_top,
            )
            if usbmon
            else None
        )
        result = {
            "seconds": args.seconds,
            "dragAttempted": should_drag,
            "gesture": args.gesture,
            "passive": args.no_drag,
            "warmupSeconds": args.warmup_seconds,
            "sendFrameHz": args.send_frame_hz,
            "frameIntervalMs": args.frame_interval_ms,
            "fps": args.fps,
            "width": args.width,
            "height": args.height,
            "mediaDelay": args.media_delay,
            "wifiType": args.wifi_type,
            "audioTransferMode": args.audio_transfer_mode,
            "pointerCapture": args.pointer_capture,
            "touchFrameKick": args.touch_frame_kick,
            "restartState": restart_state,
            "settingsAfter": settings_after,
            "stateBefore": state_before,
            "stateAfter": state_after,
            "ui": ui or {},
            "diagnosticWindow": diag_window,
            "diagnostics": parse_diag(marked_diag_text),
            "usbmon": usbmon_summary,
        }
        result["verdict"] = verdict(result)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if state_before and state_before.get("videoVisible") else 2
    finally:
        cdp.close()


if __name__ == "__main__":
    sys.exit(main())
