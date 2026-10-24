/* ============================================================
   unlimiter-camera.js — choose which camera the suite uses

   Every tool asks the browser for "a camera", and the browser hands back
   its default, usually a laptop's built-in one. Load this file first and
   every camera request in the page uses the camera you picked instead, and
   the choice is remembered for every tool on the same site (one choice for
   the whole suite, MetaMapper included when it is served alongside).

     <script src="unlimiter-camera.js"></script>
     UnlimiterCamera.mount(container)   // a "Camera" menu, appended to container

   Picking another camera while one is running swaps it in place: the
   running stream gets the new camera's track, so the tool keeps going
   without being restarted.
   ============================================================ */
(function(global){
"use strict";
const KEY = "unlimiter.camera.device";
const md = global.navigator && global.navigator.mediaDevices;
const stub = { mount(){ return null; }, choose(){}, current(){ return ""; }, list(){ return Promise.resolve([]); } };
if(!md || !md.getUserMedia){ global.UnlimiterCamera = stub; return; }
if(global.UnlimiterCamera && global.UnlimiterCamera.__real) return;   // loaded twice

const orig = md.getUserMedia.bind(md);
const live = [];                                  // streams handed out: { stream, c }
const menus = new Set();
let devices = [];

function saved(){ try{ return localStorage.getItem(KEY) || ""; }catch(e){ return ""; } }
function save(id){ try{ if(id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); }catch(e){} }
function withDevice(c, id){
  if(!c || !c.video || !id) return c;
  const v = c.video === true ? {} : Object.assign({}, c.video);
  if(v.deviceId || v.facingMode) return c;        // the page asked for something specific itself
  v.deviceId = { exact: id };
  return Object.assign({}, c, { video: v });
}
/* every camera request in the page goes through here */
md.getUserMedia = async function(c){
  const id = saved();
  let st;
  if(c && c.video && id){
    try{ st = await orig(withDevice(c, id)); }
    catch(e){
      // that camera is unplugged (or can't do what was asked): fall back to the default
      if(e && /Overconstrained|NotFound|NotReadable/.test(e.name)) st = await orig(c);
      else throw e;
    }
  } else st = await orig(c);
  if(c && c.video){ live.push({ stream: st, c }); refresh(); }
  return st;
};

async function list(){
  try{ devices = (await md.enumerateDevices()).filter(d => d.kind === "videoinput"); }catch(e){ devices = []; }
  return devices;
}
function inUse(){
  for(let i = live.length - 1; i >= 0; i--){
    const t = live[i].stream.getVideoTracks().find(t => t.readyState === "live");
    if(t && t.getSettings) return t.getSettings().deviceId || "";
  }
  return "";
}
/* pick a camera; running streams swap to it in place */
async function choose(id){
  save(id);
  for(const e of live){
    const old = e.stream.getVideoTracks().filter(t => t.readyState === "live");
    if(!old.length) continue;
    try{
      const ns = await orig(id ? withDevice(e.c, id) : e.c);
      const nt = ns.getVideoTracks()[0]; if(!nt) continue;
      old.forEach(t => { t.stop(); e.stream.removeTrack(t); });
      e.stream.addTrack(nt);
      // video elements showing this stream pick up the new track
      document.querySelectorAll("video").forEach(v => { if(v.srcObject === e.stream){ v.srcObject = null; v.srcObject = e.stream; v.play().catch(() => {}); } });
    }catch(err){ console.warn("[camera] couldn't switch:", err && err.name); }
  }
  try{ global.dispatchEvent(new CustomEvent("unlimiter-camera", { detail: { deviceId: id } })); }catch(e){}
  refresh();
}
async function refresh(){
  await list();
  menus.forEach(fill);
}
function fill(sel){
  if(!sel.isConnected){ menus.delete(sel); return; }
  const want = saved(), using = inUse();
  sel.innerHTML = "";
  const add = (v, t, dis) => { const o = document.createElement("option"); o.value = v; o.textContent = t; if(dis) o.disabled = true; sel.appendChild(o); };
  add("", "Default camera");
  let unnamed = false;
  devices.forEach((d, i) => {
    if(!d.label) unnamed = true;
    add(d.deviceId, (d.label || ("Camera " + (i + 1))) + (d.deviceId && d.deviceId === using ? "  ●" : ""));
  });
  if(unnamed) add("-", "(start a camera once to see their names)", true);
  sel.value = devices.some(d => d.deviceId === want) ? want : "";
  sel.title = "Which camera this tool (and the rest of the suite) uses. ● marks the one running now.";
}
/* a Camera menu, appended to `container` */
function mount(container, opts){
  if(!container) return null;
  opts = opts || {};
  const sel = document.createElement("select");
  sel.className = "ucam-select";
  sel.setAttribute("aria-label", "Camera");
  sel.style.cssText = opts.style || "flex:1 1 120px;min-width:0;max-width:100%;width:auto";
  sel.addEventListener("click", e => e.stopPropagation());
  sel.addEventListener("mousedown", e => e.stopPropagation());
  sel.addEventListener("change", () => { if(sel.value !== "-") choose(sel.value); });
  sel.addEventListener("focus", () => list().then(() => fill(sel)));
  container.appendChild(sel);
  menus.add(sel);
  list().then(() => fill(sel));
  return sel;
}
if(md.addEventListener) md.addEventListener("devicechange", refresh);

global.UnlimiterCamera = { __real: true, mount, choose, list, current: saved, inUse };
if(typeof module !== "undefined" && module.exports) module.exports = global.UnlimiterCamera;
})(typeof window !== "undefined" ? window : globalThis);
