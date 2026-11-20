/* ============================================================
   unlimiter-link.js — points between tabs (schemaVersion 1)

   Inside the Rack, points travel by reference on a ports cable. Two
   tools open in two separate tabs (Lattice on the webcam in one,
   Overtone in another) share nothing — so this carries a points frame
   across tabs over a BroadcastChannel, downsampled and throttled.

   It costs nothing until someone listens: a receiver says "want"
   every two seconds; a sender only sends while it has heard a want in
   the last five. ARCHITECTURE.md keeps cross-tab traffic small on
   purpose — 256 points at 20 fps is about 5 KB a message.

   sender:    UnlimiterLink.sendPoints("lattice", frame)   // call every frame; it throttles
   receiver:  UnlimiterLink.listen(name => …, (name, frame) => …)
              UnlimiterLink.senders()   // [{name, count, age}]
   ============================================================ */
(function(global){
"use strict";
const VERSION = "1.0";
const CH = "unlimiter-points";
const MAX = 256, HZ = 20;
const hasBC = typeof BroadcastChannel !== "undefined";
const bc = hasBC ? new BroadcastChannel(CH) : null;
let lastWant = 0, lastSend = {}, wantTimer = 0;
const seen = new Map();         // name -> {count, t, frame}
let onFrame = null, onSender = null;

if(bc) bc.onmessage = e => {
  const m = e.data;
  if(!m || typeof m !== "object") return;
  if(m.k === "want"){ lastWant = performance.now(); return; }
  if(m.k === "pts" && m.name){
    const prev = seen.get(m.name);
    const f = toFrame(m, prev && prev.frame);
    const isNew = !prev;
    seen.set(m.name, { count: m.count, t: performance.now(), frame: f });
    if(isNew && onSender) onSender(m.name);
    if(onFrame) onFrame(m.name, f);
  }
};

function toFrame(m, f){
  const n = m.count | 0;
  if(!f || f.capacity < n){
    let cap = 1; while(cap < n) cap <<= 1;
    f = { type: "points", space: m.space || "uv", aspect: m.aspect || 1, count: 0, capacity: cap, version: 0,
      positions: new Float32Array(cap * 3), colors: new Float32Array(cap * 3).fill(1),
      sizes: new Float32Array(cap).fill(1), presence: new Float32Array(cap).fill(1), tangents: new Float32Array(cap * 3) };
  }
  f.count = n; f.space = m.space || "uv"; f.aspect = m.aspect || 1;
  f.positions.set(m.p.subarray(0, n * 3));
  if(m.c) f.colors.set(m.c.subarray(0, n * 3));
  if(m.s) f.sizes.set(m.s.subarray(0, n));
  if(m.t) f.tangents.set(m.t.subarray(0, n * 3)); else f.tangents.fill(0, 0, n * 3);
  if(m.pr) f.presence.set(m.pr.subarray(0, n)); else f.presence.fill(1, 0, n);
  f.version = (f.version + 1) >>> 0;
  return f;
}

function sendPoints(name, frame){
  if(!bc || !frame) return false;
  const now = performance.now();
  if(now - lastWant > 5000) return false;                  // nobody listening
  if(now - (lastSend[name] || 0) < 1000 / HZ) return false;
  lastSend[name] = now;
  const n = Math.min(frame.count | 0, MAX), total = frame.count | 0;
  const stride = total > MAX ? total / MAX : 1;
  const p = new Float32Array(n * 3), c = frame.colors ? new Float32Array(n * 3) : null;
  const s = frame.sizes ? new Float32Array(n) : null, t = frame.tangents ? new Float32Array(n * 3) : null;
  const pr = frame.presence ? new Float32Array(n) : null;
  for(let i = 0; i < n; i++){
    const j = Math.floor(i * stride);
    for(let k = 0; k < 3; k++){
      p[i * 3 + k] = frame.positions[j * 3 + k];
      if(c) c[i * 3 + k] = frame.colors[j * 3 + k];
      if(t) t[i * 3 + k] = frame.tangents[j * 3 + k];
    }
    if(s) s[i] = frame.sizes[j];
    if(pr) pr[i] = frame.presence[j];
  }
  try{ bc.postMessage({ k: "pts", name, count: n, space: frame.space || "uv", aspect: frame.aspect || 1, p, c, s, t, pr }); }
  catch(e){ return false; }
  return true;
}

function listen(senderCb, frameCb){
  onSender = senderCb || null; onFrame = frameCb || null;
  if(!bc || wantTimer) return;
  const want = () => { try{ bc.postMessage({ k: "want" }); }catch(e){} };
  want(); wantTimer = setInterval(want, 2000);
}
function senders(){
  const now = performance.now(), out = [];
  seen.forEach((v, k) => out.push({ name: k, count: v.count, age: (now - v.t) / 1000 }));
  return out;
}
function latest(name){
  const v = seen.get(name);
  return v && performance.now() - v.t < 1500 ? v.frame : null;
}

global.UnlimiterLink = { version: VERSION, available: !!bc, sendPoints, listen, senders, latest };
})(typeof window !== "undefined" ? window : globalThis);
