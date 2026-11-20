const U = require('./unlimiter-points.js');

let failures = 0;
function ok(cond, label, extra){
  if(!cond){ failures++; console.log('  FAIL  ' + label + (extra ? '  ' + extra : '')); }
  else console.log('  ok    ' + label + (extra ? '  ' + extra : ''));
}
function finite(arr){ for(let i=0;i<arr.length;i++) if(!isFinite(arr[i])) return false; return true; }
function section(s){ console.log('\n== ' + s + ' =='); }

/* ---- 1. every surface maps finitely across its whole domain, edges included ---- */
section('surfaces');
const out = [0,0,0];
for(const id of Object.keys(U.SURFACES)){
  const S = U.SURFACES[id];
  const P = U.defaultsFor(S.params);
  let bad = 0, maxAbs = 0;
  // include exact edges and a few pathological parameter values
  const us = [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1];
  const vs = [0, 0.001, 0.5, 0.999, 1];
  const shs = [0, 0.5, 1];
  for(const u of us) for(const v of vs) for(const sh of shs){
    S.map(u, v, sh, P, out);
    if(!finite(out)) bad++;
    maxAbs = Math.max(maxAbs, Math.abs(out[0]), Math.abs(out[1]), Math.abs(out[2]));
  }
  // zeroed / extreme params (sliders can reach these)
  const Pz = Object.assign({}, P);
  for(const k in Pz) Pz[k] = 0;
  for(const u of us) for(const v of vs){ S.map(u, v, 0.5, Pz, out); if(!finite(out)) bad++; }
  const Pm = {};
  S.params.forEach(p => { Pm[p.key] = p.max; });
  for(const u of us) for(const v of vs){ S.map(u, v, 0.5, Pm, out); if(!finite(out)) bad++; }
  ok(bad === 0, id.padEnd(11) + ' finite over domain + zeroed + maxed params',
     'bad=' + bad + ' maxAbs=' + maxAbs.toFixed(0));
}

/* ---- 2. normals: finite and unit length, including at poles/seams ---- */
section('surface normals (finite-difference, poles included)');
const nrm = [0,0,0];
for(const id of Object.keys(U.SURFACES)){
  const S = U.SURFACES[id];
  const P = U.defaultsFor(S.params);
  let bad = 0, worst = 0;
  for(let u = 0; u <= 1.0001; u += 0.05) for(const v of [0, 0.02, 0.5, 0.98, 1]){
    U.surfaceNormal(S, u % 1, v, 0.5, P, nrm);
    if(!finite(nrm)){ bad++; continue; }
    const len = Math.hypot(nrm[0], nrm[1], nrm[2]);
    worst = Math.max(worst, Math.abs(len - 1));
  }
  ok(bad === 0 && worst < 1e-6, id.padEnd(11) + ' normals finite & unit',
     'bad=' + bad + ' maxLenErr=' + worst.toExponential(1));
}

/* ---- 3. distributions stay inside the address space ---- */
section('distributions');
const uv = [0,0];
for(const id of Object.keys(U.DISTRIBUTIONS)){
  const D = U.DISTRIBUTIONS[id];
  const P = U.defaultsFor(D.params);
  const st = D.stateful ? U.createFlock(120, 4) : null;
  let bad = 0, outU = 0, outV = 0;
  for(let t = 0; t < 12; t += 0.37){
    if(st) U.stepFlock(st, 1/60, t, U.defaultsFor(U.DISTRIBUTIONS.flock.params), null, null);
    for(let i = 0; i < 120; i++){
      D.place(i, (i/12)|0, i%12, 10, 12, t, P, st, uv);
      if(!isFinite(uv[0]) || !isFinite(uv[1])) bad++;
      if(uv[0] < 0 || uv[0] >= 1.0000001) outU++;
      if(uv[1] < -1e-7 || uv[1] > 1.0000001) outV++;
    }
  }
  ok(bad === 0 && outU === 0 && outV === 0, id.padEnd(11) + ' u in [0,1), v in [0,1]',
     'nan=' + bad + ' outU=' + outU + ' outV=' + outV);
}

/* ---- 4. modifiers keep values finite, at default and at slider extremes ---- */
section('modifiers');
for(const id of Object.keys(U.MODIFIERS)){
  const M = U.MODIFIERS[id];
  let bad = 0;
  for(const which of ['def','min','max']){
    const P = {};
    M.params.forEach(p => { P[p.key] = which === 'def' ? p.def : (which === 'min' ? p.min : p.max); });
    for(let k = 0; k < 200; k++){
      const p = [Math.cos(k)*200, Math.sin(k*0.7)*200, Math.sin(k)*200];
      const n = [0,1,0];
      M.apply(p, n, (k%10)/10, (k%7)/7, (k%3)/2, k*0.03, P);
      if(!finite(p)) bad++;
    }
  }
  ok(bad === 0, id.padEnd(11) + ' finite at default/min/max params', 'bad=' + bad);
}

/* ---- 5. every preset generates cleanly ---- */
section('presets generate');
for(const name of Object.keys(U.PRESETS)){
  const spec = U.PRESETS[name];
  const st = U.DISTRIBUTIONS[spec.distribution].stateful
    ? U.createFlock(spec.rows * spec.cols, spec.shells || 1) : null;
  let frame = null, bad = 0;
  for(let f = 0; f < 40; f++){
    const t = f / 60;
    if(st) U.stepFlock(st, 1/60, t, U.defaultsFor(U.DISTRIBUTIONS.flock.params), null, null);
    frame = U.generate(spec, t, frame, st);
    if(!finite(frame.positions) || !finite(frame.colors) || !finite(frame.sizes) || !finite(frame.presence)) bad++;
  }
  const expected = spec.rows * spec.cols;
  let colOK = true;
  for(let i = 0; i < frame.colors.length; i++) if(frame.colors[i] < -1e-6 || frame.colors[i] > 1.000001) colOK = false;
  let preOK = true;
  for(let i = 0; i < frame.count; i++) if(frame.presence[i] < -1e-6 || frame.presence[i] > 1.000001) preOK = false;
  ok(bad === 0 && frame.count === expected && colOK && preOK,
     name.padEnd(20) + ' 40 frames clean', 'count=' + frame.count + '/' + expected +
     ' colours0..1=' + colOK + ' presence0..1=' + preOK);
}

/* ---- 6. flock stability under abuse, plus the jitter metric ---- */
section('flock stability & smoothness');
function flockRun(label, F, shells, count, fieldOn){
  const st = U.createFlock(count, shells);
  const spec = U.PRESETS['Flock on a sphere'];
  const SP = U.withDefaults('surface', 'sphere', spec.surfaceParams);
  const field = fieldOn ? (u, v, sh) => {
    const p = [0,0,0];
    U.SURFACES.sphere.map(u, v, sh, SP, p);
    return U.carveField(p, sh, { scale: 6, evolve: 0.4 }, 0);
  } : null;
  let nan = 0, outU = 0, outV = 0;
  let prev = null, angSum = 0, angN = 0;
  for(let f = 0; f < 400; f++){
    const t = f / 60;
    U.stepFlock(st, 1/60, t, F, field, [0.45, 0.58, 6]);
    const cur = st.agents.map(a => [a.vu, a.vv]);
    for(let i = 0; i < st.agents.length; i++){
      const a = st.agents[i];
      if(!isFinite(a.u) || !isFinite(a.v) || !isFinite(a.vu) || !isFinite(a.vv)){ nan++; continue; }
      if(a.u < 0 || a.u >= 1.0000001) outU++;
      if(a.v < -1e-7 || a.v > 1.0000001) outV++;
    }
    if(prev && f > 60){
      for(let i = 0; i < cur.length; i++){
        const m1 = Math.hypot(prev[i][0], prev[i][1]), m2 = Math.hypot(cur[i][0], cur[i][1]);
        if(m1 < 1e-5 || m2 < 1e-5) continue;
        let d = (prev[i][0]*cur[i][0] + prev[i][1]*cur[i][1]) / (m1*m2);
        angSum += Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI; angN++;
      }
    }
    prev = cur;
  }
  const avgAng = angN ? angSum / angN : 0;
  ok(nan === 0 && outU === 0 && outV === 0 && avgAng < 30,
     label.padEnd(30), 'nan=' + nan + ' outU=' + outU + ' outV=' + outV +
     ' avgTurn/frame=' + avgAng.toFixed(2) + '°');
}
const F0 = U.defaultsFor(U.DISTRIBUTIONS.flock.params);
flockRun('default, field off', F0, 4, 80, false);
flockRun('default, field on', F0, 4, 80, true);
flockRun('high field pull (3)', Object.assign({}, F0, {fieldPull:3}), 4, 80, true);
flockRun('max speed 2, wander .3', Object.assign({}, F0, {maxSpeed:2, wander:0.3}), 4, 80, true);
flockRun('responsiveness .9 (snappy)', Object.assign({}, F0, {responsive:0.9}), 3, 60, true);
flockRun('one shell, one agent', F0, 1, 1, true);

/* ---- 7. morph: endpoints are exact, middles are finite ---- */
section('morph');
const specA = U.PRESETS['Shell rings'];
const specB = Object.assign({}, U.PRESETS['Carved torus'], { rows: specA.rows, cols: specA.cols });
let fm = null, sa = null, sb = null, bad = 0;
const r0 = U.morph(specA, specB, 0, 1.0, null, null, null, null, null);
const r1 = U.morph(specA, specB, 1, 1.0, null, null, null, null, null);
let e0 = 0, e1 = 0;
for(let i = 0; i < r0.frame.count * 3; i++){
  e0 = Math.max(e0, Math.abs(r0.frame.positions[i] - r0.a.positions[i]));
  e1 = Math.max(e1, Math.abs(r1.frame.positions[i] - r1.b.positions[i]));
}
ok(e0 < 1e-6, 'mix=0 equals spec A exactly', 'maxErr=' + e0.toExponential(1));
ok(e1 < 1e-6, 'mix=1 equals spec B exactly', 'maxErr=' + e1.toExponential(1));
for(let k = 0; k <= 10; k++){
  const r = U.morph(specA, specB, k/10, k*0.2, fm, sa, sb, null, null);
  fm = r.frame;
  if(!finite(fm.positions) || !finite(fm.colors)) bad++;
}
ok(bad === 0, 'sphere -> torus across the whole mix range is finite', 'bad=' + bad);
// a morph between different point counts must not read past the shorter one
const specSmall = Object.assign({}, specB, { rows: 10, cols: 10 });
const rs = U.morph(specA, specSmall, 0.5, 0, null, null, null, null, null);
ok(rs.frame.count === 100 && finite(rs.frame.positions), 'mismatched counts clamp to the smaller',
   'count=' + rs.frame.count);

/* ---- 8. volume packing ---- */
section('volume handoff');
let vf = U.generate(U.PRESETS['Shell rings'], 2.0, null, null);
const vp = U.toVolumePacked(vf, { scale: 1 });
let live = 0; for(let i = 0; i < vf.count; i++) if(vf.presence[i] >= 0.02) live++;
ok(vp.count === live, 'packed count equals points above cutoff', vp.count + ' of ' + vf.count);
ok(vp.packed.length === vp.count * 16, 'stride is 16 floats per point');
ok(vp.positions.length === vp.count * 3, 'positions array is n*3');
let inRange = true, alphaOK = true;
for(let i = 0; i < vp.count; i++){
  const o = i * 16;
  for(let k = 0; k < 3; k++) if(Math.abs(vp.packed[o+k]) > 1.0001) inRange = false;
  if(vp.packed[o+7] < 0 || vp.packed[o+7] > 1.0001) alphaOK = false;
  for(let k = 4; k < 7; k++) if(vp.packed[o+k] < -1e-6 || vp.packed[o+k] > 1.0001) inRange = false;
}
ok(inRange, 'xyz normalised into [-1,1] and rgb into [0,1]');
ok(alphaOK, 'alpha carries presence in [0,1]');
const emptySpec = Object.assign({}, U.PRESETS['Shell rings'],
  { presenceParams: { scale: 3, low: 0.99, high: 0.995, evolve: 0 } });
const ef = U.generate(emptySpec, 0, null, null);
const ep = U.toVolumePacked(ef);
ok(isFinite(ep.count) && ep.packed.length === ep.count * 16, 'a fully carved-away frame packs without blowing up',
   'count=' + ep.count);

/* ---- 9. targets ---- */
section('modulation targets');
const tg = U.targets(U.PRESETS['Carved torus']);
const keys = new Set(tg.map(t => t.key));
ok(tg.length > 0 && keys.size === tg.length, 'targets are unique', tg.length + ' targets');
ok(tg.every(t => isFinite(t.min) && isFinite(t.max) && t.max > t.min), 'every target has a usable range');
ok(tg.some(t => t.key.startsWith('surf.')) && tg.some(t => t.key.startsWith('mod0.')) &&
   tg.some(t => t.key.startsWith('pres.')), 'surface, modifier and presence params all exposed');

/* ---- 10. frame reuse across changing counts ---- */
section('frame reuse');
let rf = U.generate(Object.assign({}, U.PRESETS['Shell rings'], {rows:40, cols:40}), 0, null, null);
const cap = rf.capacity;
rf = U.generate(Object.assign({}, U.PRESETS['Shell rings'], {rows:10, cols:10}), 0.1, rf, null);
ok(rf.count === 100 && rf.capacity === cap, 'shrinking reuses the buffer and resets count',
   'count=' + rf.count + ' capacity=' + rf.capacity);
rf = U.generate(Object.assign({}, U.PRESETS['Shell rings'], {rows:60, cols:60}), 0.2, rf, null);
ok(rf.count === 3600 && rf.capacity >= 3600 && finite(rf.positions), 'growing reallocates cleanly',
   'count=' + rf.count);

/* ---- 11. determinism ---- */
section('determinism');
const d1 = U.generate(U.PRESETS['Supershape bloom'], 3.25, null, null);
const c1 = Float32Array.from(d1.positions);
const d2 = U.generate(U.PRESETS['Supershape bloom'], 3.25, null, null);
let same = true;
for(let i = 0; i < c1.length; i++) if(c1[i] !== d2.positions[i]) same = false;
ok(same, 'same spec + same t gives identical points (re-samplable by any consumer)');

/* ---- 12. throughput sanity ---- */
section('throughput');
const perfSpec = Object.assign({}, U.PRESETS['Carved torus'], { rows: 120, cols: 140 });
let pf = U.generate(perfSpec, 0, null, null);
const t0 = Date.now();
for(let f = 0; f < 20; f++) pf = U.generate(perfSpec, f/60, pf, null);
const ms = (Date.now() - t0) / 20;
console.log('  info  ' + (perfSpec.rows*perfSpec.cols).toLocaleString() +
            ' points with a carve field + 1 modifier: ' + ms.toFixed(1) + ' ms/frame');
ok(ms < 120, 'stays inside a sane per-frame budget at 16.8k points');

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
