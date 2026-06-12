#!/usr/bin/env python3
"""Isolate the rounded-clip cost and test cheaper rounding alternatives.
Run ON the Pi with debug port. CarPlay must be streaming.

Variants (each PHASE_S under synthetic drag), backdrop forced OFF for all but V0:
 V0 backdrop ON, clip ON   (current default)
 V1 backdrop OFF, clip ON  (what user runs now)
 V2 backdrop OFF, clip OFF (proven near-perfect)
 V3 backdrop OFF, clip moved to the <canvas> via border-radius (no overflow parent)
 V4 backdrop ON,  clip OFF (does removing clip rescue backdrop-on?)
"""
import json, sys, time, urllib.request, threading, math
import websocket
PHASE_S=12
ws=websocket.create_connection(json.load(urllib.request.urlopen('http://localhost:9222/json'))[0]['webSocketDebuggerUrl'],timeout=10)
MID=[0]; LOCK=threading.Lock()
def send(method,params=None):
    with LOCK:
        MID[0]+=1; ws.send(json.dumps({'id':MID[0],'method':method,'params':params or {}})); return MID[0]
def ev(expr,timeout=12):
    i=send('Runtime.evaluate',{'expression':expr,'returnByValue':True})
    dl=time.time()+timeout
    while time.time()<dl:
        try: m=json.loads(ws.recv())
        except Exception: continue
        if m.get('id')==i: return m.get('result',{}).get('result',{}).get('value',{'_err':str(m)[:120]})
    return {'timeout':True}

ev(r"""(()=>{ if(window.__rp) return; const p=window.__rp={iv:[],last:0};
 (function loop(t){ if(p.last)p.iv.push(t-p.last); p.last=t; requestAnimationFrame(loop);})(performance.now());
 window.__rpSnap=()=>{const a=window.__rp.iv.slice().sort((x,y)=>x-y);window.__rp.iv=[];if(!a.length)return{n:0};
  const q=f=>a[Math.min(a.length-1,Math.floor(a.length*f))];const s=a.reduce((u,x)=>u+x,0);
  return{n:a.length,avg:+(s/a.length).toFixed(2),p95:+q(.95).toFixed(2),p99:+q(.99).toFixed(2),over20:a.filter(x=>x>20).length};};})()""")

def bd(on):  return ev("(()=>{const c=document.querySelector('canvas[width=\"192\"]');if(c)c.style.display='%s';return 1;})()"%('block' if on else 'none'))
def clip(on):
    if on:
        return ev(r"""(()=>{document.querySelectorAll('div').forEach(d=>{if(d.dataset._br!==undefined){d.style.borderRadius=d.dataset._br;d.style.overflow=d.dataset._ov;}});const v=document.getElementById('video');if(v)v.style.borderRadius='';return 1;})()""")
    return ev(r"""(()=>{document.querySelectorAll('div').forEach(d=>{const s=d.style;if(s.borderRadius==='36px'&&s.overflow==='hidden'){d.dataset._br=s.borderRadius;d.dataset._ov=s.overflow;s.borderRadius='0px';s.overflow='visible';}});return 1;})()""")
def canvas_round(on):
    return ev("(()=>{const v=document.getElementById('video');if(v)v.style.borderRadius='%s';return 1;})()"%('34px' if on else ''))

STOP=threading.Event()
def mouse(t,x,y,b): send('Input.dispatchMouseEvent',{'type':t,'x':x,'y':y,'button':'left','buttons':b,'clickCount':0 if t=='mouseMoved' else 1})
def wig():
    mouse('mousePressed',400,400,1); t0=time.time()
    while not STOP.is_set():
        x=400+int(120*math.sin((time.time()-t0)*3));y=400+int(120*math.cos((time.time()-t0)*3));mouse('mouseMoved',x,y,1);time.sleep(0.033)
    mouse('mouseReleased',400,400,0)
def phase(name):
    ev("window.__rpSnap()");STOP.clear();th=threading.Thread(target=wig,daemon=True);th.start();time.sleep(PHASE_S);STOP.set();th.join(timeout=2)
    print(json.dumps({'phase':name,'raf':ev("window.__rpSnap()")}),flush=True)

bd(True); clip(True); canvas_round(False); phase('V0_backdropON_clipON')
bd(False);                                  phase('V1_backdropOFF_clipON')
clip(False);                                phase('V2_backdropOFF_clipOFF')
canvas_round(True);                         phase('V3_backdropOFF_canvasRound')
canvas_round(False); bd(True);              phase('V4_backdropON_clipOFF')
# restore
canvas_round(False); clip(True); bd(True)
print(json.dumps({'restored':True}),flush=True)
