/* =====================================================================
   UNLIMITER DEPTH — shared presence layer for the Unlimiter tool suite
   ---------------------------------------------------------------------
   The counterpart to unlimiter-drive.js. The drive brings in sound and
   time; this brings in the room.

       <script src="unlimiter-drive.js"></script>
       <script src="unlimiter-depth.js"></script>

   Host integration:
       const Depth = UnlimiterDepth.create({ drive: Drive });
       Depth.mountPanel(document.getElementById("depthPanel"));
       ...then per frame, use Depth.maskCanvas / Depth.depthCanvas as an
       ordinary image source, or read Depth.depth / Depth.body directly.

   It also registers scalars with the drive — silhouette area, centroid,
   nearest distance, spread, motion — so a performer moving in front of the
   sensor becomes just another row in the mod matrix, next to audio.low and
   lfo.0. No tool needs to know a depth camera exists.

   SOURCES
     bridge   kinect-bridge.py over a localhost WebSocket (real depth)
     webcam   luminance standing in for depth, so every tool still works
              with nothing plugged in
     none

   A Kinect v2 cannot be reached from a browser directly: it is not a UVC
   device and its depth stream is raw time-of-flight phase data. Hence the
   bridge. See kinect-bridge.py for the wire format.
   ===================================================================== */
(function(global){
"use strict";

const VERSION = "1.0";
const MAGIC = 0x31444C55;           // 'ULD1' little-endian
const NO_BODY = 255;
const clamp=(v,a,b)=>v<a?a:v>b?b:v;

const CSS = `
.udep{font-family:var(--sans,system-ui);font-size:13px;color:var(--text,#e8e6e1)}
.udep .r{display:flex;align-items:center;gap:10px;padding:5px 0;min-height:28px}
.udep .r > label{flex:none;width:104px;color:var(--dim,#8d9490);font-size:12px}
.udep .r .c{flex:1;min-width:0;display:flex;align-items:center;gap:8px}
.udep .v{font-family:var(--mono,monospace);font-size:11px;width:56px;text-align:right;flex:none}
.udep .sub{font-size:11.5px;font-weight:600;padding:10px 0 2px;
  border-top:1px solid var(--line,#2e3338);margin-top:8px}
.udep .sub:first-child{border-top:none;margin-top:0}
.udep .note{color:var(--dim,#8d9490);font-size:11.5px;padding:2px 0 6px;line-height:1.5}
.udep .brow{display:flex;gap:6px;padding:6px 0}
.udep .brow button{flex:1}
.udep .on{border-color:var(--accent,#7fd1c0) !important;color:var(--accent,#7fd1c0) !important}
.udep .bad{color:var(--hot,#e0714f)}
.udep canvas.prev{width:100%;height:132px;display:block;border:1px solid var(--line,#2e3338);
  border-radius:3px;background:#0e1011;image-rendering:pixelated}
.udep .meter{height:6px;background:var(--line,#2e3338);border-radius:3px;overflow:hidden;flex:1}
.udep .meter i{display:block;height:100%;width:0;background:var(--accent,#7fd1c0)}
.udep select,.udep input[type=text]{width:100%;background:var(--panel-2,#24282b);
  color:var(--text,#e8e6e1);border:1px solid var(--line,#2e3338);border-radius:3px;
  padding:4px 6px;font-size:11.5px;font-family:inherit}
.udep input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:18px;background:transparent}
.udep input[type=range]::-webkit-slider-runnable-track{height:2px;background:var(--line,#2e3338)}
.udep input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;
  border-radius:50%;background:var(--accent,#7fd1c0);margin-top:-4.5px;border:none}
.udep input[type=checkbox]{appearance:none;width:15px;height:15px;border:1px solid #454b50;
  border-radius:3px;background:var(--panel-2,#24282b);cursor:pointer;flex:none;position:relative}
.udep input[type=checkbox]:checked{background:var(--accent,#7fd1c0);border-color:var(--accent,#7fd1c0)}
.udep input[type=checkbox]:checked::after{content:"";position:absolute;left:4px;top:1px;width:4px;
  height:8px;border-right:2px solid #14181a;border-bottom:2px solid #14181a;transform:rotate(42deg)}
.udep button{background:var(--panel-2,#24282b);color:var(--text,#e8e6e1);
  border:1px solid var(--line,#2e3338);border-radius:3px;padding:5px 9px;font-size:11.5px;
  cursor:pointer;font-family:inherit}
.udep button:hover{border-color:#4a5157}
.udep .tiny{font-family:var(--mono,monospace);font-size:10.5px;color:var(--dim,#8d9490)}
`;

function create(opts){
  opts = opts || {};
  const drive = opts.drive || null;
  const ui = {};
  let panelEl = null;

  const S = {
    source:"none",                     // none | bridge | webcam
    url: (opts.url || "ws://localhost:8787"),
    status:"idle", err:"",
    ws:null, retry:0, retryTimer:0, wantOpen:false,
    w:0, h:0, mirrored:false, sensorName:"",
    minMm:500, maxMm:4500,
    depth:null,                        // Uint16Array, millimetres, 0 = no reading
    body:null,                         // Uint8Array, 255 = no body
    prevDepth:null,
    frames:0, fps:0, fpsN:0, fpsT:0, lastFrame:0,
    // health: a stall and a real disconnect look identical from the outside
    reconnects:0, stalls:0, worstGap:0, lastArrive:0, procMs:0, procPeak:0,
    // controls
    nearMm:900, farMm:3200, maskFrom:"body", mirror:false,
    smooth:0.35, clean:0, fillHoles:false, invert:false,
    gamma:1.0, motionGain:1.0,
    // derived, all 0..1 except where noted
    m:{present:0, area:0, x:0.5, y:0.5, near:0, far:0, spread:0, motion:0}
  };

  // canvases every tool can use as an ordinary image source
  const maskCanvas = document.createElement("canvas");
  const depthCanvas = document.createElement("canvas");
  const colorCanvas = document.createElement("canvas");   // camera colour, when there is one
  let cctx=null, hasColor=false;
  let mctx=null, dctx=null, mImg=null, dImg=null;
  let maskBuf=null, workBuf=null, morphTmp=null;

  function alloc(w,h){
    if(S.w===w && S.h===h && maskBuf) return;
    S.w=w; S.h=h;
    maskCanvas.width=w; maskCanvas.height=h;
    depthCanvas.width=w; depthCanvas.height=h;
    colorCanvas.width=w; colorCanvas.height=h;
    cctx=colorCanvas.getContext("2d");
    mctx=maskCanvas.getContext("2d",{willReadFrequently:true});
    dctx=depthCanvas.getContext("2d",{willReadFrequently:true});
    mImg=mctx.createImageData(w,h);
    dImg=dctx.createImageData(w,h);
    maskBuf=new Uint8Array(w*h);
    workBuf=new Uint8Array(w*h);
    morphTmp=new Uint8Array(w*h);
    S.prevDepth=new Uint16Array(w*h);
    if(!S.depth || S.depth.length!==w*h){
      S.depth=new Uint16Array(w*h);
      S.body=new Uint8Array(w*h).fill(NO_BODY);
    }
  }

  /* ---------------- bridge ---------------- */
  function connect(url){
    if(url) S.url=url;
    disconnect(true);
    S.wantOpen=true;
    S.status="connecting"; S.err="";
    refresh();
    let ws;
    try{ ws=new WebSocket(S.url); }
    catch(e){ S.status="error"; S.err="bad address"; refresh(); return; }
    ws.binaryType="arraybuffer";
    S.ws=ws;
    ws.onopen=()=>{ S.status="connected"; S.retry=0; S.source="bridge"; refresh(); };
    ws.onmessage=e=>{
      if(typeof e.data==="string"){
        try{
          const j=JSON.parse(e.data);
          if(j.width) alloc(j.width,j.height);
          if(j.minDepthMm) S.minMm=j.minDepthMm;
          if(j.maxDepthMm) S.maxMm=j.maxDepthMm;
          S.mirrored=!!j.mirrored;
          S.sensorName=j.source||"";
          refresh();
        }catch(err){}
        return;
      }
      readFrame(e.data);
    };
    ws.onerror=()=>{ S.err="could not reach the bridge"; };
    ws.onclose=()=>{
      S.ws=null;
      if(S.wantOpen){
        S.status="reconnecting";
        S.retry++; S.reconnects++;
        clearTimeout(S.retryTimer);
        S.retryTimer=setTimeout(()=>{ if(S.wantOpen) connect(); },
                                Math.min(6000, 600*S.retry));
      } else S.status="idle";
      refresh();
    };
  }
  function disconnect(quiet){
    S.wantOpen=false;
    clearTimeout(S.retryTimer);
    if(S.ws){ try{ S.ws.onclose=null; S.ws.close(); }catch(e){} S.ws=null; }
    if(!quiet){ S.status="idle"; S.source="none"; refresh(); }
  }

  function readFrame(buf){
    if(buf.byteLength < 32) return;
    const dv=new DataView(buf);
    if(dv.getUint32(0,true)!==MAGIC) return;
    const w=dv.getUint16(6,true), h=dv.getUint16(8,true);
    if(!w||!h) return;
    const need=32 + w*h*3;
    if(buf.byteLength < need) return;
    S.minMm=dv.getUint16(10,true)||S.minMm;
    S.maxMm=dv.getUint16(12,true)||S.maxMm;
    alloc(w,h);
    const now=performance.now();
    if(S.lastArrive){
      const gap=now-S.lastArrive;
      if(gap>S.worstGap) S.worstGap=gap;
      if(gap>250) S.stalls++;
    }
    S.lastArrive=now;
    S.depth=new Uint16Array(buf,32,w*h);
    S.body=new Uint8Array(buf,32+w*h*2,w*h);
    const t0=performance.now();
    onNewFrame();
    S.procMs=S.procMs*0.9+(performance.now()-t0)*0.1;
    if(performance.now()-t0>S.procPeak) S.procPeak=performance.now()-t0;
  }

  /* ---------------- webcam fallback ---------------- */
  let vid=null, camStream=null, camCv=null, camCtx=null;
  async function useWebcam(){
    disconnect(true);
    try{
      camStream=await navigator.mediaDevices.getUserMedia({video:{width:640,height:480}});
      vid=document.createElement("video");
      vid.srcObject=camStream; vid.playsInline=true; vid.muted=true;
      await vid.play();
      camCv=document.createElement("canvas");
      camCv.width=320; camCv.height=240;
      camCtx=camCv.getContext("2d",{willReadFrequently:true});
      alloc(320,240);
      S.source="webcam"; S.status="webcam"; S.err=""; S.sensorName="luminance";
      S.minMm=500; S.maxMm=4500;
      refresh();
      pumpWebcam();
    }catch(e){
      S.status="error";
      S.err = location.protocol==="file:"
        ? "webcam blocked on file:// — serve over localhost or https"
        : "no webcam";
      refresh();
    }
  }
  function pumpWebcam(){
    if(S.source!=="webcam") return;
    requestAnimationFrame(pumpWebcam);
    if(!vid || vid.readyState<2) return;
    const w=S.w,h=S.h;
    camCtx.drawImage(vid,0,0,w,h);
    if(cctx){ cctx.drawImage(vid,0,0,w,h); hasColor=true; }
    const px=camCtx.getImageData(0,0,w,h).data;
    const d=S.depth, b=S.body;
    const span=S.maxMm-S.minMm;
    for(let i=0,j=0;i<w*h;i++,j+=4){
      const lum=(px[j]*0.2126+px[j+1]*0.7152+px[j+2]*0.0722)/255;
      // bright reads as near, which is what a lit subject on a dark stage does
      d[i]=S.minMm + (1-lum)*span;
      b[i]=lum>0.42 ? 0 : NO_BODY;
    }
    onNewFrame();
  }
  function stopWebcam(){
    if(camStream) camStream.getTracks().forEach(t=>t.stop());
    camStream=null; vid=null;
  }

  /* ---------------- per-frame processing ---------------- */
  function onNewFrame(){
    const w=S.w,h=S.h,n=w*h;
    if(!n||!maskBuf) return;
    const d=S.depth, b=S.body;
    const near=Math.min(S.nearMm,S.farMm), far=Math.max(S.nearMm,S.farMm);
    const span=Math.max(1,far-near);
    const useBody = S.maskFrom==="body" || S.maskFrom==="both";
    const useRange = S.maskFrom==="range" || S.maskFrom==="both";

    // 1. mask
    for(let i=0;i<n;i++){
      const z=d[i];
      let on=1;
      if(useBody) on = b[i]!==NO_BODY ? 1 : 0;
      if(useRange){
        const inRange = z>0 && z>=near && z<=far;
        on = (S.maskFrom==="both") ? (on & (inRange?1:0)) : (inRange?1:0);
      }
      maskBuf[i]=on;
    }
    if(S.invert) for(let i=0;i<n;i++) maskBuf[i]=maskBuf[i]?0:1;

    // 2. clean up: open then close, which removes speckle without eating the
    //    silhouette the way a plain erode does
    for(let k=0;k<S.clean;k++){ morph(maskBuf,workBuf,w,h,0); morph(workBuf,maskBuf,w,h,1); }
    if(S.fillHoles){ morph(maskBuf,workBuf,w,h,1); morph(workBuf,maskBuf,w,h,0); }

    // 3. metrics + raster, in one pass
    let count=0,sx=0,sy=0,zN=0,motion=0;
    zHist.fill(0);
    const md=mImg.data, dd=dImg.data;
    const prev=S.prevDepth;
    const mg=Math.max(1,S.motionGain)*18;
    for(let y=0,i=0;y<h;y++){
      for(let x=0;x<w;x++,i++){
        const on=maskBuf[i], z=d[i];
        const j=i*4;
        // mask raster: white where present, transparent black where not
        const v=on?255:0;
        md[j]=md[j+1]=md[j+2]=v; md[j+3]=v;
        // depth raster: near is bright, clipped to the working range
        let g=0;
        if(z>0){
          let t=1-(z-near)/span;
          t=clamp(t,0,1);
          if(S.gamma!==1) t=Math.pow(t,S.gamma);
          g=(t*255)|0;
        }
        dd[j]=dd[j+1]=dd[j+2]=g; dd[j+3]=255;
        if(on){
          count++; sx+=x; sy+=y;
          if(z>0){
            let bi=((z-near)/span*ZBINS)|0;
            zHist[bi<0?0:bi>=ZBINS?ZBINS-1:bi]++; zN++;
          }
          const pz=prev[i];
          if(pz>0 && z>0){ const dz=z-pz; if(dz>mg||dz<-mg) motion++; }
        }
        prev[i]=z;
      }
    }
    mctx.putImageData(mImg,0,0);
    dctx.putImageData(dImg,0,0);

    // 4. smooth the scalars — raw depth metrics are jittery enough to be
    //    useless as modulation without it
    const k=1-clamp(S.smooth,0,0.97);
    const m=S.m, present=count>n*0.0015?1:0;
    const area=count/n;
    const ease=(cur,target)=>cur+(target-cur)*k;
    m.present = ease(m.present, present);
    m.area    = ease(m.area, Math.min(1, area*3));
    if(count){
      m.x = ease(m.x, (sx/count)/w);
      m.y = ease(m.y, (sy/count)/h);
      // percentiles, not extremes: a single bridged pixel on the back wall
      // must not decide what "closeness" means
      const p05=pct(zHist,zN,0.05), p95=pct(zHist,zN,0.95);
      const nz=clamp(1-p05,0,1), fz=clamp(1-p95,0,1);
      m.near = ease(m.near, nz);
      m.far  = ease(m.far, fz);
      m.spread = ease(m.spread, clamp(p95-p05,0,1));
      m.motion = ease(m.motion, Math.min(1,(motion/count)*4));
    } else {
      m.area=ease(m.area,0); m.motion=ease(m.motion,0);
      m.near=ease(m.near,0); m.spread=ease(m.spread,0);
    }

    S.frames++; S.fpsN++;
    const now=performance.now();
    S.lastFrame=now;
    if(now-S.fpsT>500){ S.fps=Math.round(S.fpsN*1000/(now-S.fpsT)); S.fpsN=0; S.fpsT=now; }
    if(opts.onFrame) opts.onFrame(S);
  }

  // position of a percentile in the masked-depth histogram, as 0..1 of the
  // working volume
  const ZBINS=96;
  const zHist=new Uint32Array(ZBINS);
  function pct(hist,total,frac){
    if(!total) return 0;
    const want=total*frac;
    let acc=0;
    for(let i=0;i<ZBINS;i++){
      acc+=hist[i];
      if(acc>=want) return (i+0.5)/ZBINS;
    }
    return 1;
  }

  // 3x3 min (erode, op 0) or max (dilate, op 1), done separably: a 1x3 pass
  // then a 3x1 pass gives the same result for 6 samples instead of 9, and
  // reads along the row rather than jumping across three of them
  function morph(src,dst,w,h,op){
    const t=morphTmp;
    for(let y=0;y<h;y++){
      const r=y*w;
      for(let x=0;x<w;x++){
        const a=src[r+(x>0?x-1:0)], b=src[r+x], c=src[r+(x<w-1?x+1:w-1)];
        t[r+x] = op ? (a|b|c) : (a&b&c);
      }
    }
    for(let y=0;y<h;y++){
      const r=y*w, u=(y>0?y-1:0)*w, d=(y<h-1?y+1:h-1)*w;
      for(let x=0;x<w;x++){
        const a=t[u+x], b=t[r+x], c=t[d+x];
        dst[r+x] = op ? (a|b|c) : (a&b&c);
      }
    }
  }

  /* ---------------- drive sources ---------------- */
  function wireDrive(){
    if(!drive || !drive.registerSource) return;
    const m=S.m;
    drive.registerSource("depth.present","Depth — someone there",()=>m.present);
    drive.registerSource("depth.area",   "Depth — silhouette size",()=>m.area);
    drive.registerSource("depth.x",      "Depth — position across",()=>m.x);
    drive.registerSource("depth.y",      "Depth — position up",()=>1-m.y);
    drive.registerSource("depth.near",   "Depth — closeness",()=>m.near);
    drive.registerSource("depth.spread", "Depth — depth spread",()=>m.spread);
    drive.registerSource("depth.motion", "Depth — movement",()=>m.motion);
  }

  /* ---------------- panel ---------------- */
  function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e;}
  function prow(p,label,nodes){
    const r=el("div","r"), l=el("label",null,label), c=el("div","c");
    nodes.forEach(n=>c.appendChild(n)); r.appendChild(l); r.appendChild(c); p.appendChild(r);
    return r;
  }
  function sld(p,label,get,set,min,max,step,fmt){
    const i=document.createElement("input");
    i.type="range"; i.min=min; i.max=max; i.step=step; i.value=get();
    const v=el("span","v");
    const show=()=>v.textContent=fmt?fmt(get()):get();
    show();
    i.addEventListener("input",()=>{set(Number(i.value));show();});
    prow(p,label,[i,v]);
    return {input:i,show};
  }
  function sel(p,label,options,get,set){
    const s=document.createElement("select");
    options.forEach(([v,t])=>{const o=document.createElement("option");o.value=v;o.textContent=t;s.appendChild(o);});
    s.value=get();
    s.addEventListener("change",()=>set(s.value));
    prow(p,label,[s]); return s;
  }
  function chk(p,label,get,set){
    const c=document.createElement("input"); c.type="checkbox"; c.checked=get();
    c.addEventListener("change",()=>set(c.checked));
    prow(p,label,[c]); return c;
  }
  function sub(p,t){p.appendChild(el("div","sub",t));}
  function note(p,t){const d=el("div","note",t);p.appendChild(d);return d;}

  function mountPanel(host){
    if(!document.getElementById("udep-css")){
      const st=el("style"); st.id="udep-css"; st.textContent=CSS; document.head.appendChild(st);
    }
    panelEl=host; host.classList.add("udep"); host.innerHTML="";

    sub(host,"Source");
    ui.url=document.createElement("input");
    ui.url.type="text"; ui.url.value=S.url;
    ui.url.addEventListener("change",()=>S.url=ui.url.value.trim());
    prow(host,"Bridge",[ui.url]);
    const row1=el("div","brow");
    ui.bConnect=el("button",null,"Connect");
    ui.bConnect.addEventListener("click",()=>{
      if(S.source==="bridge"||S.wantOpen){ disconnect(); }
      else { stopWebcam(); connect(ui.url.value.trim()); }
    });
    ui.bCam=el("button",null,"Webcam instead");
    ui.bCam.addEventListener("click",()=>{ if(S.source==="webcam"){ stopWebcam(); S.source="none"; S.status="idle"; refresh(); } else useWebcam(); });
    row1.append(ui.bConnect,ui.bCam); host.appendChild(row1);
    ui.status=note(host,"");
    note(host,"Run kinect-bridge.py on this machine. With nothing plugged in, the webcam stands in — brightness becomes depth, so every tool still does something.");

    sub(host,"Preview");
    ui.prev=document.createElement("canvas");
    ui.prev.className="prev"; ui.prev.width=320; ui.prev.height=132;
    host.appendChild(ui.prev);
    ui.pctx=ui.prev.getContext("2d");
    sel(host,"Show",[["mask","Mask"],["depth","Depth"],["both","Both"]],
        ()=>ui.showMode||"both",v=>ui.showMode=v);
    ui.showMode="both";

    sub(host,"Working volume");
    ui.nearS=sld(host,"Near",()=>S.nearMm,v=>S.nearMm=v,300,8000,10,v=>(v/1000).toFixed(2)+"m");
    ui.farS =sld(host,"Far", ()=>S.farMm, v=>S.farMm=v, 300,8000,10,v=>(v/1000).toFixed(2)+"m");
    sel(host,"Mask from",[["body","Body index — the sensor's own"],
                          ["range","Depth range only"],
                          ["both","Both"]],
        ()=>S.maskFrom,v=>S.maskFrom=v);
    note(host,"Body index is the Kinect's own person segmentation and is far cleaner than anything you can threshold out of a camera in a dark room. Depth range is the fallback, and the one to use if you want a hand rather than a whole person.");

    sub(host,"Clean up");
    sld(host,"Despeckle",()=>S.clean,v=>S.clean=Math.round(v),0,3,1,v=>String(v));
    note(host,"Each despeckle step is two passes over every pixel. Leave it at 0 unless the mask is actually crawling — body index rarely needs it.");
    chk(host,"Fill holes",()=>S.fillHoles,v=>S.fillHoles=v);
    chk(host,"Invert mask",()=>S.invert,v=>S.invert=v);
    chk(host,"Mirror",()=>S.mirror,v=>S.mirror=v);
    sld(host,"Depth curve",()=>S.gamma,v=>S.gamma=v,0.3,3,0.01,v=>v.toFixed(2));

    sub(host,"Modulation");
    ui.mRows={};
    [["present","Someone there"],["area","Silhouette size"],["x","Position across"],
     ["y","Position up"],["near","Closeness"],["spread","Depth spread"],
     ["motion","Movement"]].forEach(([k,label])=>{
      const m=el("div","meter"), i=el("i"); m.appendChild(i);
      prow(host,label,[m]); ui.mRows[k]=i;
    });
    sld(host,"Smoothing",()=>S.smooth,v=>S.smooth=v,0,0.97,0.01,v=>v.toFixed(2));
    sld(host,"Motion floor",()=>S.motionGain,v=>S.motionGain=v,0.2,6,0.05,v=>v.toFixed(2));
    note(host,"These appear in the drive's mod matrix as Depth sources, so movement in the room can drive any parameter the same way an audio band does.");

    refresh();
    tickPanel();
  }

  function refresh(){
    if(!panelEl) return;
    const connected = S.source==="bridge" && S.status==="connected";
    if(ui.bConnect){
      ui.bConnect.textContent = (S.wantOpen||connected) ? "Disconnect" : "Connect";
      ui.bConnect.classList.toggle("on",connected);
    }
    if(ui.bCam) ui.bCam.classList.toggle("on",S.source==="webcam");
    if(ui.status){
      let t;
      if(S.status==="connected") t=`${S.sensorName||"bridge"} · ${S.w}×${S.h} · ${S.fps} fps`;
      else if(S.status==="webcam") t=`webcam standing in · ${S.w}×${S.h} · ${S.fps} fps`;
      else if(S.status==="connecting") t="connecting…";
      else if(S.status==="reconnecting") t=`bridge not answering — retrying (${S.retry})`;
      else if(S.status==="error") t=S.err||"error";
      else t="nothing connected";
      ui.status.textContent=t;
      ui.status.classList.toggle("bad", S.status==="error"||S.status==="reconnecting");
    }
  }

  function tickPanel(){
    requestAnimationFrame(tickPanel);
    if(!panelEl) return;
    const c=ui.pctx;
    if(c){
      const W=ui.prev.width, H=ui.prev.height;
      c.fillStyle="#0e1011"; c.fillRect(0,0,W,H);
      if(S.w){
        const mode=ui.showMode;
        if(mode==="both"){
          c.drawImage(depthCanvas,0,0,W/2,H);
          c.drawImage(maskCanvas,W/2,0,W/2,H);
          c.strokeStyle="#2e3338"; c.beginPath(); c.moveTo(W/2,0); c.lineTo(W/2,H); c.stroke();
        } else {
          c.drawImage(mode==="mask"?maskCanvas:depthCanvas,0,0,W,H);
        }
        if(S.m.present>0.2){
          c.fillStyle="#7fd1c0";
          const px=(ui.showMode==="both"? W*0.5 : W)*S.m.x + (ui.showMode==="both"?W*0.5:0);
          c.fillRect(px-1, S.m.y*H-1, 3,3);
        }
      }
    }
    if(ui.mRows){
      for(const k in ui.mRows){
        const v = k==="y" ? 1-S.m.y : S.m[k];
        ui.mRows[k].style.width=(clamp(v,0,1)*100).toFixed(0)+"%";
      }
    }
    // the status line carries fps, which changes constantly
    if(ui.status && (S.status==="connected"||S.status==="webcam")) refresh();
  }

  wireDrive();

  /* ---------------- public ---------------- */
  return {
    version:VERSION,
    connect, disconnect, useWebcam, mountPanel,
    resetHealth(){ S.stalls=0; S.worstGap=0; S.reconnects=0; S.procPeak=0; },
    get maskCanvas(){ return maskCanvas; },
    get colorCanvas(){ return colorCanvas; },
    get hasColor(){ return hasColor; },
    get depthCanvas(){ return depthCanvas; },
    get depth(){ return S.depth; },
    get body(){ return S.body; },
    get width(){ return S.w; },
    get height(){ return S.h; },
    get metrics(){ return S.m; },
    get live(){ return (S.source==="bridge"&&S.status==="connected")||S.source==="webcam"; },
    get state(){ return S; },
    // millimetres at a normalised point, or 0 where there is no reading
    depthAt(u,v){
      if(!S.w) return 0;
      const x=clamp(Math.round(u*(S.w-1)),0,S.w-1);
      const y=clamp(Math.round(v*(S.h-1)),0,S.h-1);
      return S.depth[y*S.w+x]||0;
    },
    serialize(){
      return {url:S.url, nearMm:S.nearMm, farMm:S.farMm, maskFrom:S.maskFrom,
              clean:S.clean, fillHoles:S.fillHoles, invert:S.invert, mirror:S.mirror,
              gamma:S.gamma, smooth:S.smooth, motionGain:S.motionGain};
    },
    load(o){
      if(!o) return;
      Object.assign(S,o);
      if(panelEl){ const h=panelEl; mountPanel(h); }
    }
  };
}

global.UnlimiterDepth={create,version:VERSION};
})(window);
