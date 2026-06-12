#!/usr/bin/env python3
"""Compositor / presentation probe — measures the MAIN PAGE frame cadence
(what actually reaches the round display) under synthetic CarPlay load, while
A/B toggling the expensive CSS layers live. Run ON the Pi with debug port.

Why main-page rAF jitter: the page's requestAnimationFrame fires once per
compositor frame. If the compositor is struggling (re-rendering the blurred
backdrop + rounded-corner clipped video into intermediate targets every vsync),
rAF intervals widen and scatter. Decode fps (worker) can stay 58 while the
COMPOSITED output stutters — that's the "smooth fps but laggy" gap.

Phases (each PHASE_S under a synthetic full-screen drag that forces real video):
  A) baseline      — whatever the app currently shows
  B) backdrop OFF  — display:none the backdrop canvas
  C) backdrop OFF + no rounded clip on video square (borderRadius 0, no overflow clip)
  D) backdrop OFF + no clip + no gauge drop-shadows
  E) restore
Reports rAF interval stats (avg/p50/p95/p99/max ms) per phase.
"""
import json, sys, time, urllib.request, threading, math
import websocket

PHASE_S = 12
ts = json.load(urllib.request.urlopen('http://localhost:9222/json'))
page = next(t for t in ts if t['type'] == 'page')
ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=10)
MID=[0]; EVENTS=[]; LOCK=threading.Lock()
def send(method,params=None,session=None):
    with LOCK:
        MID[0]+=1; m={'id':MID[0],'method':method}
        if params is not None: m['params']=params
        if session: m['sessionId']=session
        ws.send(json.dumps(m)); return MID[0]
def wait_id(i,timeout=10):
    dl=time.time()+timeout
    while time.time()<dl:
        try: msg=json.loads(ws.recv())
        except Exception: continue
        if msg.get('id')==i: return msg
        if 'method' in msg: EVENTS.append(msg)
    return {'timeout':True}
def ev(expr,timeout=12):
    i=send('Runtime.evaluate',{'expression':expr,'returnByValue':True}); r=wait_id(i,timeout)
    return r.get('result',{}).get('result',{}).get('value',{'_err':str(r)[:150]})

# install a rAF interval recorder on the page
INSTALL = r"""
(()=>{ if(window.__rp) return 'already';
 const p=window.__rp={iv:[],last:0};
 (function loop(t){ if(p.last){p.iv.push(t-p.last);} p.last=t; requestAnimationFrame(loop); })(performance.now());
 window.__rpSnap=()=>{const a=window.__rp.iv.slice().sort((x,y)=>x-y);window.__rp.iv=[];
   if(!a.length)return{n:0};
   const q=(f)=>a[Math.min(a.length-1,Math.floor(a.length*f))];
   const sum=a.reduce((s,x)=>s+x,0);
   return{n:a.length,avg:+(sum/a.length).toFixed(2),p50:+q(.5).toFixed(2),p95:+q(.95).toFixed(2),p99:+q(.99).toFixed(2),max:+a[a.length-1].toFixed(2),
          over20:a.filter(x=>x>20).length,over33:a.filter(x=>x>33).length};};
 return 'installed'; })()
"""
print(json.dumps({'install':ev(INSTALL)}),flush=True)

# CSS toggles via injected style + DOM
BACKDROP_OFF = "(()=>{const c=document.querySelector('canvas[width=\"192\"]');if(c){c.dataset._d=c.style.display;c.style.display='none';return 'backdrop-off';}return 'no-backdrop-canvas';})()"
BACKDROP_ON  = "(()=>{const c=document.querySelector('canvas[width=\"192\"]');if(c){c.style.display=c.dataset._d||'block';return 'backdrop-on';}return 'na';})()"
# the video square is the z5 div with borderRadius 36 + overflow hidden; find by style
NOCLIP = r"""
(()=>{let n=0;document.querySelectorAll('div').forEach(d=>{const s=d.style;
  if(s && s.borderRadius==='36px' && s.overflow==='hidden'){d.dataset._br=s.borderRadius;d.dataset._ov=s.overflow;s.borderRadius='0px';s.overflow='visible';n++;}});
 // also the videoContainer rounding
 const vc=document.getElementById('videoContainer'); if(vc){vc.dataset._br=vc.style.borderRadius;vc.style.borderRadius='0px';}
 return 'noclip:'+n;})()
"""
RECLIP = r"""
(()=>{document.querySelectorAll('div').forEach(d=>{if(d.dataset._br!==undefined){d.style.borderRadius=d.dataset._br;if(d.dataset._ov!==undefined)d.style.overflow=d.dataset._ov;}});
 const vc=document.getElementById('videoContainer'); if(vc&&vc.dataset._br!==undefined)vc.style.borderRadius=vc.dataset._br;
 return 'reclip';})()
"""
NOSHADOW = r"""
(()=>{let n=0;document.querySelectorAll('div').forEach(d=>{const s=d.style;
  if(s && (s.filter||'').indexOf('drop-shadow')>=0){d.dataset._f=s.filter;s.filter='none';n++;}
  if(s && (s.boxShadow||'').length){d.dataset._bs=s.boxShadow;s.boxShadow='none';n++;}});
 return 'noshadow:'+n;})()
"""
RESHADOW = r"""
(()=>{document.querySelectorAll('div').forEach(d=>{if(d.dataset._f!==undefined)d.style.filter=d.dataset._f;if(d.dataset._bs!==undefined)d.style.boxShadow=d.dataset._bs;});return 'reshadow';})()
"""

STOP=threading.Event()
def mouse(typ,x,y,b): send('Input.dispatchMouseEvent',{'type':typ,'x':x,'y':y,'button':'left','buttons':b,'clickCount':0 if typ=='mouseMoved' else 1})
def wig():
    mouse('mousePressed',400,400,1); t0=time.time()
    while not STOP.is_set():
        x=400+int(120*math.sin((time.time()-t0)*3)); y=400+int(120*math.cos((time.time()-t0)*3))
        mouse('mouseMoved',x,y,1); time.sleep(0.033)
    mouse('mouseReleased',400,400,0)

def phase(name):
    ev("window.__rpSnap()")  # reset
    STOP.clear(); th=threading.Thread(target=wig,daemon=True); th.start()
    time.sleep(PHASE_S)
    STOP.set(); th.join(timeout=2)
    r=ev("window.__rpSnap()")
    print(json.dumps({'phase':name,'raf':r}),flush=True)

phase('A_baseline')
print(json.dumps({'toggle':ev(BACKDROP_OFF)}),flush=True)
phase('B_backdrop_off')
print(json.dumps({'toggle':ev(NOCLIP)}),flush=True)
phase('C_backdrop_off_noclip')
print(json.dumps({'toggle':ev(NOSHADOW)}),flush=True)
phase('D_backdrop_off_noclip_noshadow')
# restore
ev(RESHADOW); ev(RECLIP); ev(BACKDROP_ON)
print(json.dumps({'restored':True}),flush=True)
