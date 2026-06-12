#!/usr/bin/env python3
"""Measure decode latency + main-thread long tasks while CarPlay streams.

Run ON the Pi with --remote-debugging-port=9222 active.

Render worker: wrap decode() to stamp t at submit, and the output frame via a
monkey-patched VideoFrame close timing is hard; instead we measure the gap
between decode() submit and the NEXT requestAnimationFrame-free draw by hooking
the renderer draw (texImage2D) and pairing it with the most recent decode call.

Main thread: a 16ms self-check interval records the worst scheduling delay
(long-task proxy) -> if the main thread is janky (sensor React renders, GC,
chunk fwd), this 'lagMax' climbs well above a few ms.
"""
import json, sys, time, urllib.request, threading, math
import websocket

PHASE_S = 15
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
def ev(expr,session=None,timeout=10):
    i=send('Runtime.evaluate',{'expression':expr,'returnByValue':True},session)
    r=wait_id(i,timeout); return r.get('result',{}).get('result',{}).get('value',{'_err':str(r)[:150]})

MAIN = r"""
(()=>{ if(self.__lt) return 'already'; const p=self.__lt={lagMax:0,lagSum:0,n:0};
 let l=performance.now();
 setInterval(()=>{const n=performance.now();const d=n-l-16;l=n;if(d>0){p.lagSum+=d;p.n++;if(d>p.lagMax)p.lagMax=d;}},16);
 return 'main-lt'; })()
"""
MAIN_SNAP="(()=>{const p=self.__lt;const r={lagMax:p.lagMax,avgLag:p.n?p.lagSum/p.n:0,samples:p.n};p.lagMax=0;p.lagSum=0;p.n=0;return r;})()"

WORKER = r"""
(()=>{ if(self.__dl) return 'already';
 const p=self.__dl={n:0,sum:0,max:0,pending:[]};
 const od=VideoDecoder.prototype.decode;
 VideoDecoder.prototype.decode=function(c){p.pending.push(performance.now());return od.call(this,c);};
 // hook draw via texImage2D: pair with oldest pending decode
 for(const C of [self.WebGL2RenderingContext,self.WebGLRenderingContext]){ if(!C) continue;
   const ot=C.prototype.texImage2D;
   C.prototype.texImage2D=function(){const r=ot.apply(this,arguments);
     const t0=p.pending.shift(); if(t0!=null){const d=performance.now()-t0;p.n++;p.sum+=d;if(d>p.max)p.max=d;} return r;};
 }
 return 'worker-dl'; })()
"""
WORKER_SNAP="(()=>{const p=self.__dl;const r={n:p.n,avgMs:p.n?p.sum/p.n:0,maxMs:p.max,backlog:p.pending.length};p.n=0;p.sum=0;p.max=0;return r;})()"

print(json.dumps({'main':ev(MAIN)}),flush=True)
i=send('Target.setAutoAttach',{'autoAttach':True,'waitForDebuggerOnStart':False,'flatten':True}); wait_id(i,5)
ws.settimeout(1); t0=time.time()
while time.time()-t0<3:
    try: EVENTS.append(json.loads(ws.recv()))
    except Exception: pass
ws.settimeout(10)
rs=None
for e in EVENTS:
    if e.get('method')=='Target.attachedToTarget' and 'Render' in e['params']['targetInfo'].get('url',''):
        rs=e['params']['sessionId']
if not rs: print(json.dumps({'error':'no render worker'})); sys.exit(1)
print(json.dumps({'worker':ev(WORKER,session=rs)}),flush=True)

STOP=threading.Event()
def mouse(typ,x,y,b): send('Input.dispatchMouseEvent',{'type':typ,'x':x,'y':y,'button':'left','buttons':b,'clickCount':0 if typ=='mouseMoved' else 1})
def wig():
    mouse('mousePressed',400,400,1); t0=time.time()
    while not STOP.is_set():
        x=400+int(120*math.sin((time.time()-t0)*3)); y=400+int(120*math.cos((time.time()-t0)*3))
        mouse('mouseMoved',x,y,1); time.sleep(0.033)
    mouse('mouseReleased',400,400,0)

ev(MAIN_SNAP); ev(WORKER_SNAP,session=rs)
th=threading.Thread(target=wig,daemon=True); th.start()
time.sleep(PHASE_S)
STOP.set(); th.join(timeout=2)
m=ev(MAIN_SNAP); w=ev(WORKER_SNAP,session=rs)
print(json.dumps({'secs':PHASE_S,'decode_latency':w,'main_thread_jank':m},indent=2),flush=True)
