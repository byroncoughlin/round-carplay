#!/usr/bin/env python3
"""Passive CDP probe for no-phone dashboard/settings idle jank.

Run on the Pi while the app has --remote-debugging-port=9222 enabled.
This does not inject touch or require a live CarPlay stream; it only records
page requestAnimationFrame cadence and a 16 ms timer-delay proxy for main-thread
jank while switching between the root dashboard and settings routes.
"""

import json
import time
import urllib.request

import websocket


def main() -> None:
    targets = json.load(urllib.request.urlopen("http://localhost:9222/json"))
    page = next(t for t in targets if t.get("type") == "page")
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=10)
    msg_id = 0

    def send(method: str, params: dict | None = None) -> int:
        nonlocal msg_id
        msg_id += 1
        msg = {"id": msg_id, "method": method}
        if params is not None:
            msg["params"] = params
        ws.send(json.dumps(msg))
        return msg_id

    def wait_for(reply_id: int, timeout: float = 10) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                msg = json.loads(ws.recv())
            except Exception:
                continue
            if msg.get("id") == reply_id:
                return msg
        return {"timeout": True}

    def ev(expr: str, timeout: float = 10):
        reply_id = send(
            "Runtime.evaluate",
            {"expression": expr, "returnByValue": True, "awaitPromise": True},
        )
        reply = wait_for(reply_id, timeout)
        result = reply.get("result", {}).get("result", {})
        if "value" in result:
            return result["value"]
        return {
            "unserializable": result.get("unserializableValue"),
            "desc": result.get("description"),
            "raw": str(reply)[:300],
        }

    install = r"""
(() => {
  if (window.__idleProbe) return "already";
  const p = window.__idleProbe = {
    raf: [],
    lag: [],
    lastRaf: 0,
    lastTick: performance.now(),
    longTasks: [],
  };
  function raf(t) {
    if (p.lastRaf) p.raf.push(t - p.lastRaf);
    p.lastRaf = t;
    requestAnimationFrame(raf);
  }
  requestAnimationFrame(raf);
  setInterval(() => {
    const now = performance.now();
    const delay = now - p.lastTick - 16;
    p.lastTick = now;
    if (delay > 0) p.lag.push(delay);
  }, 16);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) p.longTasks.push(entry.duration);
    }).observe({ entryTypes: ["longtask"] });
  } catch {}
  window.__snapIdleProbe = () => {
    const stat = (arr) => {
      const a = arr.slice().sort((x, y) => x - y);
      if (!a.length) return { n: 0 };
      const q = (f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
      const sum = a.reduce((s, x) => s + x, 0);
      return {
        n: a.length,
        avg: +(sum / a.length).toFixed(2),
        p50: +q(0.5).toFixed(2),
        p95: +q(0.95).toFixed(2),
        p99: +q(0.99).toFixed(2),
        max: +a[a.length - 1].toFixed(2),
        over20: a.filter((x) => x > 20).length,
        over33: a.filter((x) => x > 33).length,
        over50: a.filter((x) => x > 50).length,
      };
    };
    const out = {
      hash: location.hash,
      raf: stat(p.raf),
      timerLag: stat(p.lag),
      longTasks: stat(p.longTasks),
    };
    p.raf = [];
    p.lag = [];
    p.longTasks = [];
    return out;
  };
  return "installed";
})()
"""

    visible_summary = r"""
(() => {
  const visible = [];
  document.querySelectorAll("canvas,svg,button,[id],div").forEach((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden") {
      visible.push({
        tag: el.tagName,
        id: el.id || "",
        cls: String(el.className || "").slice(0, 40),
        z: s.zIndex,
        pos: s.position,
        w: Math.round(r.width),
        h: Math.round(r.height),
        x: Math.round(r.x),
        y: Math.round(r.y),
        filter: s.filter,
        opacity: s.opacity,
        pointer: s.pointerEvents,
      });
    }
  });
  return visible.slice(0, 80);
})()
"""

    def phase(name: str, route_hash: str, seconds: int) -> None:
        print(json.dumps({"prep": name, "route": ev(f"location.hash = {json.dumps(route_hash)}")}), flush=True)
        ev("window.__snapIdleProbe()")
        time.sleep(seconds)
        print(
            json.dumps(
                {"phase": name, "secs": seconds, "snap": ev("window.__snapIdleProbe()")},
                indent=2,
            ),
            flush=True,
        )

    print(json.dumps({"install": ev(install)}), flush=True)
    print(
        json.dumps({"initial": ev("location.hash"), "visible": ev(visible_summary)}, indent=2),
        flush=True,
    )
    phase("root_idle", "#/", 20)
    phase("settings_idle", "#/settings", 15)
    phase("root_back", "#/", 10)
    print(json.dumps({"finalVisible": ev(visible_summary)}, indent=2), flush=True)
    ws.close()


if __name__ == "__main__":
    main()
