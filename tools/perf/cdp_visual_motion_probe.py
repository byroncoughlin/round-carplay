#!/usr/bin/env python3
"""Measure whether synthetic CarPlay input produces visible pixel motion.

This complements cdp_carplay_lag_probe.py. The lag probe can prove that touch
events were sent and that video USB reads paused, but if the current CarPlay
screen is visually static, a long time to the next video frame may be normal.

Run on the Pi while the app has CDP enabled:
  --remote-debugging-port=9222 --remote-allow-origins=*

The script crops the CarPlay video square from repeated screenshots while a
controlled drag is held, then reports frame-to-frame pixel deltas.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import time
import urllib.request
from pathlib import Path
from typing import Any

import websocket
from PIL import Image, ImageChops, ImageStat


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
            msg = json.loads(self.ws.recv())
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

    def screenshot(self) -> Image.Image:
        res = self.call("Page.captureScreenshot", {"format": "png", "fromSurface": True}, timeout=10)
        data = res.get("result", {}).get("data")
        if not data:
            raise RuntimeError("Page.captureScreenshot did not return data")
        return Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB")


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


def get_page_url() -> str:
    targets = json.load(urllib.request.urlopen(CDP_JSON, timeout=3))
    page = next((t for t in targets if t.get("type") == "page"), None)
    if not page:
        raise RuntimeError("no CDP page target found")
    return page["webSocketDebuggerUrl"]


def crop_video(img: Image.Image, rect: dict[str, float]) -> Image.Image:
    left = max(0, int(round(rect["x"])))
    top = max(0, int(round(rect["y"])))
    right = min(img.width, int(round(rect["x"] + rect["w"])))
    bottom = min(img.height, int(round(rect["y"] + rect["h"])))
    return img.crop((left, top, right, bottom))


def diff_stats(a: Image.Image, b: Image.Image, threshold: int) -> dict[str, float]:
    if a.size != b.size:
        b = b.resize(a.size)
    diff = ImageChops.difference(a, b)
    stat = ImageStat.Stat(diff)
    mean_abs = sum(stat.mean) / len(stat.mean)
    extrema = diff.getextrema()
    max_abs = max(channel[1] for channel in extrema)
    gray = diff.convert("L")
    changed = 0
    total = gray.width * gray.height
    for value in gray.getdata():
        if value >= threshold:
            changed += 1
    return {
        "meanAbs": round(mean_abs, 3),
        "maxAbs": int(max_abs),
        "changedPct": round((changed * 100.0) / total, 3) if total else 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=10)
    parser.add_argument("--hz", type=float, default=15)
    parser.add_argument("--radius", type=float, default=80)
    parser.add_argument(
        "--gesture",
        choices=["circle", "swipe-left", "swipe-right", "left-right"],
        default="circle",
    )
    parser.add_argument("--samples", type=int, default=8)
    parser.add_argument("--threshold", type=int, default=10)
    parser.add_argument("--out-dir", type=Path, help="optional directory for cropped PNG samples")
    args = parser.parse_args()

    cdp = Cdp(get_page_url())
    crops: list[Image.Image] = []
    sample_times: list[float] = []
    try:
        cdp.call("Page.enable")
        cdp.call("Runtime.enable")
        state_before = cdp.eval(STATE_EXPR)
        rect = (state_before or {}).get("videoContainer")
        if not state_before or not state_before.get("videoVisible") or not rect:
            print(json.dumps({
                "stateBefore": state_before,
                "valid": False,
                "reason": "video surface is not visible",
            }, indent=2))
            return 2

        center = (rect["x"] + rect["w"] / 2, rect["y"] + rect["h"] / 2)
        interval = args.seconds / max(1, args.samples - 1)
        next_sample = 0.0
        sample_index = 0

        if args.gesture == "swipe-left":
            start_point = (center[0] + rect["w"] * 0.34, center[1])
        elif args.gesture == "swipe-right":
            start_point = (center[0] - rect["w"] * 0.34, center[1])
        else:
            start_point = center

        cdp.mouse("mousePressed", start_point[0], start_point[1], 1)
        start = time.time()
        next_tick = start
        while time.time() - start < args.seconds:
            elapsed = time.time() - start
            progress = min(1.0, elapsed / max(0.001, args.seconds))
            if args.gesture == "swipe-left":
                x = start_point[0] - rect["w"] * 0.68 * progress
                y = start_point[1]
            elif args.gesture == "swipe-right":
                x = start_point[0] + rect["w"] * 0.68 * progress
                y = start_point[1]
            elif args.gesture == "left-right":
                x = center[0] + args.radius * math.sin(elapsed * 4.0)
                y = center[1]
            else:
                x = center[0] + args.radius * math.sin(elapsed * 3.0)
                y = center[1] + args.radius * math.cos(elapsed * 3.0)
            cdp.mouse("mouseMoved", x, y, 1)

            if elapsed >= next_sample and sample_index < args.samples:
                img = cdp.screenshot()
                crops.append(crop_video(img, rect))
                sample_times.append(round(elapsed, 3))
                sample_index += 1
                next_sample += interval

            next_tick += 1.0 / args.hz
            time.sleep(max(0.0, next_tick - time.time()))
        cdp.mouse("mouseReleased", center[0], center[1], 0)

        if not crops:
            img = cdp.screenshot()
            crops.append(crop_video(img, rect))
            sample_times.append(round(time.time() - start, 3))

        if args.out_dir:
            args.out_dir.mkdir(parents=True, exist_ok=True)
            for i, crop in enumerate(crops):
                crop.save(args.out_dir / f"sample_{i:02d}.png")

        diffs = [
            diff_stats(crops[i - 1], crops[i], args.threshold)
            for i in range(1, len(crops))
        ]
        max_changed = max((d["changedPct"] for d in diffs), default=0)
        avg_changed = round(sum(d["changedPct"] for d in diffs) / len(diffs), 3) if diffs else 0
        max_mean_abs = max((d["meanAbs"] for d in diffs), default=0)
        result = {
            "valid": True,
            "seconds": args.seconds,
            "samples": len(crops),
            "sampleTimes": sample_times,
            "stateBefore": state_before,
            "motion": {
                "avgChangedPct": avg_changed,
                "maxChangedPct": max_changed,
                "maxMeanAbs": max_mean_abs,
                "threshold": args.threshold,
                "framesWithGt1PctChange": sum(1 for d in diffs if d["changedPct"] > 1.0),
                "framesWithGt5PctChange": sum(1 for d in diffs if d["changedPct"] > 5.0),
            },
            "diffs": diffs,
            "verdict": (
                "VISUAL_MOTION"
                if max_changed > 5.0 or avg_changed > 1.0
                else "VISUAL_STATIC_OR_LOW_MOTION"
            ),
        }
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    finally:
        try:
            cdp.mouse("mouseReleased", 400, 400, 0)
        except Exception:
            pass
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
