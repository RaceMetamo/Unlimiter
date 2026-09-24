/* ============================================================
   unlimiter-points.js — The Unlimiter point generator (schemaVersion 1)

   A framework-free geometry core. No DOM, no WebGL, no three.js —
   it answers one question and nothing else:

       given an address and a moment in time, where is this point,
       what colour is it, how big is it, and is it there at all?

   Everything in the suite that wants procedural geometry reads that
   answer: manifold.html draws it, the volume renderer ingests it as
   a point cloud, anchor.html seeds stamps from it, the rack patches
   it, and unlimiter-drive.js modulates the numbers that produce it.

   The shape of the thing:

       surface      (u,v,shell) -> xyz        what form the points live on
       distribution index       -> (u,v)      where on that form they land
       modifiers    xyz         -> xyz        what happens to them after
       presence/colour/size                   how they read

   Cross those and the earlier sketches fall out as presets rather
   than as separate programs — see PRESETS at the bottom.

   Load before any tool script. Browser global + CommonJS export,
   same pattern as unlimiter-bus.js.
   ============================================================ */
const UnlimiterPoints = (() => {
"use strict";

const SCHEMA_VERSION = 1;
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/* ============================================================
   1 · primitives
   A 4D value noise rather than a classic Perlin: the fourth axis
   is time, so a field can evolve without the whole pattern
   sliding in some direction, and it is short enough to be
   obviously correct.
   ============================================================ */
function hash4(i, j, k, l){
  let n = i * 374761393 + j * 668265263 + k * 2147483647 + l * 1274126177;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return ((n >>> 0) % 1000000) / 1000000;
}
function fade(t){ return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t){ return a + (b - a) * t; }
function clamp(x, a, b){ return x < a ? a : (x > b ? b : x); }
function smoothstep(e0, e1, x){
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}
function smoothBand(v, lo, hi, edge){
  const a = smoothstep(lo, lo + edge, v);
  const b = 1 - smoothstep(hi - edge, hi, v);
  return Math.max(0, Math.min(a, b));
}
function noise4D(x, y, z, w){
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), iw = Math.floor(w);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz), fw = fade(w - iw);
  let c = new Array(16);
  for(let idx = 0; idx < 16; idx++){
    c[idx] = hash4(ix + (idx & 1), iy + ((idx >> 1) & 1), iz + ((idx >> 2) & 1), iw + ((idx >> 3) & 1));
  }
  for(let bit = 0; bit < 4; bit++){
    const t = bit === 0 ? fx : (bit === 1 ? fy : (bit === 2 ? fz : fw));
    const next = new Array(c.length / 2);
    for(let p = 0; p < next.length; p++) next[p] = lerp(c[p * 2], c[p * 2 + 1], t);
    c = next;
  }
  return c[0];
}
function noise3D(x, y, z){ return noise4D(x, y, z, 0); }

/** h 0..360, s/v 0..1 -> [r,g,b] 0..1 */
function hsb2rgb(h, s, v, out){
  out = out || [0, 0, 0];
  h = ((h % 360) + 360) % 360;
  const c = v * s, hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if(hp < 1){ r = c; g = x; }
  else if(hp < 2){ r = x; g = c; }
  else if(hp < 3){ g = c; b = x; }
  else if(hp < 4){ g = x; b = c; }
  else if(hp < 5){ r = x; b = c; }
  else { r = c; b = x; }
  const m = v - c;
  out[0] = r + m; out[1] = g + m; out[2] = b + m;
  return out;
}

/** The Gielis superformula. Six numbers, an enormous family of outlines. */
function superRadius(angle, m, n1, n2, n3, a, b){
  const t = m * angle / 4;
  const p1 = Math.pow(Math.abs(Math.cos(t) / (a || 1)), n2);
  const p2 = Math.pow(Math.abs(Math.sin(t) / (b || 1)), n3);
  const s = p1 + p2;
  if(!(s > 1e-9)) return 0;
  const r = Math.pow(s, -1 / (n1 || 1e-6));
  return isFinite(r) ? Math.min(r, 8) : 0;
}

/* ============================================================
   2 · surfaces — (u, v, shell) -> xyz

   u runs 0..1 the long way round and wraps; v runs 0..1 across
   and clamps; shell is 0..1 across the nested copies, so the
   nested-shell reading survives on every form rather than only on
   a sphere.

   `params` is the single source of truth for a surface's numbers:
   a tool builds its sliders from it and registers its modulation
   targets from the same list, so there is no parameter list to
   maintain in two places.
   ============================================================ */
const SURFACES = {
  sphere: {
    label: "Sphere",
    params: [
      { key: "radius",     label: "Radius",       min: 20, max: 400, step: 1,   def: 190 },
      { key: "shellGap",   label: "Shell depth",  min: 0,  max: 200, step: 1,   def: 60 },
      { key: "vStart",     label: "Latitude from",min: 0,  max: 180, step: 1,   def: 0 },
      { key: "vEnd",       label: "Latitude to",  min: 0,  max: 180, step: 1,   def: 180 }
    ],
    map(u, v, sh, P, out){
      const theta = (P.vStart + v * (P.vEnd - P.vStart)) * DEG;
      const phi = u * TAU;
      const r = P.radius - sh * P.shellGap;
      const st = Math.sin(theta);
      out[0] = r * st * Math.cos(phi);
      out[1] = r * Math.cos(theta);
      out[2] = r * st * Math.sin(phi);
      return out;
    }
  },

  disc: {
    label: "Disc / plane",
    params: [
      { key: "radius",     label: "Outer radius", min: 20, max: 400, step: 1, def: 200 },
      { key: "innerRadius",label: "Inner radius", min: 0,  max: 300, step: 1, def: 40 },
      { key: "shellGap",   label: "Stack spacing",min: 0,  max: 300, step: 1, def: 70 }
    ],
    map(u, v, sh, P, out){
      const r = lerp(P.innerRadius, P.radius, v);
      const phi = u * TAU;
      out[0] = r * Math.cos(phi);
      out[1] = (sh - 0.5) * P.shellGap;
      out[2] = r * Math.sin(phi);
      return out;
    }
  },

  torus: {
    label: "Torus",
    params: [
      { key: "radius",   label: "Ring radius",  min: 40, max: 360, step: 1, def: 170 },
      { key: "tube",     label: "Tube radius",  min: 5,  max: 200, step: 1, def: 62 },
      { key: "shellGap", label: "Shell depth",  min: 0,  max: 120, step: 1, def: 26 },
      { key: "twistTurns", label: "Tube twist", min: 0,  max: 8,   step: 0.25, def: 0 }
    ],
    map(u, v, sh, P, out){
      const a = u * TAU;
      const b = v * TAU + a * P.twistTurns;
      const tube = P.tube - sh * P.shellGap;
      const rr = P.radius + tube * Math.cos(b);
      out[0] = rr * Math.cos(a);
      out[1] = tube * Math.sin(b);
      out[2] = rr * Math.sin(a);
      return out;
    }
  },

  cylinder: {
    label: "Cylinder",
    params: [
      { key: "radius",   label: "Radius",      min: 10, max: 360, step: 1, def: 140 },
      { key: "height",   label: "Height",      min: 10, max: 600, step: 1, def: 300 },
      { key: "taper",    label: "Taper",       min: -1, max: 1,   step: 0.01, def: 0 },
      { key: "shellGap", label: "Shell depth", min: 0,  max: 200, step: 1, def: 40 }
    ],
    map(u, v, sh, P, out){
      const r = (P.radius - sh * P.shellGap) * (1 + P.taper * (v - 0.5) * 2);
      const phi = u * TAU;
      out[0] = r * Math.cos(phi);
      out[1] = (v - 0.5) * P.height;
      out[2] = r * Math.sin(phi);
      return out;
    }
  },

  supershape: {
    label: "Supershape",
    params: [
      { key: "radius",   label: "Radius",       min: 20, max: 400, step: 1,   def: 180 },
      { key: "shellGap", label: "Shell depth",  min: 0,  max: 200, step: 1,   def: 46 },
      { key: "m1",       label: "Lon · sides",  min: 0,  max: 20,  step: 0.1, def: 7 },
      { key: "n11",      label: "Lon · n1",     min: 0.1,max: 8,   step: 0.05,def: 0.4 },
      { key: "n12",      label: "Lon · n2",     min: 0.1,max: 8,   step: 0.05,def: 1.7 },
      { key: "n13",      label: "Lon · n3",     min: 0.1,max: 8,   step: 0.05,def: 1.7 },
      { key: "m2",       label: "Lat · sides",  min: 0,  max: 20,  step: 0.1, def: 3 },
      { key: "n21",      label: "Lat · n1",     min: 0.1,max: 8,   step: 0.05,def: 0.6 },
      { key: "n22",      label: "Lat · n2",     min: 0.1,max: 8,   step: 0.05,def: 1.2 },
      { key: "n23",      label: "Lat · n3",     min: 0.1,max: 8,   step: 0.05,def: 1.2 }
    ],
    map(u, v, sh, P, out){
      const lon = (u - 0.5) * TAU;              // -pi .. pi
      const lat = (v - 0.5) * Math.PI;          // -pi/2 .. pi/2
      const r1 = superRadius(lon, P.m1, P.n11, P.n12, P.n13, 1, 1);
      const r2 = superRadius(lat, P.m2, P.n21, P.n22, P.n23, 1, 1);
      const R = P.radius - sh * P.shellGap;
      const cl = Math.cos(lat), sl = Math.sin(lat);
      out[0] = R * r1 * Math.cos(lon) * r2 * cl;
      out[1] = R * r2 * sl;
      out[2] = R * r1 * Math.sin(lon) * r2 * cl;
      return out;
    }
  },

  saddle: {
    label: "Saddle",
    params: [
      { key: "extent",   label: "Extent",      min: 40, max: 400, step: 1,   def: 210 },
      { key: "curve",    label: "Curvature",   min: -3, max: 3,   step: 0.01,def: 1.1 },
      { key: "shellGap", label: "Stack spacing",min: 0, max: 300, step: 1,   def: 60 }
    ],
    map(u, v, sh, P, out){
      const x = (u - 0.5) * 2, z = (v - 0.5) * 2;
      out[0] = x * P.extent;
      out[1] = (x * x - z * z) * P.curve * P.extent * 0.5 + (sh - 0.5) * P.shellGap;
      out[2] = z * P.extent;
      return out;
    }
  },

  mobius: {
    label: "Möbius band",
    params: [
      { key: "radius",   label: "Radius",      min: 40, max: 360, step: 1, def: 170 },
      { key: "width",    label: "Band width",  min: 10, max: 260, step: 1, def: 90 },
      { key: "halfTwists",label: "Half twists",min: 1,  max: 9,   step: 1, def: 1 },
      { key: "shellGap", label: "Shell depth", min: 0,  max: 120, step: 1, def: 20 }
    ],
    map(u, v, sh, P, out){
      const a = u * TAU;
      const w = (v - 0.5) * (P.width - sh * P.shellGap);
      const h = a * P.halfTwists / 2;
      const rr = P.radius + w * Math.cos(h);
      out[0] = rr * Math.cos(a);
      out[1] = w * Math.sin(h);
      out[2] = rr * Math.sin(a);
      return out;
    }
  }
};

/* Surface normal by finite difference — general, so a new surface
   needs no hand-derived normal to work with the modifier stack. */
const _n0 = [0, 0, 0], _nu = [0, 0, 0], _nv = [0, 0, 0];
function surfaceNormal(surf, u, v, sh, P, out){
  const e = 0.004;
  surf.map(u, v, sh, P, _n0);
  surf.map((u + e) % 1, v, sh, P, _nu);
  surf.map(u, clamp(v + e, 0, 1), sh, P, _nv);
  const ax = _nu[0] - _n0[0], ay = _nu[1] - _n0[1], az = _nu[2] - _n0[2];
  const bx = _nv[0] - _n0[0], by = _nv[1] - _n0[1], bz = _nv[2] - _n0[2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  let len = Math.hypot(nx, ny, nz);
  if(len < 1e-7){                                  // degenerate (a pole, a seam)
    nx = _n0[0]; ny = _n0[1]; nz = _n0[2];         // fall back to radial
    len = Math.hypot(nx, ny, nz) || 1;
  }
  out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
  return out;
}

/* ============================================================
   3 · distributions — index -> (u, v)

   Kept deliberately separate from the surface: every distribution
   works on every surface, which is where most of the range comes
   from. `flock` is the one with memory; it reads (u,v) off agents
   that a caller steps, and its agents live in this same flat
   wrap-around space so no distribution ever has to reason about
   poles or seams.
   ============================================================ */
const DISTRIBUTIONS = {
  grid: {
    label: "Grid",
    params: [],
    place(i, row, col, rows, cols, t, P, st, out){
      out[0] = cols > 0 ? col / cols : 0;
      out[1] = rows > 1 ? row / (rows - 1) : 0.5;
      return out;
    }
  },

  rings: {
    label: "Orbiting rings",
    params: [
      { key: "spin",    label: "Spin speed",   min: -3, max: 3,  step: 0.01, def: 0.6 },
      { key: "spread",  label: "Ring offset",  min: 0,  max: 20, step: 0.1,  def: 2 },
      { key: "wobble",  label: "Wobble",       min: 0,  max: 0.5,step: 0.005,def: 0.06 },
      { key: "wobbleHz",label: "Wobble rate",  min: 0,  max: 3,  step: 0.01, def: 0.5 }
    ],
    place(i, row, col, rows, cols, t, P, st, out){
      const phase = t * P.spin;
      let u = (col / Math.max(1, cols)) + phase + row * P.spread / 360;
      let v = rows > 1 ? row / (rows - 1) : 0.5;
      if(P.wobble > 0){
        const sx = hash4(row, 17, 3, 9) * 1000;
        const sy = hash4(row, 53, 11, 29) * 1000;
        const ph = row * 0.13 + col * 0.03 + t * P.wobbleHz;
        u += (noise4D(sx, ph, 0, 0) * 2 - 1) * P.wobble;
        v += (noise4D(sy, ph, 0, 0) * 2 - 1) * P.wobble * 0.5;
      }
      out[0] = u - Math.floor(u);
      out[1] = clamp(v, 0, 1);
      return out;
    }
  },

  fibonacci: {
    label: "Even scatter",
    params: [
      { key: "drift", label: "Drift", min: 0, max: 2, step: 0.01, def: 0 }
    ],
    place(i, row, col, rows, cols, t, P, st, out){
      const n = Math.max(1, rows * cols);
      const ga = Math.PI * (3 - Math.sqrt(5));
      let u = ((ga * i) / TAU) % 1;
      u += t * P.drift * 0.05;
      out[0] = u - Math.floor(u);
      out[1] = n > 1 ? i / (n - 1) : 0.5;
      return out;
    }
  },

  jitter: {
    label: "Jittered grid",
    params: [
      { key: "amount", label: "Jitter",     min: 0, max: 1, step: 0.01, def: 0.35 },
      { key: "crawl",  label: "Crawl rate", min: 0, max: 2, step: 0.01, def: 0.15 }
    ],
    place(i, row, col, rows, cols, t, P, st, out){
      const su = hash4(row, col, 7, 1) * 997;
      const sv = hash4(row, col, 13, 5) * 997;
      const du = (noise4D(su, t * P.crawl, 0, 0) * 2 - 1) * P.amount / Math.max(1, cols);
      const dv = (noise4D(sv, t * P.crawl, 0, 0) * 2 - 1) * P.amount / Math.max(1, rows);
      let u = (cols > 0 ? col / cols : 0) + du;
      out[0] = u - Math.floor(u);
      out[1] = clamp((rows > 1 ? row / (rows - 1) : 0.5) + dv, 0, 1);
      return out;
    }
  },

  flock: {
    label: "Flock",
    stateful: true,
    params: [
      { key: "neighbourhood", label: "Neighbourhood", min: 0.02, max: 0.4, step: 0.005, def: 0.08 },
      { key: "cohesion",      label: "Cohesion",      min: 0, max: 3, step: 0.01, def: 0.6 },
      { key: "separation",    label: "Separation",    min: 0, max: 4, step: 0.01, def: 1.2 },
      { key: "alignment",     label: "Alignment",     min: 0, max: 3, step: 0.01, def: 0.4 },
      { key: "fieldPull",     label: "Field affinity",min: 0, max: 3, step: 0.01, def: 0.8 },
      { key: "wander",        label: "Wander",        min: 0, max: 0.3, step: 0.005, def: 0.02 },
      { key: "maxSpeed",      label: "Max speed",     min: 0.05, max: 2, step: 0.01, def: 0.5 },
      { key: "responsive",    label: "Responsiveness",min: 0.05, max: 0.9, step: 0.01, def: 0.35 }
    ],
    place(i, row, col, rows, cols, t, P, st, out){
      const a = st && st.agents[i];
      if(!a){ out[0] = 0; out[1] = 0.5; return out; }
      out[0] = a.u; out[1] = a.v;
      return out;
    }
  }
};

/* ---- flock state ----------------------------------------------------
   Agents live in the flat (u wraps, v clamps) space, never in xyz, so
   the simulation has no poles to blow up at and the same flock runs on
   any surface. Only the render step maps them out to 3D.
   -------------------------------------------------------------------- */
function wrapDiff(a, b){ let d = a - b; d -= Math.round(d); return d; }

function createFlock(count, shells){
  const agents = new Array(count);
  const per = Math.max(1, Math.ceil(count / Math.max(1, shells)));
  for(let i = 0; i < count; i++){
    agents[i] = {
      u: hash4(i, 1, 2, 3),
      v: hash4(i, 4, 5, 6),
      vu: (hash4(i, 7, 8, 9) - 0.5) * 0.2,
      vv: (hash4(i, 10, 11, 12) - 0.5) * 0.2,
      shellIdx: Math.min(shells - 1, Math.floor(i / per)),
      wSeedU: hash4(i, 21, 2, 3) * 1000,
      wSeedV: hash4(i, 31, 4, 5) * 1000
    };
  }
  return { agents, shells, count };
}

/**
 * One simulation step. `field(u, v, shellFrac)` is optional and returns
 * 0..1; agents are pulled toward the band [low, high] of it, which is how
 * a flock ends up tracing the same carve another layer is displaying.
 */
function stepFlock(state, dt, t, F, field, band){
  if(!state) return;
  const ags = state.agents, n = ags.length;
  const shells = Math.max(1, state.shells);
  const r2 = F.neighbourhood * F.neighbourhood;
  const lo = band ? band[0] : 0.45, hi = band ? band[1] : 0.55;
  // gradient epsilon scales with the field's own frequency, otherwise a
  // fine field aliases into noise and the agents buzz instead of steer
  const fEps = clamp(0.35 / Math.max(0.5, (band && band[2]) || 3), 0.004, 0.05);
  const alpha = 1 - Math.pow(1 - F.responsive, Math.max(0.0001, dt) * 60);

  for(let i = 0; i < n; i++){
    const a = ags[i];
    let cu = 0, cv = 0, su = 0, sv = 0, au = 0, av = 0, cnt = 0;
    for(let j = 0; j < n; j++){
      if(j === i) continue;
      const b = ags[j];
      if(b.shellIdx !== a.shellIdx) continue;
      const du = wrapDiff(b.u, a.u), dv = b.v - a.v;
      const d2 = du * du + dv * dv;
      if(d2 > r2 || d2 < 1e-12) continue;
      cnt++;
      cu += du; cv += dv;
      const inv = 1 / Math.max(1e-6, d2);
      su -= du * inv * 1e-3; sv -= dv * inv * 1e-3;
      au += b.vu; av += b.vv;
    }
    let fu = 0, fv = 0;
    if(cnt > 0){
      fu += (cu / cnt) * F.cohesion + su * F.separation + (au / cnt - a.vu) * F.alignment;
      fv += (cv / cnt) * F.cohesion + sv * F.separation + (av / cnt - a.vv) * F.alignment;
    }
    // continuous wander: a per-agent seed walked through time, not a
    // fresh random each frame — the difference between drift and vibration
    fu += (noise4D(a.wSeedU, t * 0.6, 0, 0) * 2 - 1) * F.wander;
    fv += (noise4D(a.wSeedV, t * 0.6, 0, 0) * 2 - 1) * F.wander;

    if(field && F.fieldPull > 0){
      const shf = shells > 1 ? a.shellIdx / (shells - 1) : 0;
      const here = field(a.u, a.v, shf);
      const outside = here < lo ? (lo - here) : (here > hi ? (here - hi) : 0);
      if(outside > 0){
        const gu = field((a.u + fEps) % 1, a.v, shf) - here;
        const gv = field(a.u, clamp(a.v + fEps, 0, 1), shf) - here;
        const gm = Math.hypot(gu, gv);
        if(gm > 1e-9){
          // steer by how far outside the band we are, never by how steep
          // the field happens to be — steepness is what made it jitter
          const pull = clamp(outside / 0.15, 0, 1) * F.fieldPull;
          const dir = here < lo ? 1 : -1;
          fu += (gu / gm) * pull * dir;
          fv += (gv / gm) * pull * dir;
        }
      }
    }

    a.vu += (fu - a.vu) * alpha;
    a.vv += (fv - a.vv) * alpha;
    const sp = Math.hypot(a.vu, a.vv);
    if(sp > F.maxSpeed){ a.vu = a.vu / sp * F.maxSpeed; a.vv = a.vv / sp * F.maxSpeed; }
    a.u += a.vu * dt; a.v += a.vv * dt;
    a.u -= Math.floor(a.u);
    if(a.v < 0){ a.v = 0; a.vv = Math.abs(a.vv); }
    if(a.v > 1){ a.v = 1; a.vv = -Math.abs(a.vv); }
  }
}

/* ============================================================
   4 · modifiers — xyz -> xyz, applied in order

   Non-destructive and ordered: the surface is never edited, each
   modifier is a pass over the result, and turning one off returns
   the form exactly.
   ============================================================ */
const MODIFIERS = {
  noise: {
    label: "Noise displace",
    needsNormal: true,
    params: [
      { key: "amount", label: "Amount", min: -300, max: 300, step: 1,    def: 40 },
      { key: "scale",  label: "Scale",  min: 0.1,  max: 12,  step: 0.05, def: 2.2 },
      { key: "speed",  label: "Drift",  min: 0,    max: 3,   step: 0.01, def: 0.3 }
    ],
    apply(p, n, u, v, sh, t, M){
      const k = M.scale / 200;
      const d = (noise4D(p[0] * k, p[1] * k, p[2] * k, t * M.speed) * 2 - 1) * M.amount;
      p[0] += n[0] * d; p[1] += n[1] * d; p[2] += n[2] * d;
    }
  },
  twist: {
    label: "Twist",
    params: [
      { key: "amount", label: "Turns",  min: -4, max: 4, step: 0.01, def: 0.5 },
      { key: "centre", label: "Centre", min: -300, max: 300, step: 1, def: 0 }
    ],
    apply(p, n, u, v, sh, t, M){
      const a = ((p[1] - M.centre) / 300) * M.amount * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      const x = p[0], z = p[2];
      p[0] = x * c - z * s; p[2] = x * s + z * c;
    }
  },
  swirl: {
    label: "Swirl",
    params: [
      { key: "amount", label: "Amount", min: -4, max: 4, step: 0.01, def: 0.6 },
      { key: "falloff",label: "Falloff",min: 20, max: 400, step: 1,  def: 160 }
    ],
    apply(p, n, u, v, sh, t, M){
      const r = Math.hypot(p[0], p[2]);
      const a = Math.exp(-r / Math.max(1, M.falloff)) * M.amount * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      const x = p[0], z = p[2];
      p[0] = x * c - z * s; p[2] = x * s + z * c;
    }
  },
  ripple: {
    label: "Ripple",
    needsNormal: true,
    params: [
      { key: "amount", label: "Amount", min: -200, max: 200, step: 1,   def: 30 },
      { key: "cycles", label: "Cycles", min: 0.25, max: 24,  step: 0.25,def: 5 },
      { key: "speed",  label: "Speed",  min: -4,   max: 4,   step: 0.01,def: 1 }
    ],
    apply(p, n, u, v, sh, t, M){
      const r = Math.hypot(p[0], p[1], p[2]) / 200;
      const d = Math.sin(r * M.cycles - t * M.speed * TAU * 0.25) * M.amount;
      p[0] += n[0] * d; p[1] += n[1] * d; p[2] += n[2] * d;
    }
  },
  inflate: {
    label: "Inflate",
    needsNormal: true,
    params: [
      { key: "amount", label: "Amount", min: -300, max: 300, step: 1, def: 30 },
      { key: "byShell",label: "By shell", min: -1, max: 1, step: 0.01, def: 0 }
    ],
    apply(p, n, u, v, sh, t, M){
      const d = M.amount * (1 + M.byShell * (sh * 2 - 1));
      p[0] += n[0] * d; p[1] += n[1] * d; p[2] += n[2] * d;
    }
  },
  axis: {
    label: "Axis pull",
    params: [
      { key: "amount", label: "Amount", min: -1, max: 1, step: 0.01, def: 0.3 },
      { key: "stretch",label: "Stretch",min: -1, max: 2, step: 0.01, def: 0 }
    ],
    apply(p, n, u, v, sh, t, M){
      p[0] *= (1 - M.amount); p[2] *= (1 - M.amount);
      p[1] *= (1 + M.stretch);
    }
  }
};

/* ============================================================
   5 · presence, colour, size
   ============================================================ */
const PRESENCE = {
  all:   { label: "All points", params: [] },
  field: {
    label: "Noise carve",
    params: [
      { key: "scale", label: "Field scale", min: 0.2, max: 10, step: 0.05, def: 3 },
      { key: "low",   label: "Band low",    min: 0, max: 1, step: 0.01, def: 0.45 },
      { key: "high",  label: "Band high",   min: 0, max: 1, step: 0.01, def: 0.58 },
      { key: "evolve",label: "Evolve",      min: 0, max: 3, step: 0.01, def: 0.35 }
    ]
  },
  band: {
    label: "Across fade",
    params: [
      { key: "low",  label: "From", min: 0, max: 1, step: 0.01, def: 0.1 },
      { key: "high", label: "To",   min: 0, max: 1, step: 0.01, def: 0.9 },
      { key: "edge", label: "Edge", min: 0.01, max: 0.5, step: 0.01, def: 0.12 }
    ]
  }
};

/** The carve field, sampled in surface space so any consumer — a
 *  presence test, a flock's affinity — reads the identical value. */
function carveField(pos, sh, C, t){
  const k = C.scale / 200;
  return noise4D(pos[0] * k, pos[1] * k, pos[2] * k, t * C.evolve + sh * 0.7);
}

const COLOURS = {
  spectrum: { label: "Spectrum",   params: [
    { key: "hue",   label: "Hue",   min: 0, max: 360, step: 1, def: 200 },
    { key: "range", label: "Spread",min: -360, max: 360, step: 1, def: 200 },
    { key: "sat",   label: "Saturation", min: 0, max: 1, step: 0.01, def: 0.7 }
  ]},
  mono:     { label: "Monochrome", params: [
    { key: "hue",   label: "Hue",   min: 0, max: 360, step: 1, def: 205 },
    { key: "sat",   label: "Saturation", min: 0, max: 1, step: 0.01, def: 0.5 },
    { key: "floor", label: "Darkest", min: 0, max: 1, step: 0.01, def: 0.25 }
  ]},
  height:   { label: "By height",  params: [
    { key: "hue",   label: "Hue",   min: 0, max: 360, step: 1, def: 30 },
    { key: "range", label: "Spread",min: -360, max: 360, step: 1, def: 180 },
    { key: "sat",   label: "Saturation", min: 0, max: 1, step: 0.01, def: 0.75 }
  ]},
  fieldcol: { label: "By field",   params: [
    { key: "hue",   label: "Hue",   min: 0, max: 360, step: 1, def: 300 },
    { key: "range", label: "Spread",min: -360, max: 360, step: 1, def: 220 },
    { key: "sat",   label: "Saturation", min: 0, max: 1, step: 0.01, def: 0.8 }
  ]}
};

/* ============================================================
   6 · frames — the interchange format

   Parallel Float32Arrays, because that is what a GL buffer, the
   volume renderer and a worker transfer all want. Reuse one frame
   across calls; generate() only reallocates when the count changes.
   ============================================================ */
function makeFrame(count){
  return {
    count: count,
    capacity: count,
    positions: new Float32Array(count * 3),
    colors: new Float32Array(count * 3),
    sizes: new Float32Array(count),
    presence: new Float32Array(count)
  };
}
function ensureFrame(frame, count){
  if(!frame || frame.capacity < count) return makeFrame(count);
  frame.count = count;
  return frame;
}

/** Fill a spec's missing numbers from the metadata defaults. */
function defaultsFor(list){
  const o = {};
  (list || []).forEach(p => { o[p.key] = p.def; });
  return o;
}
function withDefaults(kind, id, given){
  const table = kind === "surface" ? SURFACES : kind === "distribution" ? DISTRIBUTIONS
              : kind === "modifier" ? MODIFIERS : kind === "presence" ? PRESENCE : COLOURS;
  const entry = table[id];
  return Object.assign(defaultsFor(entry && entry.params), given || {});
}

/**
 * spec = {
 *   surface:'sphere', surfaceParams:{}, shells:1,
 *   distribution:'grid', distParams:{}, rows:40, cols:40,
 *   modifiers:[{type:'noise', params:{}}],
 *   presence:'field', presenceParams:{},
 *   colour:'spectrum', colourParams:{},
 *   sizeMin:2, sizeMax:8
 * }
 */
const _pos = [0, 0, 0], _nrm = [0, 0, 0], _uv = [0, 0], _rgb = [0, 0, 0];

function generate(spec, t, frame, state){
  const surf = SURFACES[spec.surface] || SURFACES.sphere;
  const dist = DISTRIBUTIONS[spec.distribution] || DISTRIBUTIONS.grid;
  const rows = Math.max(1, spec.rows | 0), cols = Math.max(1, spec.cols | 0);
  const n = rows * cols;
  const shells = Math.max(1, spec.shells | 0);
  frame = ensureFrame(frame, n);

  const SP = withDefaults("surface", spec.surface, spec.surfaceParams);
  const DP = withDefaults("distribution", spec.distribution, spec.distParams);
  const mods = (spec.modifiers || []).filter(m => m && m.type && MODIFIERS[m.type] && m.on !== false)
    .map(m => ({ def: MODIFIERS[m.type], P: withDefaults("modifier", m.type, m.params) }));
  const needN = mods.some(m => m.def.needsNormal);
  const prId = PRESENCE[spec.presence] ? spec.presence : "all";
  const PR = withDefaults("presence", prId, spec.presenceParams);
  const coId = COLOURS[spec.colour] ? spec.colour : "spectrum";
  const CO = withDefaults("colour", coId, spec.colourParams);
  const sizeMin = spec.sizeMin == null ? 2 : spec.sizeMin;
  const sizeMax = spec.sizeMax == null ? 8 : spec.sizeMax;

  const pos = frame.positions, col = frame.colors, siz = frame.sizes, pre = frame.presence;
  const perShell = Math.max(1, Math.ceil(n / shells));

  for(let i = 0; i < n; i++){
    const row = (i / cols) | 0, c = i % cols;
    const shellIdx = dist.stateful && state && state.agents[i]
      ? state.agents[i].shellIdx
      : Math.min(shells - 1, (i / perShell) | 0);
    const sh = shells > 1 ? shellIdx / (shells - 1) : 0;

    dist.place(i, row, c, rows, cols, t, DP, state, _uv);
    surf.map(_uv[0], _uv[1], sh, SP, _pos);
    if(needN) surfaceNormal(surf, _uv[0], _uv[1], sh, SP, _nrm);
    for(let m = 0; m < mods.length; m++) mods[m].def.apply(_pos, _nrm, _uv[0], _uv[1], sh, t, mods[m].P);

    let fieldVal = 0, presence = 1;
    if(prId === "field"){
      fieldVal = carveField(_pos, sh, PR, t);
      presence = smoothBand(fieldVal, PR.low, PR.high, 0.03);
    } else if(prId === "band"){
      presence = smoothBand(_uv[1], PR.low, PR.high, PR.edge);
    }
    if(coId === "fieldcol" && prId !== "field") fieldVal = carveField(_pos, sh, { scale: 3, evolve: 0.3 }, t);

    let h, s = CO.sat, b = 1;
    if(coId === "spectrum"){ h = CO.hue + sh * CO.range; }
    else if(coId === "mono"){ h = CO.hue; b = lerp(CO.floor, 1, sh); }
    else if(coId === "height"){ h = CO.hue + clamp(_pos[1] / 300 + 0.5, 0, 1) * CO.range; }
    else { h = CO.hue + fieldVal * CO.range; }
    hsb2rgb(h, s, b, _rgb);

    const i3 = i * 3;
    pos[i3] = _pos[0]; pos[i3 + 1] = _pos[1]; pos[i3 + 2] = _pos[2];
    col[i3] = _rgb[0]; col[i3 + 1] = _rgb[1]; col[i3 + 2] = _rgb[2];
    siz[i] = lerp(sizeMin, sizeMax, cols > 1 ? c / (cols - 1) : 0.5);
    pre[i] = presence;
  }
  frame.count = n;
  return frame;
}

/**
 * Blend two specs point for point. Both are evaluated at the same
 * address, so this interpolates the geometry itself rather than
 * cross-fading two pictures — a sphere becomes a torus by travelling,
 * not by dissolving. Requires the same rows/cols on both sides.
 */
function morph(specA, specB, mix, t, frame, stateA, stateB, scratchA, scratchB){
  const a = generate(specA, t, scratchA, stateA);
  const b = generate(specB, t, scratchB, stateB);
  const n = Math.min(a.count, b.count);
  frame = ensureFrame(frame, n);
  const k = smoothstep(0, 1, clamp(mix, 0, 1));
  for(let i = 0; i < n; i++){
    const i3 = i * 3;
    frame.positions[i3]     = lerp(a.positions[i3],     b.positions[i3],     k);
    frame.positions[i3 + 1] = lerp(a.positions[i3 + 1], b.positions[i3 + 1], k);
    frame.positions[i3 + 2] = lerp(a.positions[i3 + 2], b.positions[i3 + 2], k);
    frame.colors[i3]        = lerp(a.colors[i3],        b.colors[i3],        k);
    frame.colors[i3 + 1]    = lerp(a.colors[i3 + 1],    b.colors[i3 + 1],    k);
    frame.colors[i3 + 2]    = lerp(a.colors[i3 + 2],    b.colors[i3 + 2],    k);
    frame.sizes[i]          = lerp(a.sizes[i],          b.sizes[i],          k);
    frame.presence[i]       = lerp(a.presence[i],       b.presence[i],       k);
  }
  frame.count = n;
  return { frame, a, b };
}

/* ============================================================
   7 · handoffs
   ============================================================ */

/** Tight bounds of a frame's live points, for normalising. */
function bounds(frame){
  let mx = -Infinity, my = -Infinity, mz = -Infinity;
  let nx = Infinity, ny = Infinity, nz = Infinity, any = false;
  for(let i = 0; i < frame.count; i++){
    if(frame.presence[i] < 0.01) continue;
    const i3 = i * 3, x = frame.positions[i3], y = frame.positions[i3 + 1], z = frame.positions[i3 + 2];
    if(x < nx) nx = x; if(x > mx) mx = x;
    if(y < ny) ny = y; if(y > my) my = y;
    if(z < nz) nz = z; if(z > mz) mz = z;
    any = true;
  }
  if(!any) return { min: [0, 0, 0], max: [0, 0, 0], radius: 1, centre: [0, 0, 0] };
  const centre = [(nx + mx) / 2, (ny + my) / 2, (nz + mz) / 2];
  const radius = Math.max(1e-6, Math.max(mx - nx, my - ny, mz - nz) / 2);
  return { min: [nx, ny, nz], max: [mx, my, mz], radius, centre };
}

/**
 * Pack a frame into the volume renderer's source layout: 16 floats a
 * point, xyz at 0-2, rgb at 4-6, alpha at 7, centred and scaled into
 * the renderer's roughly unit-sized world. Points below `cutoff`
 * presence are dropped rather than sent as invisible rows.
 * Returns {packed, positions, count}.
 */
function toVolumePacked(frame, opts){
  opts = opts || {};
  const cutoff = opts.cutoff == null ? 0.02 : opts.cutoff;
  const bb = opts.bounds || bounds(frame);
  const s = (opts.scale == null ? 1 : opts.scale) / bb.radius;
  let n = 0;
  for(let i = 0; i < frame.count; i++) if(frame.presence[i] >= cutoff) n++;
  const packed = new Float32Array(n * 16);
  const positions = new Float32Array(n * 3);
  let w = 0;
  for(let i = 0; i < frame.count; i++){
    const a = frame.presence[i];
    if(a < cutoff) continue;
    const i3 = i * 3;
    const x = (frame.positions[i3] - bb.centre[0]) * s;
    const y = (frame.positions[i3 + 1] - bb.centre[1]) * s;
    const z = (frame.positions[i3 + 2] - bb.centre[2]) * s;
    positions[w * 3] = x; positions[w * 3 + 1] = y; positions[w * 3 + 2] = z;
    const o = w * 16;
    packed[o] = x; packed[o + 1] = y; packed[o + 2] = z;
    packed[o + 4] = frame.colors[i3];
    packed[o + 5] = frame.colors[i3 + 1];
    packed[o + 6] = frame.colors[i3 + 2];
    packed[o + 7] = a;
    w++;
  }
  return { packed, positions, count: n };
}

/**
 * Flat list of every number a spec exposes, ready for
 * Drive.registerTargets() or the Control Surface's target list.
 * Keys are prefixed so they stay unique and stay readable in a
 * modulation matrix: `surf.radius`, `mod0.amount`.
 */
function targets(spec){
  const out = [];
  const push = (prefix, group, list) => (list || []).forEach(p => out.push({
    key: prefix + "." + p.key, label: group + " — " + p.label,
    min: p.min, max: p.max, step: p.step, def: p.def
  }));
  const surf = SURFACES[spec.surface];
  const dist = DISTRIBUTIONS[spec.distribution];
  push("surf", surf ? surf.label : "Surface", surf && surf.params);
  push("dist", dist ? dist.label : "Distribution", dist && dist.params);
  (spec.modifiers || []).forEach((m, i) => {
    const def = MODIFIERS[m.type];
    if(def) push("mod" + i, def.label, def.params);
  });
  const pr = PRESENCE[spec.presence], co = COLOURS[spec.colour];
  push("pres", pr ? pr.label : "Presence", pr && pr.params);
  push("col", co ? co.label : "Colour", co && co.params);
  return out;
}

/* ============================================================
   8 · presets

   The earlier sketches, expressed in this vocabulary. They are
   here as proof the generalisation actually covers them, and as a
   sane starting point for anything new.
   ============================================================ */
const PRESETS = {
  "Shell rings": {
    surface: "sphere", surfaceParams: { radius: 210, shellGap: 60 }, shells: 6,
    distribution: "grid", rows: 40, cols: 36,
    modifiers: [],
    presence: "field", presenceParams: { scale: 3, low: 0.45, high: 0.56, evolve: 0.3 },
    colour: "spectrum", colourParams: { hue: 190, range: 200, sat: 0.6 },
    sizeMin: 4, sizeMax: 4
  },
  "Orbit flower": {
    surface: "sphere", surfaceParams: { radius: 190, shellGap: 0, vStart: 20, vEnd: 160 }, shells: 1,
    distribution: "rings", distParams: { spin: 0.5, spread: 3, wobble: 0.07, wobbleHz: 0.4 },
    rows: 60, cols: 22,
    modifiers: [], presence: "all",
    colour: "spectrum", colourParams: { hue: 20, range: 300, sat: 0.85 },
    sizeMin: 3, sizeMax: 11
  },
  "Supershape bloom": {
    surface: "supershape", surfaceParams: { radius: 180, shellGap: 40, m1: 7, n11: 0.4, m2: 3 },
    shells: 3, distribution: "grid", rows: 54, cols: 54,
    modifiers: [{ type: "noise", params: { amount: 18, scale: 3.4, speed: 0.25 } }],
    presence: "all",
    colour: "height", colourParams: { hue: 300, range: 160, sat: 0.72 },
    sizeMin: 2, sizeMax: 5
  },
  "Carved torus": {
    surface: "torus", surfaceParams: { radius: 175, tube: 70, shellGap: 24, twistTurns: 1 },
    shells: 4, distribution: "grid", rows: 60, cols: 80,
    modifiers: [{ type: "twist", params: { amount: 0.2 } }],
    presence: "field", presenceParams: { scale: 4.2, low: 0.44, high: 0.58, evolve: 0.4 },
    colour: "fieldcol", colourParams: { hue: 160, range: 200, sat: 0.8 },
    sizeMin: 3, sizeMax: 3
  },
  "Flock on a sphere": {
    surface: "sphere", surfaceParams: { radius: 200, shellGap: 70 }, shells: 4,
    distribution: "flock", rows: 10, cols: 12,
    modifiers: [], presence: "all",
    colour: "spectrum", colourParams: { hue: 140, range: 180, sat: 0.8 },
    sizeMin: 6, sizeMax: 6
  },
  "Möbius scatter": {
    surface: "mobius", surfaceParams: { radius: 175, width: 110, halfTwists: 1 }, shells: 2,
    distribution: "fibonacci", distParams: { drift: 0.4 }, rows: 50, cols: 50,
    modifiers: [{ type: "ripple", params: { amount: 22, cycles: 7, speed: 0.8 } }],
    presence: "all",
    colour: "mono", colourParams: { hue: 205, sat: 0.35, floor: 0.3 },
    sizeMin: 2, sizeMax: 6
  }
};

return {
  SCHEMA_VERSION,
  // primitives, so a tool need not re-implement them
  hash4, noise3D, noise4D, hsb2rgb, lerp, clamp, smoothstep, smoothBand, superRadius,
  // vocabulary
  SURFACES, DISTRIBUTIONS, MODIFIERS, PRESENCE, COLOURS, PRESETS,
  // geometry
  surfaceNormal, carveField,
  // flock
  createFlock, stepFlock,
  // frames
  makeFrame, ensureFrame, generate, morph, bounds,
  // handoffs
  toVolumePacked, targets, defaultsFor, withDefaults
};
})();

if(typeof module !== "undefined" && module.exports) module.exports = UnlimiterPoints;
