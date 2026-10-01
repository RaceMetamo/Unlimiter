/* ============================================================
   unlimiter-vision.js — machine-vision primitives that run in the page

   Plain JS on typed arrays at a small analysis size (192×108): no library,
   no wasm, no GL context — so it runs inside the Rack on the Rack's own clock
   and hands its results out by reference, like unlimiter-points.js.

   One engine turns a picture into the four port types:

     mode     what it finds                          gives
     flow     motion between frames (pyramidal       field  velocity, uv per second
              Lucas–Kanade, dense)                   mask   where things move
                                                     points seeds on moving areas, tangent = direction
     edges    structure (Sobel, thinned)             points on edges, tangent runs along the edge
                                                     field  orientation of structure (sign arbitrary)
                                                     mask   the edges
     bgsub    what is new (running background,       mask   the foreground silhouette
              selective update)                      points spread over it
                                                     field  outward normal of the silhouette
     tracks   corners that stay put on the thing     points tracked features, tangent = velocity
              (Shi–Tomasi + sparse LK)               field  their motion, splatted smooth

   const V = UnlimiterVision.create();
   const out = V.step(rgba, aspect, nowSeconds, "flow", params);
   out = { points, field, mask, vis (RGBA w×h), w, h, stats }  — an output the mode
   doesn't produce is null.  Positions are "uv" (v down), aspect = the source's.

   node test_vision.js
   ============================================================ */
const UnlimiterVision = (() => {
"use strict";

const W = 192, H = 108, N = W * H;
const FW = 48, FH = 27;                         // the field grid: 4×4 blocks of the analysis frame
const MODES = ["flow", "edges", "bgsub", "tracks"];

/* the knobs, in inspector order. min/max/step/def are what the Rack builds sliders from */
const PARAMS = {
  common: [
    { key:"fps",    label:"analysis rate", min:5,   max:60,  step:1,    def:30 },
    { key:"points", label:"points",        min:8,   max:400, step:1,    def:120 },
    { key:"gain",   label:"field gain",    min:0,   max:4,   step:0.01, def:1 },
  ],
  flow: [
    { key:"thresh", label:"motion threshold", min:0.02, max:2,   step:0.01, def:0.3 },
    { key:"smooth", label:"temporal smoothing", min:0, max:0.95, step:0.01, def:0.45 },
  ],
  edges: [
    { key:"thresh", label:"edge threshold",   min:0.02, max:1,   step:0.01, def:0.3 },
    { key:"blur",   label:"pre-blur",         min:0,    max:3,   step:1,    def:1 },
  ],
  bgsub: [
    { key:"thresh", label:"difference threshold", min:0.02, max:0.5, step:0.01, def:0.1 },
    { key:"learn",  label:"background learn rate", min:0,   max:0.2, step:0.001, def:0.02 },
  ],
  tracks: [
    { key:"quality", label:"corner quality", min:0.005, max:0.3, step:0.005, def:0.03 },
    { key:"mindist", label:"min distance",   min:3,     max:20,  step:1,     def:7 },
    { key:"maxage",  label:"max age (frames)", min:20,  max:600, step:1,     def:180 },
  ],
};
function resolve(mode, P){
  const o = {};
  PARAMS.common.concat(PARAMS[mode] || []).forEach(p => {
    let v = P && P[p.key] != null ? Number(P[p.key]) : p.def;
    if(!isFinite(v)) v = p.def;
    o[p.key] = Math.max(p.min, Math.min(p.max, v));
  });
  return o;
}

/* ---------------- small image maths ---------------- */
function clampi(i, lo, hi){ return i < lo ? lo : i > hi ? hi : i; }
function toGray(rgba, g){
  for(let i = 0, j = 0; i < N; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return g;
}
/* separable box blur with clamped edges; dst may equal src */
function boxBlur(src, dst, w, h, r, tmp){
  if(r <= 0){ if(dst !== src) dst.set(src.subarray(0, w * h)); return dst; }
  const k = 1 / (2 * r + 1);
  for(let y = 0; y < h; y++){
    const o = y * w; let s = 0;
    for(let i = -r; i <= r; i++) s += src[o + clampi(i, 0, w - 1)];
    for(let x = 0; x < w; x++){
      tmp[o + x] = s * k;
      s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  for(let x = 0; x < w; x++){
    let s = 0;
    for(let i = -r; i <= r; i++) s += tmp[clampi(i, 0, h - 1) * w + x];
    for(let y = 0; y < h; y++){
      dst[y * w + x] = s * k;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return dst;
}
function bil(a, w, h, x, y){
  if(x < 0) x = 0; else if(x > w - 1.001) x = w - 1.001;
  if(y < 0) y = 0; else if(y > h - 1.001) y = h - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + w] * (1 - fx) + a[i + w + 1] * fx) * fy;
}
function hsv(h, s, v, out){
  h = ((h % 1) + 1) % 1; const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch(i % 6){
    case 0: out[0] = v; out[1] = t; out[2] = p; break;
    case 1: out[0] = q; out[1] = v; out[2] = p; break;
    case 2: out[0] = p; out[1] = v; out[2] = t; break;
    case 3: out[0] = p; out[1] = q; out[2] = v; break;
    case 4: out[0] = t; out[1] = p; out[2] = v; break;
    default: out[0] = v; out[1] = p; out[2] = q;
  }
  return out;
}

/* ---------------- pyramids ---------------- */
const LEVELS = 3;
function makePyr(){
  const p = []; let w = W, h = H;
  for(let l = 0; l < LEVELS; l++){ p.push({ w, h, d:new Float32Array(w * h) }); w = Math.max(2, w >> 1); h = Math.max(2, h >> 1); }
  return p;
}
function fillPyr(pyr, gray, tmp){
  boxBlur(gray, pyr[0].d, W, H, 1, tmp);
  for(let l = 1; l < LEVELS; l++){
    const a = pyr[l - 1], b = pyr[l];
    for(let y = 0; y < b.h; y++) for(let x = 0; x < b.w; x++){
      const sx = Math.min(a.w - 2, x * 2), sy = Math.min(a.h - 2, y * 2), i = sy * a.w + sx;
      b.d[y * b.w + x] = (a.d[i] + a.d[i + 1] + a.d[i + a.w] + a.d[i + a.w + 1]) * 0.25;
    }
  }
}

/* ---------------- the engine ---------------- */
function create(PT){
  PT = PT || (typeof globalThis !== "undefined" && globalThis.UnlimiterPorts);
  if(!PT || !PT.makeField) throw new Error("unlimiter-vision.js needs unlimiter-ports.js loaded first");

  const gray = new Float32Array(N), prevGray = new Float32Array(N), tmp = new Float32Array(N);
  const pyrA = makePyr(), pyrB = makePyr();
  let curPyr = pyrA, prevPyr = pyrB;
  const lv = []; { let w = W, h = H;
    for(let l = 0; l < LEVELS; l++){
      lv.push({ w, h, u:new Float32Array(w * h), v:new Float32Array(w * h),
        A:new Float32Array(w * h), B:new Float32Array(w * h), C:new Float32Array(w * h),
        bx:new Float32Array(w * h), by:new Float32Array(w * h), ix:new Float32Array(w * h), iy:new Float32Array(w * h) });
      w = Math.max(2, w >> 1); h = Math.max(2, h >> 1);
    } }
  const fU = new Float32Array(N), fV = new Float32Array(N);        // L0 flow, px/frame, smoothed
  const bg = new Float32Array(N), fg = new Uint8Array(N), fg2 = new Uint8Array(N), soft = new Float32Array(N);
  const ix0 = new Float32Array(N), iy0 = new Float32Array(N), jxx = new Float32Array(N), jxy = new Float32Array(N), jyy = new Float32Array(N);
  const cornerness = new Float32Array(N);
  const vis = new Uint8ClampedArray(N * 4);
  const rgb = [0, 0, 0];

  const st = { mode:null, frames:0, lastT:null, bgFrames:0, tracks:[], nextId:1, havePrev:false,
               points:null, field:null, mask:null, stats:{ n:0, activity:0 } };

  function reset(){
    st.frames = 0; st.lastT = null; st.bgFrames = 0; st.tracks.length = 0; st.havePrev = false;
    fU.fill(0); fV.fill(0);
  }

  /* ---- dense pyramidal Lucas–Kanade: P0 → P1, result in lv[0].u/v (px/frame) ---- */
  function denseFlow(P0, P1){
    const R = 3, LAM = 30, ITERS = 3;
    for(let l = LEVELS - 1; l >= 0; l--){
      const s = lv[l], w = s.w, h = s.h, I1 = P0[l].d, I2 = P1[l].d;
      if(l === LEVELS - 1){ s.u.fill(0); s.v.fill(0); }
      else {
        const c = lv[l + 1];
        for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
          const ci = Math.min(c.h - 1, y >> 1) * c.w + Math.min(c.w - 1, x >> 1);
          s.u[y * w + x] = c.u[ci] * 2; s.v[y * w + x] = c.v[ci] * 2;
        }
      }
      for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
        const i = y * w + x;
        const gx = x > 0 && x < w - 1 ? (I1[i + 1] - I1[i - 1]) * 0.5 : 0;
        const gy = y > 0 && y < h - 1 ? (I1[i + w] - I1[i - w]) * 0.5 : 0;
        s.ix[i] = gx; s.iy[i] = gy; s.A[i] = gx * gx; s.B[i] = gx * gy; s.C[i] = gy * gy;
      }
      boxBlur(s.A, s.A, w, h, R, tmp); boxBlur(s.B, s.B, w, h, R, tmp); boxBlur(s.C, s.C, w, h, R, tmp);
      for(let it = 0; it < ITERS; it++){
        for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
          const i = y * w + x;
          const e = bil(I2, w, h, x + s.u[i], y + s.v[i]) - I1[i];
          s.bx[i] = s.ix[i] * e; s.by[i] = s.iy[i] * e;
        }
        boxBlur(s.bx, s.bx, w, h, R, tmp); boxBlur(s.by, s.by, w, h, R, tmp);
        for(let i = 0; i < w * h; i++){
          const a = s.A[i] + LAM, c = s.C[i] + LAM, b = s.B[i], det = a * c - b * b;
          let du = -(c * s.bx[i] - b * s.by[i]) / det, dv = -(a * s.by[i] - b * s.bx[i]) / det;
          du = du < -2 ? -2 : du > 2 ? 2 : du; dv = dv < -2 ? -2 : dv > 2 ? 2 : dv;
          s.u[i] += du; s.v[i] += dv;
        }
      }
    }
  }

  /* ---- sparse pyramidal LK for one point; returns false if it should be dropped ---- */
  const WR = 4, WN = (2 * WR + 1) * (2 * WR + 1);
  const tT = new Float32Array(WN), tX = new Float32Array(WN), tY = new Float32Array(WN);
  const lk = { x:0, y:0, err:0 };
  function trackPoint(P0, P1, x, y){
    let gx = 0, gy = 0;
    for(let l = LEVELS - 1; l >= 0; l--){
      const sc = 1 << l, w = P0[l].w, h = P0[l].h, I0 = P0[l].d, I1 = P1[l].d;
      const px = x / sc, py = y / sc;
      let dx = gx / sc, dy = gy / sc, a = 0, b = 0, c = 0, k = 0;
      for(let oy = -WR; oy <= WR; oy++) for(let ox = -WR; ox <= WR; ox++, k++){
        const X = px + ox, Y = py + oy;
        tT[k] = bil(I0, w, h, X, Y);
        tX[k] = (bil(I0, w, h, X + 1, Y) - bil(I0, w, h, X - 1, Y)) * 0.5;
        tY[k] = (bil(I0, w, h, X, Y + 1) - bil(I0, w, h, X, Y - 1)) * 0.5;
        a += tX[k] * tX[k]; b += tX[k] * tY[k]; c += tY[k] * tY[k];
      }
      const det = a * c - b * b;
      if(det < 1e-3 * WN) { if(l === 0) return false; else continue; }
      for(let it = 0; it < 6; it++){
        let bx = 0, by = 0; k = 0;
        for(let oy = -WR; oy <= WR; oy++) for(let ox = -WR; ox <= WR; ox++, k++){
          const e = bil(I1, w, h, px + dx + ox, py + dy + oy) - tT[k];
          bx += tX[k] * e; by += tY[k] * e;
        }
        const ddx = -(c * bx - b * by) / det, ddy = -(a * by - b * bx) / det;
        dx += ddx; dy += ddy;
        if(Math.abs(ddx) + Math.abs(ddy) < 0.03) break;
      }
      gx = dx * sc; gy = dy * sc;
    }
    const nx = x + gx, ny = y + gy;
    if(!(nx > 3 && nx < W - 4 && ny > 3 && ny < H - 4)) return false;
    let err = 0, k = 0;
    const I0 = P0[0].d, I1 = P1[0].d;
    for(let oy = -2; oy <= 2; oy++) for(let ox = -2; ox <= 2; ox++, k++)
      err += Math.abs(bil(I1, W, H, nx + ox, ny + oy) - bil(I0, W, H, x + ox, y + oy));
    err /= 25;
    if(err > 18) return false;
    lk.x = nx; lk.y = ny; lk.err = err;
    return true;
  }

  /* ---- shared helpers for the outputs ---- */
  function ensurePts(n, aspect){
    const f = PT.ensurePoints(st.points, n, "uv");
    if(!f.tangents || f.tangents.length < f.capacity * 3) f.tangents = new Float32Array(f.capacity * 3);
    f.aspect = aspect; f.space = "uv";
    st.points = f; return f;
  }
  function setPt(f, i, px, py, tx, ty, size, pres, rgba){
    const i3 = i * 3;
    f.positions[i3] = (px + 0.5) / W; f.positions[i3 + 1] = (py + 0.5) / H; f.positions[i3 + 2] = 1;
    f.tangents[i3] = tx; f.tangents[i3 + 1] = ty; f.tangents[i3 + 2] = 0;
    f.sizes[i] = size; f.presence[i] = pres;
    const j = (clampi(py | 0, 0, H - 1) * W + clampi(px | 0, 0, W - 1)) * 4;
    f.colors[i3] = rgba[j] / 255; f.colors[i3 + 1] = rgba[j + 1] / 255; f.colors[i3 + 2] = rgba[j + 2] / 255;
  }
  function fieldOut(){ if(!st.field) st.field = PT.makeField(FW, FH); return st.field; }
  function maskOut(){ if(!st.mask) st.mask = PT.makeMask(W, H); return st.mask; }
  function dimSource(rgba, k){
    for(let i = 0, j = 0; i < N; i++, j += 4){
      const g = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) * k;
      vis[j] = g; vis[j + 1] = g; vis[j + 2] = g; vis[j + 3] = 255;
    }
  }
  function plot(x, y, r, g, b, a){
    x = Math.round(x); y = Math.round(y); if(x < 0 || y < 0 || x >= W || y >= H) return;
    const j = (y * W + x) * 4, k = 1 - a;
    vis[j] = vis[j] * k + r * a; vis[j + 1] = vis[j + 1] * k + g * a; vis[j + 2] = vis[j + 2] * k + b * a;
  }
  function line(x0, y0, x1, y1, r, g, b, a){
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for(let i = 0; i <= n; i++) plot(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, r, g, b, a);
  }
  /* even sampling of a candidate list down to `want` entries */
  function pick(list, want){
    if(list.length <= want) return list;
    const out = new Array(want), stp = list.length / want;
    for(let i = 0; i < want; i++) out[i] = list[Math.floor(i * stp)];
    return out;
  }
  function blockAvg(src, fx, fy, out){ // mean of the 4×4 block at field cell (fx,fy)
    let s = 0; const bx = fx * 4, by = fy * 4;
    for(let y = 0; y < 4; y++) for(let x = 0; x < 4; x++) s += src[(by + y) * W + bx + x];
    return s / 16;
  }

  /* ---------------- the modes ---------------- */
  function doFlow(rgba, aspect, dt, p){
    if(!st.havePrev){ fU.fill(0); fV.fill(0); }
    else {
      denseFlow(prevPyr, curPyr);
      const a = p.smooth, s0 = lv[0];
      for(let i = 0; i < N; i++){ fU[i] = fU[i] * a + s0.u[i] * (1 - a); fV[i] = fV[i] * a + s0.v[i] * (1 - a); }
    }
    const f = fieldOut(), unit = p.gain / Math.max(1e-3, dt);
    const m = maskOut(), md = m.data, cand = [];
    let act = 0;
    for(let fy = 0; fy < FH; fy++) for(let fx = 0; fx < FW; fx++){
      const u = blockAvg(fU, fx, fy), v = blockAvg(fV, fx, fy), i = fy * FW + fx;
      f.data[i * 2] = u / W * unit; f.data[i * 2 + 1] = v / H * unit;
      const mag = Math.hypot(u, v);
      if(mag > p.thresh){ cand.push(fx, fy, u, v); act++; }
    }
    // the mask at full analysis size: soft edge around "moving enough"
    for(let i = 0; i < N; i++){
      const mag = Math.hypot(fU[i], fV[i]);
      soft[i] = mag > p.thresh ? Math.min(255, (mag - p.thresh) / p.thresh * 255 + 90) : 0;
    }
    boxBlur(soft, soft, W, H, 1, tmp);
    for(let i = 0; i < N; i++) md[i] = soft[i];
    // points: on the moving cells, heading along the motion
    const cells = []; for(let i = 0; i < cand.length; i += 4) cells.push(i);
    const take = pick(cells, p.points), pf = ensurePts(take.length, aspect);
    take.forEach((ci, k) => {
      const fx = cand[ci], fy = cand[ci + 1], u = cand[ci + 2], v = cand[ci + 3], mag = Math.hypot(u, v) || 1;
      setPt(pf, k, fx * 4 + 2, fy * 4 + 2, u / mag, v / mag, 1 + Math.min(3, mag * 0.6), Math.min(1, mag / (p.thresh * 2)), rgba);
    });
    // look: the source dimmed, flow as hue (direction) and brightness (speed)
    dimSource(rgba, 0.28);
    for(let i = 0; i < N; i++){
      const mag = Math.hypot(fU[i], fV[i]); if(mag < 0.05) continue;
      hsv(Math.atan2(fV[i], fU[i]) / (Math.PI * 2), 0.85, Math.min(1, mag / 3), rgb);
      const j = i * 4, k = Math.min(1, mag / 1.5);
      vis[j] = vis[j] * (1 - k) + rgb[0] * 255 * k; vis[j + 1] = vis[j + 1] * (1 - k) + rgb[1] * 255 * k; vis[j + 2] = vis[j + 2] * (1 - k) + rgb[2] * 255 * k;
    }
    st.stats.n = take.length; st.stats.activity = act / (FW * FH);
    return { points:pf, field:f, mask:m };
  }

  function doEdges(rgba, aspect, dt, p){
    const g = boxBlur(gray, soft, W, H, Math.round(p.blur), tmp);   // soft doubles as the blurred copy
    const mag = cornerness;                                                               // reused as magnitude buffer
    for(let y = 1; y < H - 1; y++) for(let x = 1; x < W - 1; x++){
      const i = y * W + x;
      const gx = (g[i - W + 1] + 2 * g[i + 1] + g[i + W + 1]) - (g[i - W - 1] + 2 * g[i - 1] + g[i + W - 1]);
      const gy = (g[i + W - 1] + 2 * g[i + W] + g[i + W + 1]) - (g[i - W - 1] + 2 * g[i - W] + g[i - W + 1]);
      ix0[i] = gx; iy0[i] = gy; mag[i] = Math.hypot(gx, gy);
    }
    const SCALE = 400, thr = p.thresh * SCALE, cand = [], m = maskOut(), md = m.data;
    md.fill(0); fg.fill(0);
    for(let y = 2; y < H - 2; y++) for(let x = 2; x < W - 2; x++){
      const i = y * W + x, s = mag[i]; if(s < thr) continue;
      const gx = ix0[i], gy = iy0[i];
      // thin: keep the ridge along the gradient
      const ax = Math.abs(gx), ay = Math.abs(gy);
      let a, b;
      if(ay < ax * 0.4142){ a = mag[i - 1]; b = mag[i + 1]; }
      else if(ay > ax * 2.4142){ a = mag[i - W]; b = mag[i + W]; }
      else if(gx * gy > 0){ a = mag[i - W - 1]; b = mag[i + W + 1]; }
      else { a = mag[i - W + 1]; b = mag[i + W - 1]; }
      if(s >= a && s >= b){ cand.push(i); fg[i] = 255; }
    }
    // mask: the ridges, one pixel fat
    for(let y = 1; y < H - 1; y++) for(let x = 1; x < W - 1; x++){
      const i = y * W + x;
      if(fg[i] || fg[i - 1] || fg[i + 1] || fg[i - W] || fg[i + W]) md[i] = 255;
    }
    const take = pick(cand, p.points), pf = ensurePts(take.length, aspect);
    take.forEach((i, k) => {
      const gx = ix0[i], gy = iy0[i], l = Math.hypot(gx, gy) || 1;
      setPt(pf, k, i % W, (i / W) | 0, -gy / l, gx / l, 1 + Math.min(2.5, mag[i] / 300), 1, rgba);
    });
    // field: how structure is oriented, over blocks (structure tensor, smoothed)
    for(let i = 0; i < N; i++){ const gx = ix0[i] / 255, gy = iy0[i] / 255; jxx[i] = gx * gx; jxy[i] = gx * gy; jyy[i] = gy * gy; }
    boxBlur(jxx, jxx, W, H, 4, tmp); boxBlur(jxy, jxy, W, H, 4, tmp); boxBlur(jyy, jyy, W, H, 4, tmp);
    const f = fieldOut();
    for(let fy = 0; fy < FH; fy++) for(let fx = 0; fx < FW; fx++){
      const i = (fy * 4 + 2) * W + fx * 4 + 2, a = jxx[i], b = jxy[i], c = jyy[i], tr = a + c;
      const th = 0.5 * Math.atan2(2 * b, a - c);                 // dominant gradient direction
      let tx = -Math.sin(th), ty = Math.cos(th);                 // the edge runs across it
      if(tx < 0 || (tx === 0 && ty < 0)){ tx = -tx; ty = -ty; }
      const coh = tr > 1e-6 ? Math.hypot(a - c, 2 * b) / tr : 0, str = Math.min(1, Math.sqrt(tr) * 1.6);
      const o = (fy * FW + fx) * 2, k = coh * str * p.gain;
      f.data[o] = tx * k; f.data[o + 1] = ty * k;
    }
    // look: edges glow, hue = which way they run
    for(let i = 0, j = 0; i < N; i++, j += 4){
      const s = Math.min(1, mag[i] / SCALE);
      if(md[i] || s > p.thresh * 0.6){
        hsv(Math.atan2(ix0[i], -iy0[i]) / (Math.PI * 2) * 0.5 + 0.55, 0.55, md[i] ? Math.max(0.55, s) : s * 0.6, rgb);
        vis[j] = rgb[0] * 255; vis[j + 1] = rgb[1] * 255; vis[j + 2] = rgb[2] * 255;
      } else { const k = gray[i] * 0.08; vis[j] = k; vis[j + 1] = k; vis[j + 2] = k; }
      vis[j + 3] = 255;
    }
    st.stats.n = take.length; st.stats.activity = cand.length / N;
    return { points:pf, field:f, mask:m };
  }

  function dilate(src, dst){
    for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){
      const i = y * W + x;
      dst[i] = (src[i] || (x > 0 && src[i - 1]) || (x < W - 1 && src[i + 1]) || (y > 0 && src[i - W]) || (y < H - 1 && src[i + W])) ? 255 : 0;
    }
  }
  function erode(src, dst){
    for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){
      const i = y * W + x;
      dst[i] = (src[i] && (x === 0 || src[i - 1]) && (x === W - 1 || src[i + 1]) && (y === 0 || src[i - W]) && (y === H - 1 || src[i + W])) ? 255 : 0;
    }
  }
  function doBgsub(rgba, aspect, dt, p){
    if(st.bgFrames === 0) bg.set(gray);
    const warm = st.bgFrames < 12;
    boxBlur(gray, soft, W, H, 1, tmp);
    const thr = p.thresh * 255;
    for(let i = 0; i < N; i++) fg[i] = Math.abs(soft[i] - bg[i]) > thr ? 255 : 0;
    // open (erode → dilate) to lose speckle, then close the gaps a little
    erode(fg, fg2); dilate(fg2, fg); dilate(fg, fg2); erode(fg2, fg);
    // selective update: learn the background where nothing stands
    const slow = p.learn * 0.04;
    for(let i = 0; i < N; i++){
      const r = warm ? 0.25 : (fg[i] ? slow : p.learn);
      bg[i] += (soft[i] - bg[i]) * r;
    }
    st.bgFrames++;
    const m = maskOut(), md = m.data;
    for(let i = 0; i < N; i++) soft[i] = warm ? 0 : fg[i];
    boxBlur(soft, soft, W, H, 1, tmp);
    for(let i = 0; i < N; i++) md[i] = soft[i];
    // points: one per 8×8 cell that is mostly silhouette
    const cand = [], cs = 8;
    for(let cy = 0; cy < Math.floor(H / cs); cy++) for(let cx = 0; cx < Math.floor(W / cs); cx++){
      let n = 0, sx = 0, sy = 0;
      for(let y = 0; y < cs; y++) for(let x = 0; x < cs; x++) if(md[(cy * cs + y) * W + cx * cs + x] > 127){ n++; sx += cx * cs + x; sy += cy * cs + y; }
      if(n > cs * cs * 0.5) cand.push(sx / n, sy / n);
    }
    const idx = []; for(let i = 0; i < cand.length; i += 2) idx.push(i);
    const take = pick(idx, p.points), pf = ensurePts(take.length, aspect);
    take.forEach((ci, k) => setPt(pf, k, cand[ci], cand[ci + 1], 0, 0, 2, 1, rgba));
    // field: pointing out of the silhouette (obstacle-like), 0 elsewhere
    boxBlur(soft, jxx, W, H, 3, tmp);
    const f = fieldOut();
    for(let fy = 0; fy < FH; fy++) for(let fx = 0; fx < FW; fx++){
      const x = fx * 4 + 2, y = fy * 4 + 2, i = y * W + x;
      const gx = (jxx[i + 2] - jxx[i - 2]) / 510, gy = (jxx[i + 2 * W] - jxx[i - 2 * W]) / 510;
      const o = (fy * FW + fx) * 2; f.data[o] = -gx * 2 * p.gain; f.data[o + 1] = -gy * 2 * p.gain;
    }
    // look: the cut-out in colour, a ghost of the model elsewhere
    let cov = 0;
    for(let i = 0, j = 0; i < N; i++, j += 4){
      const k = md[i] / 255; cov += k > 0.5 ? 1 : 0;
      const gh = bg[i] * 0.12;
      vis[j] = gh * (1 - k) + rgba[j] * k; vis[j + 1] = gh * (1 - k) + rgba[j + 1] * k; vis[j + 2] = gh * (1 - k) + rgba[j + 2] * k; vis[j + 3] = 255;
    }
    st.stats.n = take.length; st.stats.activity = cov / N;
    return { points:pf, field:f, mask:m };
  }

  function detectCorners(p){
    // Shi–Tomasi: smaller eigenvalue of the structure tensor
    boxBlur(gray, soft, W, H, 1, tmp);
    for(let y = 1; y < H - 1; y++) for(let x = 1; x < W - 1; x++){
      const i = y * W + x, gx = (soft[i + 1] - soft[i - 1]) * 0.5, gy = (soft[i + W] - soft[i - W]) * 0.5;
      jxx[i] = gx * gx; jxy[i] = gx * gy; jyy[i] = gy * gy;
    }
    boxBlur(jxx, jxx, W, H, 2, tmp); boxBlur(jxy, jxy, W, H, 2, tmp); boxBlur(jyy, jyy, W, H, 2, tmp);
    let mx = 0;
    for(let i = 0; i < N; i++){
      const a = jxx[i], b = jxy[i], c = jyy[i];
      const l = ((a + c) - Math.sqrt((a - c) * (a - c) + 4 * b * b)) * 0.5;
      cornerness[i] = l; if(l > mx) mx = l;
    }
    if(mx <= 0) return [];
    const thr = mx * p.quality, list = [];
    for(let y = 5; y < H - 5; y++) for(let x = 5; x < W - 5; x++){
      const i = y * W + x, v = cornerness[i];
      if(v > thr && v >= cornerness[i - 1] && v >= cornerness[i + 1] && v >= cornerness[i - W] && v >= cornerness[i + W]) list.push(i);
    }
    list.sort((a, b) => cornerness[b] - cornerness[a]);
    return list;
  }
  function doTracks(rgba, aspect, dt, p){
    const T = st.tracks, want = Math.round(p.points);
    // follow what we have
    if(st.havePrev){
      for(let k = T.length - 1; k >= 0; k--){
        const t = T[k];
        if(!trackPoint(prevPyr, curPyr, t.x, t.y) || ++t.age > p.maxage){ T.splice(k, 1); continue; }
        const vx = lk.x - t.x, vy = lk.y - t.y;
        t.vx = t.vx * 0.5 + vx * 0.5; t.vy = t.vy * 0.5 + vy * 0.5;
        t.x = lk.x; t.y = lk.y;
        t.hist.push(t.x, t.y); if(t.hist.length > 20) t.hist.splice(0, 2);
      }
    }
    // top up with new corners, away from the ones already held
    if(T.length > want) T.length = want;
    if(T.length < want && (st.frames % 2 === 0 || T.length < want * 0.5)){
      const list = detectCorners(p), cell = Math.max(3, Math.round(p.mindist));
      const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell), occ = new Uint8Array(gw * gh);
      const mark = (x, y) => { const cx = (x / cell) | 0, cy = (y / cell) | 0;
        for(let j = -1; j <= 1; j++) for(let i = -1; i <= 1; i++){ const X = cx + i, Y = cy + j; if(X >= 0 && Y >= 0 && X < gw && Y < gh) occ[Y * gw + X] = 1; } };
      T.forEach(t => mark(t.x, t.y));
      for(let n = 0; n < list.length && T.length < want; n++){
        const i = list[n], x = i % W, y = (i / W) | 0;
        if(occ[((y / cell) | 0) * gw + ((x / cell) | 0)]) continue;
        mark(x, y);
        T.push({ id:st.nextId++, x, y, vx:0, vy:0, age:0, hist:[x, y] });
      }
    }
    const pf = ensurePts(T.length, aspect);
    T.forEach((t, k) => {
      const sp = Math.hypot(t.vx, t.vy);
      const pres = Math.min(1, t.age / 6 + 0.15) * Math.min(1, (p.maxage - t.age) / 20);
      setPt(pf, k, t.x, t.y, sp > 0.05 ? t.vx / sp : 0, sp > 0.05 ? t.vy / sp : 0, 1 + Math.min(3, sp * 0.8), pres, rgba);
    });
    // field: velocities splatted smooth, falling to zero away from any track
    const f = fieldOut(), unit = p.gain / Math.max(1e-3, dt);
    f.data.fill(0);
    const wsum = new Float32Array(FW * FH);
    T.forEach(t => {
      const cx = t.x / 4, cy = t.y / 4;
      for(let dy = -3; dy <= 3; dy++) for(let dx = -3; dx <= 3; dx++){
        const X = Math.floor(cx) + dx, Y = Math.floor(cy) + dy; if(X < 0 || Y < 0 || X >= FW || Y >= FH) continue;
        const d2 = (X + 0.5 - cx) * (X + 0.5 - cx) + (Y + 0.5 - cy) * (Y + 0.5 - cy), w = Math.exp(-d2 / 3.5);
        const o = Y * FW + X; wsum[o] += w; f.data[o * 2] += w * t.vx; f.data[o * 2 + 1] += w * t.vy;
      }
    });
    for(let o = 0; o < FW * FH; o++){
      const k = 1 / (wsum[o] + 0.35);
      f.data[o * 2] = f.data[o * 2] * k / W * unit; f.data[o * 2 + 1] = f.data[o * 2 + 1] * k / H * unit;
    }
    // look: trails and heads over a dim picture
    dimSource(rgba, 0.3);
    T.forEach(t => {
      const sp = Math.hypot(t.vx, t.vy);
      hsv(0.08 + Math.min(1, sp / 4) * 0.5, 0.7, 1, rgb);
      const R = rgb[0] * 255, G = rgb[1] * 255, B = rgb[2] * 255, h = t.hist;
      for(let i = 2; i < h.length; i += 2) line(h[i - 2], h[i - 1], h[i], h[i + 1], R, G, B, 0.15 + 0.7 * i / h.length);
      plot(t.x, t.y, 255, 255, 255, 1); plot(t.x + 1, t.y, 255, 255, 255, 0.6); plot(t.x, t.y + 1, 255, 255, 255, 0.6);
    });
    st.stats.n = T.length; st.stats.activity = T.length ? T.reduce((a, t) => a + Math.hypot(t.vx, t.vy), 0) / T.length : 0;
    return { points:pf, field:f, mask:null };
  }

  /* ---------------- one step ---------------- */
  function step(rgba, aspect, now, mode, P){
    if(MODES.indexOf(mode) < 0) mode = "flow";
    if(st.mode !== mode){ reset(); st.mode = mode; st.points = null; }
    const p = resolve(mode, P);
    let dt = st.lastT == null ? 1 / 30 : now - st.lastT;
    if(!(dt > 1e-4)) dt = 1 / 30;
    if(dt > 0.5) { st.havePrev = false; dt = 1 / 30; }         // a long pause breaks continuity
    st.lastT = now;
    toGray(rgba, gray);
    fillPyr(curPyr, gray, tmp);
    let r;
    switch(mode){
      case "edges":  r = doEdges(rgba, aspect, dt, p); break;
      case "bgsub":  r = doBgsub(rgba, aspect, dt, p); break;
      case "tracks": r = doTracks(rgba, aspect, dt, p); break;
      default:       r = doFlow(rgba, aspect, dt, p);
    }
    if(r.points) PT.bump(r.points);
    if(r.field) PT.bump(r.field);
    if(r.mask) PT.bump(r.mask);
    prevGray.set(gray);
    const t = curPyr; curPyr = prevPyr; prevPyr = t;
    st.havePrev = true; st.frames++;
    return { points:r.points || null, field:r.field || null, mask:r.mask || null, vis, w:W, h:H, stats:st.stats, dt };
  }

  return { step, reset, get mode(){ return st.mode; } };
}

return { create, MODES, PARAMS, resolve, W, H, FW, FH, VERSION:"1.0" };
})();

if(typeof globalThis !== "undefined") globalThis.UnlimiterVision = UnlimiterVision;
if(typeof module !== "undefined" && module.exports) module.exports = UnlimiterVision;
