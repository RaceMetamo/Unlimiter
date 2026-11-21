/* =====================================================================
   UNLIMITER UI — shared output window + standard sidebar chrome
   ---------------------------------------------------------------------
   Load it FIRST, before any other script in the tool:
       <script src="unlimiter-ui.js"></script>

   What it gives every tool, with no other code:
     - a pinned OUTPUT bar at the top of the sidebar (always visible,
       never buried in a collapsed section)
     - the output window: a bare black window showing the tool's canvas,
       double-click or F for fullscreen, cursor hidden, tries to open on the
       second display (Chrome's Window Management API), keys typed in it are
       passed back to the tool
     - keeps the tool rendering while the output is open: animation frames
       follow the output window's clock, so the show keeps running on the
       projector even when the control window is covered or behind others
     - works with WebGL / WebGPU canvases that don't preserve their drawing
       buffer: the canvas is copied straight after each frame is drawn

   Which canvas is shown: whatever the tool hands over (Drive's
   getOutputCanvas, or UnlimiterUI.setSource(fn)), otherwise the largest
   visible canvas on the page.

   Optional, on the <script> tag or <body>:
     data-ulx-bar="off"        no sidebar bar (the tool has its own button)
     data-ulx-canvas="#id"     canvas to show
   Or a placeholder <div data-ulx-output></div> to choose where the bar goes.

   Feeding another page (MetaMapper "+ Tool"):
     UnlimiterUI.feed()        a 2D canvas copy of the output, refreshed after
                               every frame for as long as someone keeps calling
                               feed() (stops 3 s after the last call)
     UnlimiterUI.setHost(fn)   fn() returns a visible window whose animation
                               frames the tool borrows while its own window is
                               minimized or hidden, so it keeps drawing

   Inside an iframe (e.g. hosted by the Rack) it does nothing.
   ===================================================================== */
(function(global){
"use strict";
if(global.UnlimiterUI) return;
const VERSION="1.1";
const embedded=(function(){try{return global.top!==global}catch(e){return true}})();
const scriptEl=document.currentScript;

const UI={version:VERSION,active:!embedded};
global.UnlimiterUI=UI;
if(embedded) return;

let feedCv=null,feedCtx=null,feedAt=-1e9,hostFn=null;
const feedLive=()=>!!feedCv&&performance.now()-feedAt<3000;
let outWin=null,outCv=null,outCtx=null,srcFn=null,lastPush=0,lastMirror=0,autoCv=null,autoAt=0,lastFrameT=0;
const listeners=new Set();
const isOpen=()=>!!(outWin&&!outWin.closed&&outCtx);

/* ---------- which canvas ---------- */
// Remember what kind of context each canvas was given (we load before the tool does)
const ctxType=new WeakMap(),ctxAttr=new WeakMap();
const nativeGetContext=HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext=function(type,attrs){
  const c=nativeGetContext.apply(this,arguments);
  if(c&&!ctxType.has(this)){ctxType.set(this,String(type));ctxAttr.set(this,attrs||{})}
  return c;
};
const kind=c=>{const t=ctxType.get(c);return !t?null:t==="2d"||t==="bitmaprenderer"?"2d":t==="webgpu"?"gpu":"gl"};
function cfg(name){
  return (scriptEl&&scriptEl.getAttribute(name))||(document.body&&document.body.getAttribute(name))||null;
}
// The largest visible canvas, plus any canvases stacked exactly on top of it (layered tools)
function autoList(){
  const now=performance.now();
  if(autoCv&&autoCv.every(c=>c.isConnected)&&now-autoAt<1000) return autoCv;
  autoAt=now;
  const sel=cfg("data-ulx-canvas");
  if(sel){const c=document.querySelector(sel);if(c){autoCv=[c];return autoCv}}
  const all=[];
  document.querySelectorAll("canvas").forEach(c=>{
    if(c.closest(".ulx-bar")||!c.width||!c.height) return;
    const cs=getComputedStyle(c);if(cs.visibility==="hidden"||cs.display==="none"||+cs.opacity===0) return;
    const r=c.getBoundingClientRect();if(r.width*r.height<=0) return;
    all.push({c:c,r:r,a:r.width*r.height});
  });
  if(!all.length){autoCv=[];return autoCv}
  let best=all[0];all.forEach(o=>{if(o.a>best.a)best=o});
  const near=(a,b)=>Math.abs(a-b)<=3;
  autoCv=all.filter(o=>o===best||(near(o.r.left,best.r.left)&&near(o.r.top,best.r.top)&&near(o.r.width,best.r.width)&&near(o.r.height,best.r.height))).map(o=>o.c);
  return autoCv;   // document order = stacking order for these tools
}
function list(){
  try{const c=srcFn&&srcFn();if(c&&c.width)return [c]}catch(e){}
  return autoList();
}
// Canvases that can be copied at any time (2D, or WebGL that keeps its buffer)
const idleSafe=c=>{const k=kind(c);return k==="2d"||(k==="gl"&&!!ctxAttr.get(c).preserveDrawingBuffer)};
function copyTo(cv,cx,L){
  const base=L[0];if(!base||!base.width) return;
  if(cv.width!==base.width||cv.height!==base.height){cv.width=base.width;cv.height=base.height}
  try{
    // transparent canvases sit on a CSS background in the tool; paint that first
    cx.fillStyle=bgOf(base);cx.fillRect(0,0,cv.width,cv.height);
    for(const c of L) if(c.width) cx.drawImage(c,0,0,cv.width,cv.height);
  }catch(e){}
}
// Copy to every place that wants frames: the output window and/or the feed
function copy(L){
  if(!L||!L.length) return;
  if(isOpen()) copyTo(outCv,outCtx,L);
  if(feedLive()) copyTo(feedCv,feedCtx,L);
  lastMirror=performance.now();
}
const wanted=()=>isOpen()||feedLive();
const bgCache=new WeakMap();
function bgOf(c){
  const hit=bgCache.get(c),now=performance.now();if(hit&&now-hit.t<2000)return hit.v;
  let v="#000",e=c;
  while(e&&e.nodeType===1){const b=getComputedStyle(e).backgroundColor;if(b&&b!=="transparent"&&!/rgba\([^)]*,\s*0\)$/.test(b)){v=b;break}e=e.parentElement}
  if(v==="#000"){const b=getComputedStyle(document.body).backgroundColor;if(b&&!/rgba\([^)]*,\s*0\)$/.test(b))v=b}
  bgCache.set(c,{t:now,v:v});return v;
}
const hasGPU=L=>L.some(c=>kind(c)==="gpu");
// WebGPU canvases are only readable straight after the frame is submitted
if(global.GPUQueue&&GPUQueue.prototype&&GPUQueue.prototype.submit){
  const nativeSubmit=GPUQueue.prototype.submit;let queued=false;
  GPUQueue.prototype.submit=function(){
    const r=nativeSubmit.apply(this,arguments);
    if(wanted()&&!queued){queued=true;queueMicrotask(()=>{queued=false;const L=list();if(hasGPU(L))copy(L)})}
    return r;
  };
}

/* ---------- animation frames follow the output window while it is open ---------- */
const nativeRAF=global.requestAnimationFrame.bind(global),nativeCAF=global.cancelAnimationFrame.bind(global);
let seq=0;const pend=new Map();
function fire(id){
  const p=pend.get(id);if(!p)return;pend.delete(id);
  lastFrameT=performance.now();
  try{p.cb(lastFrameT)}
  finally{ if(wanted()&&performance.now()-lastPush>500){const L=list();if(!hasGPU(L))copy(L)} }
}
// Whose clock drives our frames: the output window when open; a visible host (MetaMapper)
// while this window is minimized or hidden; otherwise our own.
function frameWin(){
  if(isOpen()) return outWin;
  if(document.hidden&&hostFn){
    try{const w=hostFn();if(w&&w!==global&&!w.closed&&!w.document.hidden)return w}catch(e){}
  }
  return null;
}
function schedule(id){
  const p=pend.get(id);if(!p)return;
  const w=frameWin();
  if(w){try{p.w=w;p.wid=w.requestAnimationFrame(()=>fire(id));return}catch(e){}}
  p.w=null;p.wid=nativeRAF(()=>fire(id));
}
global.requestAnimationFrame=function(cb){const id=++seq;pend.set(id,{cb:cb,w:null,wid:0});schedule(id);return id};
global.cancelAnimationFrame=function(id){
  const p=pend.get(id);if(!p){try{nativeCAF(id)}catch(e){}return}
  pend.delete(id);
  try{p.w?p.w.cancelAnimationFrame(p.wid):nativeCAF(p.wid)}catch(e){}
};
// Frames that were waiting on a window that has just closed go back to this one
function rehome(){pend.forEach((p,id)=>{const want=frameWin();if(p.w!==want){try{p.w?p.w.cancelAnimationFrame(p.wid):nativeCAF(p.wid)}catch(e){}schedule(id)}})}
document.addEventListener("visibilitychange",rehome);
// A borrowed clock can stop (host closed, hidden or reloaded): move the frames back
setInterval(()=>{let stale=false;pend.forEach(p=>{try{if(p.w&&(p.w.closed||p.w.document.hidden))stale=true}catch(e){stale=true}});
  if(stale||(document.hidden&&hostFn&&pend.size&&[...pend.values()].every(p=>!p.w)))rehome()},400);

/* ---------- output window ---------- */
function toolName(){return (document.title||"Unlimiter").replace(/\s*[—|-].*$/,"").trim()||"Unlimiter"}
function openOutput(getCanvas){
  if(typeof getCanvas==="function") srcFn=getCanvas;
  if(isOpen()){outWin.focus();return outWin}
  outWin=global.open("","UnlimiterOutput","width=1280,height=720");
  if(!outWin){alert("The output window was blocked. Allow pop-ups for this page and try again.");return null}
  const d=outWin.document;d.open();
  d.write('<!DOCTYPE html><html><head><title>UNLIMITER OUTPUT — '+toolName().replace(/</g,"")+'</title><style>'+
    'html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}'+
    'canvas{display:block;width:100vw;height:100vh;object-fit:contain}'+
    '#h{position:fixed;left:14px;top:12px;color:#9aa;font:12px Consolas,monospace;background:rgba(0,0,0,.7);padding:7px 10px;border-radius:4px;transition:opacity 1.5s;pointer-events:none;line-height:1.6}'+
    '</style></head><body><canvas id="o" width="16" height="9"></canvas>'+
    '<div id="h">UNLIMITER OUTPUT · '+toolName().replace(/</g,"")+'<br>Drag this window to the projector, then double-click it or press F for fullscreen.<br>Point OBS window capture here, or use it as a MetaMapper source.</div></body></html>');
  d.close();
  outCv=d.getElementById("o");outCtx=outCv.getContext("2d");
  const fs=()=>{try{d.fullscreenElement?d.exitFullscreen():d.documentElement.requestFullscreen().catch(()=>{})}catch(e){}};
  outCv.addEventListener("dblclick",fs);
  outWin.addEventListener("keydown",e=>{
    if((e.key==="f"||e.key==="F")&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();fs();return}
    // pass everything else to the tool, as if typed in its own window
    try{document.dispatchEvent(new KeyboardEvent("keydown",{key:e.key,code:e.code,shiftKey:e.shiftKey,ctrlKey:e.ctrlKey,altKey:e.altKey,metaKey:e.metaKey,bubbles:true}))}catch(_){}
  });
  outWin.addEventListener("keyup",e=>{try{document.dispatchEvent(new KeyboardEvent("keyup",{key:e.key,code:e.code,shiftKey:e.shiftKey,ctrlKey:e.ctrlKey,altKey:e.altKey,metaKey:e.metaKey,bubbles:true}))}catch(_){}});
  outWin.addEventListener("pagehide",()=>setTimeout(onClosed,0));
  setTimeout(()=>{try{const h=d.getElementById("h");if(h)h.style.opacity="0"}catch(e){}},7000);
  {const L=list();if(L.every(idleSafe))copy(L)}
  rehome();             // move running loops onto the output window's clock
  idlePull();
  placeOnSecondScreen();
  notify();
  return outWin;
}
function closeOutput(){if(outWin&&!outWin.closed)outWin.close();onClosed()}
function onClosed(){
  if(outWin&&!outWin.closed) return;
  outWin=null;outCv=null;outCtx=null;rehome();notify();
}
// If the tool is idle (draws only on change), keep the output filled from a safe canvas
function idlePull(){
  if(!isOpen())return;
  const now=performance.now();
  if(now-lastFrameT>250&&now-lastPush>500){const L=list();if(L.length&&L.every(idleSafe))copy(L)}
  try{outWin.requestAnimationFrame(idlePull)}catch(e){}
}
async function placeOnSecondScreen(){
  try{
    if(!("getScreenDetails" in global))return;
    const sd=await global.getScreenDetails();
    const other=sd.screens.find(s=>s!==sd.currentScreen&&!s.isPrimary)||sd.screens.find(s=>s!==sd.currentScreen);
    if(!other||!isOpen())return;
    outWin.moveTo(other.availLeft,other.availTop);outWin.resizeTo(other.availWidth,other.availHeight);
  }catch(e){}
}
function toggleFullscreen(){
  if(!isOpen())return;
  try{const d=outWin.document;if(d.fullscreenElement)d.exitFullscreen();else d.documentElement.requestFullscreen().catch(()=>{outWin.focus()})}catch(e){}
  outWin.focus();
}
setInterval(()=>{if(outWin&&outWin.closed)onClosed()},500);

/* ---------- pinned OUTPUT bar ---------- */
const CSS=`
.ulx-bar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  margin:0 0 8px;padding:7px 8px;background:var(--panel,var(--bg,#16191b));
  border:1px solid var(--line,#2e3338);border-radius:4px;font:600 11px/1.2 var(--sans,system-ui,sans-serif);color:var(--text,#e8e6e1)}
.ulx-bar .ulx-t{letter-spacing:.12em;color:var(--dim,#8d9490);font-size:10px;margin-right:2px}
.ulx-bar .ulx-dot{width:8px;height:8px;border-radius:50%;background:var(--line,#2e3338);flex:none}
.ulx-bar.live .ulx-dot{background:var(--hot,#e0714f);box-shadow:0 0 6px var(--hot,#e0714f)}
.ulx-bar button{flex:1 1 auto;min-width:0;cursor:pointer;font:inherit;font-weight:500;padding:5px 8px;border-radius:3px;
  background:var(--panel-2,#24282b);color:var(--text,#e8e6e1);border:1px solid var(--line,#2e3338)}
.ulx-bar button:hover{border-color:var(--accent,#7fd1c0)}
.ulx-bar.live .ulx-open{border-color:var(--hot,#e0714f);color:var(--hot,#e0714f)}
.ulx-bar .ulx-fs{display:none}.ulx-bar.live .ulx-fs{display:block}
.ulx-bar.ulx-float{position:fixed;top:10px;right:10px;margin:0;width:auto;max-width:300px;opacity:.85}
.ulx-bar.ulx-float:hover{opacity:1}`;
let bar=null;
function notify(){
  const o=isOpen();
  if(bar){bar.classList.toggle("live",o);bar.querySelector(".ulx-open").textContent=o?"● Live — close output":"⧉ Open output window"}
  listeners.forEach(f=>{try{f(o)}catch(e){}});
}
function mountBar(){
  if(cfg("data-ulx-bar")==="off"||bar)return;
  const st=document.createElement("style");st.textContent=CSS;document.head.appendChild(st);
  bar=document.createElement("div");bar.className="ulx-bar";
  bar.innerHTML='<span class="ulx-dot"></span><span class="ulx-t">OUTPUT</span>'+
    '<button class="ulx-open" type="button" title="Open the clean output window for the projector, OBS or MetaMapper">⧉ Open output window</button>'+
    '<button class="ulx-fs" type="button" title="Fullscreen the output window (or double-click it / press F in it)">⛶ Fullscreen</button>';
  bar.querySelector(".ulx-open").addEventListener("click",()=>isOpen()?closeOutput():openOutput());
  bar.querySelector(".ulx-fs").addEventListener("click",toggleFullscreen);
  const ph=document.querySelector("[data-ulx-output]");
  const firstSec=document.querySelector("details");
  if(ph){ph.appendChild(bar)}
  else if(firstSec&&firstSec.parentElement){firstSec.parentElement.insertBefore(bar,firstSec)}
  else{bar.classList.add("ulx-float");document.body.appendChild(bar)}
  notify();
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mountBar);else mountBar();

UI.openOutput=openOutput;
UI.closeOutput=closeOutput;
UI.isOpen=isOpen;
UI.toggleFullscreen=toggleFullscreen;
UI.setSource=fn=>{srcFn=typeof fn==="function"?fn:null;autoCv=null};
UI.pushFrame=src=>{const L=src?[src]:list();lastPush=performance.now();copy(L)};
UI.onChange=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
UI.outputWindow=()=>isOpen()?outWin:null;
UI.feed=()=>{
  if(!feedCv){feedCv=document.createElement("canvas");feedCv.width=16;feedCv.height=9;feedCtx=feedCv.getContext("2d")}
  const was=feedLive();feedAt=performance.now();
  if(!was){const L=list();if(L.length&&L.every(idleSafe))copy(L)}
  return feedCv;
};
UI.setHost=fn=>{hostFn=typeof fn==="function"?fn:null;rehome()};
})(typeof window!=="undefined"?window:this);
