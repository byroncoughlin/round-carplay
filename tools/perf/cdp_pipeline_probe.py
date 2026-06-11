#!/usr/bin/env python3
"""Verification probe for the new pipeline: same metrics + draw-gap histogram."""
import json, sys, time, urllib.request, threading, math
import websocket
import socketio

PHASE_S = 15

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
    return res.get('value', {'_err': str(r)[:150]})

PATCH = r"""
(()=>{
 if(self.__p) return 'already';
 const p = self.__p={vsync:0,chunks:0,qNow:0,qMax:0,tex:0,texMs:0,texMsMax:0,bitmaps:0,canvasSets:0,lagMax:0,
                     arr:[0,0,0,0,0,0,0],draw:[0,0,0,0,0,0,0],lastA:0,lastD:0,kind:''};
 const bucket=(d)=>d<4?0:d<8?1:d<12?2:d<16?3:d<24?4:d<40?5:6;
 const o = self.requestAnimationFrame.bind(self);
 (function loop(){p.vsync++;o(loop)})();
 const od=VideoDecoder.prototype.decode;
 VideoDecoder.prototype.decode=function(c){const n=performance.now();if(p.lastA)p.arr[bucket(n-p.lastA)]++;p.lastA=n;
   p.chunks++;const q=this.decodeQueueSize;p.qNow=q;if(q>p.qMax)p.qMax=q;return od.call(this,c);};
 for(const [nm,C] of [['webgl2',self.WebGL2RenderingContext],['webgl1',self.WebGLRenderingContext]]){
   if(!C) continue;
   const ot=C.prototype.texImage2D;
   C.prototype.texImage2D=function(){const t0=performance.now();const r=ot.apply(this,arguments);const d=performance.now()-t0;
     p.tex++;p.texMs+=d;if(d>p.texMsMax)p.texMsMax=d;p.kind=nm;
     const n=performance.now();if(p.lastD)p.draw[bucket(n-p.lastD)]++;p.lastD=n;return r;};
 }
 const ocib=self.createImageBitmap.bind(self);
 self.createImageBitmap=function(){p.bitmaps++;return ocib.apply(null,arguments);};
 const desc=Object.getOwnPropertyDescriptor(OffscreenCanvas.prototype,'width');
 Object.defineProperty(OffscreenCanvas.prototype,'width',{get:desc.get,set:function(v){p.canvasSets++;return desc.set.call(this,v);}});
 let l=performance.now();
 setInterval(()=>{const n=performance.now();const d=n-l-50;if(d>p.lagMax)p.lagMax=d;l=n;},50);
 return 'installed';
})()
"""
SNAP = "(()=>{const p=self.__p;const r=Object.assign({},p);p.vsync=0;p.chunks=0;p.qMax=p.qNow;p.tex=0;p.texMs=0;p.texMsMax=0;p.bitmaps=0;p.canvasSets=0;p.lagMax=0;p.arr=[0,0,0,0,0,0,0];p.draw=[0,0,0,0,0,0,0];return r;})()"

vis = ev("document.getElementById('videoContainer')?.style.visibility")
print(json.dumps({'event': 'video-visibility', 'value': vis}), flush=True)

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
print(json.dumps({'event': 'patch', 'r': ev(PATCH, session=render_sess)}), flush=True)

STOP = threading.Event()
def mouse(typ, x, y, buttons):
    send('Input.dispatchMouseEvent', {'type': typ, 'x': x, 'y': y, 'button': 'left', 'buttons': buttons, 'clickCount': 0 if typ == 'mouseMoved' else 1})
def wiggler():
    mouse('mousePressed', 540, 430, 1)
    t0 = time.time()
    while not STOP.is_set():
        x = 540 + int(80 * math.sin((time.time() - t0) * 2.5))
        mouse('mouseMoved', x, 430, 1)
        time.sleep(0.033)
    mouse('mouseReleased', 540, 430, 0)

sio = socketio.Client()
SETTINGS = {}
@sio.on('settings')
def on_settings(s): SETTINGS.update(s)
sio.connect('http://localhost:4000')
for _ in range(50):
    if SETTINGS: break
    time.sleep(0.1)

def set_backdrop(on):
    s2 = dict(SETTINGS); s2['backdropEnabled'] = bool(on)
    sio.emit('saveSettings', s2); time.sleep(1.0)

def phase(name, secs):
    ev(SNAP, session=render_sess)
    th = threading.Thread(target=wiggler, daemon=True)
    STOP.clear(); th.start()
    time.sleep(secs)
    STOP.set(); th.join(timeout=2)
    r = ev(SNAP, session=render_sess)
    r['secs'] = secs
    print(json.dumps({'phase': name, 'r': r}), flush=True)

set_backdrop(True)
phase('ON', PHASE_S)
set_backdrop(False)
phase('OFF', PHASE_S)
set_backdrop(True)
print(json.dumps({'event': 'done-restored-backdrop'}), flush=True)
sio.disconnect()
