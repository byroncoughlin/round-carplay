#!/usr/bin/env python3
"""Summarize usbmon text captures for the CarPlay dongle.

Example:
  sudo timeout 24 cat /sys/kernel/debug/usb/usbmon/3u > /tmp/usbmon.txt
  python3 tools/perf/usbmon_summarize.py /tmp/usbmon.txt --device 3:003

The important signal for the lag investigation is a long submitted IN URB
(`S Bi`) that does not complete (`C Bi`) for hundreds/thousands of ms. That
means the kernel was waiting for the USB device to provide data, not that the
Electron app was late reading already-available data.
"""

from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path
from typing import Any

MESSAGE_TYPES = {
    0x01: "Open",
    0x02: "Plugged",
    0x03: "Phase",
    0x04: "Unplugged",
    0x05: "Touch",
    0x06: "VideoData",
    0x07: "AudioData",
    0x08: "Command",
    0x09: "LogoType",
    0x0A: "BluetoothAddress",
    0x0C: "BluetoothPIN",
    0x0D: "BluetoothDeviceName",
    0x0E: "WifiDeviceName",
    0x0F: "DisconnectPhone",
    0x12: "BluetoothPairedList",
    0x14: "ManufacturerInfo",
    0x15: "CloseDongle",
    0x17: "MultiTouch",
    0x18: "HiCarLink",
    0x19: "BoxSettings",
    0x2A: "MediaData",
    0x99: "SendFile",
    0xAA: "HeartBeat",
    0xCC: "SoftwareVersion",
}


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(len(ordered) * pct) - 1))
    return ordered[index]


def decode_header_from_line(line: str) -> dict[str, Any] | None:
    if " = " not in line:
        return None

    hex_part = line.split(" = ", 1)[1]
    words: list[str] = []
    for token in hex_part.split():
        if len(token) == 8 and all(ch in "0123456789abcdefABCDEF" for ch in token):
            words.append(token)
        if len(words) >= 4:
            break

    if len(words) < 4:
        return None

    try:
        data = bytes.fromhex("".join(words[:4]))
    except ValueError:
        return None

    if len(data) != 16:
        return None

    magic = int.from_bytes(data[0:4], "little")
    if magic != 0x55AA55AA:
        return None

    message_length = int.from_bytes(data[4:8], "little")
    message_type = int.from_bytes(data[8:12], "little")
    type_check = int.from_bytes(data[12:16], "little")
    expected_check = (message_type ^ -1) & 0xFFFFFFFF
    return {
        "messageType": MESSAGE_TYPES.get(message_type, f"0x{message_type:x}"),
        "messageTypeValue": message_type,
        "messageLength": message_length,
        "typeCheckOk": type_check == expected_check,
    }


def summarize(path: Path, device: str, top: int, capture_end_us: int | None = None) -> dict[str, Any]:
    starts: dict[str, tuple[int, str, int, str]] = {}
    completions: dict[str, list[tuple[int, int, str, str]]] = {"Bi": [], "Bo": []}
    pending: list[tuple[int, str, int, int, str, str]] = []
    last_ts = 0
    lines = 0

    for line in path.read_text(errors="replace").splitlines():
        lines += 1
        parts = line.split()
        if len(parts) < 6:
            continue
        tag, ts_raw, event, addr, _status, length_raw = parts[:6]
        if not (addr.startswith(f"Bi:{device}") or addr.startswith(f"Bo:{device}")):
            continue
        try:
            ts = int(ts_raw)
            length = int(length_raw)
        except ValueError:
            continue
        last_ts = max(last_ts, ts)

        direction = addr[:2]
        if event == "S":
            starts[tag] = (ts, direction, length, line)
        elif event == "C":
            completions[direction].append((ts, length, line, tag))
            started = starts.pop(tag, None)
            if started:
                start_ts, start_direction, requested_len, start_line = started
                pending.append((ts - start_ts, start_direction, requested_len, length, start_line, line))

    completion_gaps: dict[str, list[dict[str, Any]]] = {}
    for direction, rows in completions.items():
      gaps: list[dict[str, Any]] = []
      last_ts: int | None = None
      for ts, length, line, _tag in rows:
          if last_ts is not None:
              gap: dict[str, Any] = {
                  "gapMs": round((ts - last_ts) / 1000, 3),
                  "timestampMs": round(ts / 1000, 3),
                  "length": length,
                  "line": line[:180],
              }
              decoded = decode_header_from_line(line)
              if decoded:
                  gap["decodedHeader"] = decoded
              gaps.append(gap)
          last_ts = ts
      completion_gaps[direction] = sorted(gaps, key=lambda item: item["gapMs"], reverse=True)[:top]

    pending_rows = sorted(pending, key=lambda row: row[0], reverse=True)
    pending_top = [
        {
            "durationMs": round(duration / 1000, 3),
            "direction": direction,
            "requestedLength": requested,
            "completedLength": completed,
            "submit": submit[:180],
            "complete": complete[:180],
            **({"decodedHeader": decoded} if (decoded := decode_header_from_line(complete)) else {}),
        }
        for duration, direction, requested, completed, submit, complete in pending_rows[:top]
    ]

    open_pending: list[tuple[int, str, int, str]] = []
    end_ts = capture_end_us or last_ts
    if end_ts:
        for start_ts, direction, requested_len, start_line in starts.values():
            open_pending.append((max(0, end_ts - start_ts), direction, requested_len, start_line))

    open_pending_rows = sorted(open_pending, key=lambda row: row[0], reverse=True)
    open_pending_top = [
        {
            "durationMs": round(duration / 1000, 3),
            "direction": direction,
            "requestedLength": requested,
            "submit": submit[:180],
            "note": "submitted before capture ended; no completion was seen",
        }
        for duration, direction, requested, submit in open_pending_rows[:top]
    ]

    bi_durations = [duration / 1000 for duration, direction, *_rest in pending if direction == "Bi"]
    bo_durations = [duration / 1000 for duration, direction, *_rest in pending if direction == "Bo"]
    open_bi_durations = [
        duration / 1000 for duration, direction, *_rest in open_pending if direction == "Bi"
    ]
    open_bo_durations = [
        duration / 1000 for duration, direction, *_rest in open_pending if direction == "Bo"
    ]

    def stats(values: list[float]) -> dict[str, float | int]:
        return {
            "count": len(values),
            "medianMs": round(statistics.median(values), 3) if values else 0,
            "p95Ms": round(percentile(values, 0.95), 3),
            "maxMs": round(max(values), 3) if values else 0,
        }

    return {
        "file": str(path),
        "device": device,
        "lines": lines,
        "captureEndUs": capture_end_us,
        "completions": {key: len(value) for key, value in completions.items()},
        "pendingStats": {"Bi": stats(bi_durations), "Bo": stats(bo_durations)},
        "openPendingStats": {"Bi": stats(open_bi_durations), "Bo": stats(open_bo_durations)},
        "pendingStatsIncludingOpen": {
            "Bi": stats(bi_durations + open_bi_durations),
            "Bo": stats(bo_durations + open_bo_durations),
        },
        "topCompletionGaps": completion_gaps,
        "topPendingDurations": pending_top,
        "topOpenPendingDurations": open_pending_top,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("file", type=Path)
    parser.add_argument("--device", default="3:003", help="usbmon device tuple, e.g. 3:003")
    parser.add_argument("--top", type=int, default=12)
    parser.add_argument("--capture-end-us", type=int, help="CLOCK_MONOTONIC capture end timestamp in microseconds")
    args = parser.parse_args()

    print(json.dumps(summarize(args.file, args.device, args.top, args.capture_end_us), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
