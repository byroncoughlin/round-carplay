#!/usr/bin/env python3
"""Run a repeatable CarPlay lag matrix across visual modes.

This is a thin orchestrator around cdp_carplay_lag_probe.py. It runs the same
verified active gesture in:

  - black/off: backdrop off, ambient fill off
  - backdrop: live blurred backdrop on
  - ambient: static ambient fill on

Each raw probe JSON is saved, and a compact aggregate summary is printed. Run on
the Pi while the app has CDP enabled.
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


MODES = {
    "black": ["--backdrop", "off", "--ambient-fill", "off"],
    "backdrop": ["--backdrop", "on", "--ambient-fill", "off"],
    "ambient": ["--backdrop", "off", "--ambient-fill", "on"],
}


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(len(ordered) * pct) - 1))
    return ordered[index]


def number_at(row: dict[str, Any], path: list[str], default: float = 0.0) -> float:
    cur: Any = row
    for key in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(key)
    try:
        return float(cur)
    except (TypeError, ValueError):
        return default


def summarize_mode(rows: list[dict[str, Any]]) -> dict[str, Any]:
    def values(path: list[str]) -> list[float]:
        return [number_at(row, path) for row in rows]

    latency_p95 = values(["diagnostics", "latency", "p95Ms"])
    latency_max = values(["diagnostics", "latency", "maxMs"])
    video_fps = values(["diagnostics", "video", "fpsApprox"])
    video_gap = values(["diagnostics", "video", "maxGap"])
    dongle_gap = values(["diagnostics", "dongle", "readGapMaxMs"])
    usb_bi_p95 = [
        max(
            number_at(row, ["usbmon", "pendingStatsIncludingOpen", "Bi", "p95Ms"]),
            number_at(row, ["usbmon", "pendingStats", "Bi", "p95Ms"]),
        )
        for row in rows
    ]
    usb_bi_max = [
        max(
            number_at(row, ["usbmon", "pendingStatsIncludingOpen", "Bi", "maxMs"]),
            number_at(row, ["usbmon", "pendingStats", "Bi", "maxMs"]),
        )
        for row in rows
    ]
    raf_max = values(["ui", "rafMaxGap"])
    touch_age = values(["diagnostics", "touch", "maxAgeMs"])
    touch_failed = values(["diagnostics", "touch", "failed"])
    sessions = values(["diagnostics", "carplay", "phoneUnplugged"])

    return {
        "runs": len(rows),
        "latencyP95AvgMs": round(statistics.mean(latency_p95), 1) if latency_p95 else 0,
        "latencyP95WorstMs": round(max(latency_p95), 1) if latency_p95 else 0,
        "latencyMaxWorstMs": round(max(latency_max), 1) if latency_max else 0,
        "videoFpsAvg": round(statistics.mean(video_fps), 1) if video_fps else 0,
        "videoGapWorstMs": round(max(video_gap), 1) if video_gap else 0,
        "dongleReadGapWorstMs": round(max(dongle_gap), 1) if dongle_gap else 0,
        "usbBulkInP95AvgMs": round(statistics.mean(usb_bi_p95), 1) if usb_bi_p95 else 0,
        "usbBulkInMaxWorstMs": round(max(usb_bi_max), 1) if usb_bi_max else 0,
        "uiRafMaxWorstMs": round(max(raf_max), 1) if raf_max else 0,
        "touchMaxAgeWorstMs": round(max(touch_age), 1) if touch_age else 0,
        "touchFailedTotal": int(sum(touch_failed)),
        "phoneUnpluggedTotal": int(sum(sessions)),
        "samples": {
            "latencyP95Ms": latency_p95,
            "videoGapMs": video_gap,
            "usbBulkInMaxMs": usb_bi_max,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--modes",
        default="black,backdrop,ambient",
        help="comma-separated modes to run: black, backdrop, ambient",
    )
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--seconds", type=float, default=10)
    parser.add_argument("--warmup-seconds", type=float, default=3)
    parser.add_argument("--hz", type=float, default=12)
    parser.add_argument("--gesture", default="swipe-left")
    parser.add_argument("--wifi-type", choices=["5ghz", "2.4ghz"], help="persist dongle Wi-Fi band before probing")
    parser.add_argument("--audio-transfer-mode", choices=["on", "off"], help="persist dongle audioTransferMode before probing")
    parser.add_argument("--width", type=int, help="persist negotiated CarPlay width before probing")
    parser.add_argument("--height", type=int, help="persist negotiated CarPlay height before probing")
    parser.add_argument("--fps", type=int, help="persist negotiated CarPlay FPS before probing")
    parser.add_argument("--media-delay", type=int, help="persist dongle mediaDelay before probing")
    parser.add_argument("--plain", choices=["on", "off"], help="persist plain-CarPlay diagnostic mode before probing")
    parser.add_argument("--restart-first", action="store_true", help="restart CarPlay on the first rep of each mode")
    parser.add_argument("--restart-each", action="store_true", help="restart CarPlay before every rep")
    parser.add_argument("--restart-wait", type=float, default=18)
    parser.add_argument("--usbmon-bus", type=int, default=3)
    parser.add_argument("--usbmon-device", default="3:003")
    parser.add_argument("--out-dir", type=Path, default=Path("/tmp/round-lag-matrix"))
    parser.add_argument("--probe", type=Path, default=Path(__file__).with_name("cdp_carplay_lag_probe.py"))
    args = parser.parse_args()

    mode_names = [mode.strip() for mode in args.modes.split(",") if mode.strip()]
    unknown_modes = [mode for mode in mode_names if mode not in MODES]
    if unknown_modes:
        parser.error(f"unknown mode(s): {', '.join(unknown_modes)}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    all_rows: dict[str, list[dict[str, Any]]] = {mode: [] for mode in mode_names}
    failures: list[dict[str, Any]] = []

    for mode in mode_names:
        mode_args = MODES[mode]
        for rep in range(1, args.reps + 1):
            out_file = args.out_dir / f"{mode}_{rep}.json"
            cmd = [
                sys.executable,
                str(args.probe),
                "--seconds",
                str(args.seconds),
                "--hz",
                str(args.hz),
                "--warmup-seconds",
                str(args.warmup_seconds),
                "--gesture",
                args.gesture,
                "--usbmon-bus",
                str(args.usbmon_bus),
                "--usbmon-device",
                args.usbmon_device,
                "--usbmon-top",
                "6",
                *mode_args,
            ]
            if args.wifi_type:
                cmd.extend(["--wifi-type", args.wifi_type])
            if args.audio_transfer_mode:
                cmd.extend(["--audio-transfer-mode", args.audio_transfer_mode])
            if args.width is not None:
                cmd.extend(["--width", str(args.width)])
            if args.height is not None:
                cmd.extend(["--height", str(args.height)])
            if args.fps is not None:
                cmd.extend(["--fps", str(args.fps)])
            if args.media_delay is not None:
                cmd.extend(["--media-delay", str(args.media_delay)])
            if args.plain:
                cmd.extend(["--plain", args.plain])
            if args.restart_each or (args.restart_first and rep == 1):
                cmd.extend(["--restart-carplay", "--restart-wait", str(args.restart_wait)])
            print(f"RUN {mode} {rep}/{args.reps}", flush=True)
            started = time.time()
            proc = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            duration = round(time.time() - started, 2)
            out_file.write_text(proc.stdout)

            try:
                row = json.loads(proc.stdout)
                row["matrixMode"] = mode
                row["matrixRep"] = rep
                row["matrixDurationSeconds"] = duration
                all_rows[mode].append(row)
            except json.JSONDecodeError as exc:
                failures.append({
                    "mode": mode,
                    "rep": rep,
                    "returnCode": proc.returncode,
                    "error": str(exc),
                    "stderr": proc.stderr[-1000:],
                    "stdoutFile": str(out_file),
                })
                continue

            if proc.returncode != 0:
                failures.append({
                    "mode": mode,
                    "rep": rep,
                    "returnCode": proc.returncode,
                    "stderr": proc.stderr[-1000:],
                    "stdoutFile": str(out_file),
                })

            time.sleep(2)

    summary = {
        "outDir": str(args.out_dir),
        "reps": args.reps,
        "seconds": args.seconds,
        "warmupSeconds": args.warmup_seconds,
        "hz": args.hz,
        "gesture": args.gesture,
        "modesRequested": mode_names,
        "wifiType": args.wifi_type,
        "audioTransferMode": args.audio_transfer_mode,
        "width": args.width,
        "height": args.height,
        "fps": args.fps,
        "mediaDelay": args.media_delay,
        "plain": args.plain,
        "restartFirst": args.restart_first,
        "restartEach": args.restart_each,
        "usbmonBus": args.usbmon_bus,
        "usbmonDevice": args.usbmon_device,
        "modes": {mode: summarize_mode(rows) for mode, rows in all_rows.items()},
        "failures": failures,
    }
    summary_file = args.out_dir / "summary.json"
    summary_file.write_text(json.dumps(summary, indent=2, sort_keys=True))
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
