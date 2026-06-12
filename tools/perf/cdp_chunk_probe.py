#!/usr/bin/env python3
"""Measure the CarPlay video chunk path to confirm the 512KB fragmentation bug.

Runs ON the Pi with the --remote-debugging-port=9222 autostart flag active.

What it instruments (in the RENDERER MAIN thread, where chunks arrive from IPC):
  - hooks MessagePort.prototype.postMessage to size every buffer forwarded to
    the render worker (these are the raw IPC chunks, capped at 512KB by
    sendChunked on the main side).
  - because sendChunked splits frames >512KB into multiple messages sharing one
    `id`, a frame is fragmented whenever we see a 512KB (524288 B) chunk. We
    count exact-512KB chunks (fragments) vs sub-512KB chunks (frame tails /
    whole small frames) to estimate how many frames are being split.

And in the RENDER worker:
  - counts VideoDecoder.decode() calls, decode ERRORS (output error cb), and
    decodeQueueSize. A fragmented frame -> corrupt EncodedVideoChunk -> the
    decoder error callback fires or frames are silently dropped.

Drives a synthetic full-screen drag (clickCount:1) so the phone actually sends
high-bitrate frames; static CarPlay sends almost nothing.
"""
import json, sys, time, urllib.request, threading, math
import websocket

PHASE_S = 20

ts = json.load(urllib.request.urlopen('http://localhost:9222/json'))
page = next(t for t in ts if t['type'] == 'page')
ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=10)
MID = [0]; EVENTS = []
LOCK = threading.Lock()

def send(method, params=None, session=None):
    with LOCK:
        MID[0] += 1
        m = {'id': MID[0], 'method': method}
        if params is not None: m['params'] = params
        if session: m['sessionId'] = session
        ws.send(json.dumps(m))
        return MID[0]

def wait_id(i, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try: msg = json.loads(ws.recv())
        except Exception: continue
        if msg.get('id') == i: return msg
        if 'method' in msg: EVENTS.append(msg)
    return {'timeout': True}

def ev(expr, session=None, timeout=10):
    i = send('Runtime.evaluate', {'expression': expr, 'returnByValue': True}, session)
    r = wait_id(i, timeout)
    res = r.get('result', {}).get('result', {})
    return res.get('value', {'_err': str(r)[:200]})

# --- main-thread patch: size every MessagePort.postMessage (chunk fwd to worker)
MAIN_PATCH = r"""
(()=>{
 if(self.__cp) return 'already';
 const p = self.__cp={msgs:0,bytes:0,full512:0,sub512:0,maxB:0};
 const op = MessagePort.prototype.postMessage;
 MessagePort.prototype.postMessage=function(d,transfer){
   try{
     let len = (d && d.byteLength!=null)? d.byteLength
              : (d && d.buffer && d.buffer.byteLength!=null)? d.buffer.byteLength : null;
     if(len!=null){p.msgs++;p.bytes+=len;if(len>p.maxB)p.maxB=len;
       if(len===524288)p.full512++; else p.sub512++;}
   }catch(e){}
   return op.call(this,d,transfer);
 };
 return 'installed-main';
})()
"""
MAIN_SNAP = "(()=>{const p=self.__cp;const r=Object.assign({},p);p.msgs=0;p.bytes=0;p.full512=0;p.sub512=0;p.maxB=0;return r;})()"

# --- worker patch: decode calls, errors, queue depth
WORKER_PATCH = r"""
(()=>{
 if(self.__wp) return 'already';
 const p = self.__wp={dec:0,qMax:0,errs:0,lastErr:''};
 const od=VideoDecoder.prototype.decode;
 VideoDecoder.prototype.decode=function(c){const q=this.decodeQueueSize;if(q>p.qMax)p.qMax=q;p.dec++;return od.call(this,c);};
 const oc=VideoDecoder.prototype.configure;
 VideoDecoder.prototype.configure=function(cfg){
   const orig=cfg.error;
   // wrap the error callback installed at construction time is hard; instead
   // patch construction:
   return oc.call(this,cfg);
 };
 const OV=self.VideoDecoder;
 self.VideoDecoder=function(init){
   const wrapped=Object.assign({},init,{error:(e)=>{p.errs++;p.lastErr=String(e&&e.message||e).slice(0,80);if(init.error)init.error(e);}});
   return new OV(wrapped);
 };
 self.VideoDecoder.isConfigSupported=OV.isConfigSupported.bind(OV);
 self.VideoDecoder.prototype=OV.prototype;
 return 'installed-worker';
})()
"""
WORKER_SNAP = "(()=>{const p=self.__wp;const r=Object.assign({},p);p.dec=0;p.qMax=0;p.errs=0;return r;})()"

print(json.dumps({'main_patch': ev(MAIN_PATCH)}), flush=True)

# attach to render worker
i = send('Target.setAutoAttach', {'autoAttach': True, 'waitForDebuggerOnStart': False, 'flatten': True})
wait_id(i, 5)
ws.settimeout(1)
t0 = time.time()
while time.time() - t0 < 3:
    try: EVENTS.append(json.loads(ws.recv()))
    except Exception: pass
ws.settimeout(10)
render_sess = None
for e in EVENTS:
    if e.get('method') == 'Target.attachedToTarget':
        ti = e['params']['targetInfo']
        if 'Render' in ti.get('url', ''): render_sess = e['params']['sessionId']
if not render_sess:
    print(json.dumps({'event': 'error', 'msg': 'no render worker'})); sys.exit(1)
print(json.dumps({'worker_patch': ev(WORKER_PATCH, session=render_sess)}), flush=True)

STOP = threading.Event()
def mouse(typ, x, y, buttons):
    send('Input.dispatchMouseEvent', {'type': typ, 'x': x, 'y': y, 'button': 'left', 'buttons': buttons, 'clickCount': 0 if typ == 'mouseMoved' else 1})
def wiggler():
    mouse('mousePressed', 400, 400, 1)
    t0 = time.time()
    while not STOP.is_set():
        x = 400 + int(120 * math.sin((time.time() - t0) * 3.0))
        y = 400 + int(120 * math.cos((time.time() - t0) * 3.0))
        mouse('mouseMoved', x, y, 1)
        time.sleep(0.033)
    mouse('mouseReleased', 400, 400, 0)

ev(MAIN_SNAP); ev(WORKER_SNAP, session=render_sess)
th = threading.Thread(target=wiggler, daemon=True); th.start()
time.sleep(PHASE_S)
STOP.set(); th.join(timeout=2)
m = ev(MAIN_SNAP); w = ev(WORKER_SNAP, session=render_sess)
secs = PHASE_S
out = {
  'secs': secs,
  'main': m,
  'worker': w,
  'derived': {
    'chunks_per_s': round(m.get('msgs',0)/secs,1),
    'MB_per_s': round(m.get('bytes',0)/secs/1e6,2),
    'full_512KB_chunks_per_s': round(m.get('full512',0)/secs,1),
    'decode_calls_per_s': round(w.get('dec',0)/secs,1),
    'decode_errors_total': w.get('errs',0),
    'note': 'full_512KB_chunks_per_s>0 means frames are being FRAGMENTED and fed corrupt to the decoder',
  }
}
print(json.dumps(out, indent=2), flush=True)
