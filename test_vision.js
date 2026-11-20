/* Headless tests for unlimiter-vision.js.   node test_vision.js */
const PT = require('./unlimiter-ports.js');
globalThis.UnlimiterPorts = PT;
const V = require('./unlimiter-vision.js');
const { W, H } = V;
let failures = 0;
function ok(c, label, extra){ if(!c){ failures++; console.log('  FAIL  ' + label + (extra ? '  ' + extra : '')); } else console.log('  ok    ' + label + (extra ? '  ' + extra : '')); }
function section(s){ console.log('\n== ' + s + ' =='); }

/* a smooth, richly textured scene that can be shifted by sub-pixel amounts */
function tex(x, y){
  return 128 + 40 * Math.sin(x * 0.21 + 1) * Math.cos(y * 0.17) + 35 * Math.sin((x + y) * 0.11) + 30 * Math.sin(x * 0.07 - y * 0.13 + 2)
       + 25 * Math.cos(x * 0.33 + y * 0.29) + 20 * Math.sin(x * 0.5) * Math.sin(y * 0.43);
}
function scene(dx, dy, extra){
  const a = new Uint8ClampedArray(W * H * 4);
  for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){
    let v = tex(x - dx, y - dy);
    if(extra) v = extra(x, y, v);
    const j = (y * W + x) * 4; a[j] = v; a[j + 1] = v * 0.9; a[j + 2] = v * 0.8; a[j + 3] = 255;
  }
  return a;
}
const mean = (arr, f) => { let s = 0; for(let i = 0; i < arr.length; i++) s += f(arr[i], i); return s / arr.length; };

section('flow');
{
  const E = V.create();
  let out;
  for(let k = 0; k < 8; k++) out = E.step(scene(k * 2, k * 1), 16 / 9, k / 30, 'flow', {});
  ok(PT.isField(out.field) && out.field.w === V.FW && out.field.h === V.FH, 'a field comes out at the declared grid');
  // 2 px right, 1 px down per frame at 30 fps → uv/s = (2/192*30, 1/108*30) = (0.3125, 0.2778)
  let sx = 0, sy = 0, n = 0;
  for(let fy = 4; fy < V.FH - 4; fy++) for(let fx = 4; fx < V.FW - 4; fx++){ const o = (fy * V.FW + fx) * 2; sx += out.field.data[o]; sy += out.field.data[o + 1]; n++; }
  sx /= n; sy /= n;
  ok(Math.abs(sx - 0.3125) < 0.06 && Math.abs(sy - 0.2778) < 0.06, 'a (2,1) px/frame shift reads as ≈(0.31,0.28) uv/s', `got (${sx.toFixed(3)}, ${sy.toFixed(3)})`);
  ok(PT.isMask(out.mask) && mean(out.mask.data, v => v > 100 ? 1 : 0) > 0.5, 'the mask lights where it moves');
  ok(PT.isPoints(out.points) && out.points.count > 20 && out.points.space === 'uv' && out.points.aspect > 1.7, 'points land on the motion', 'count=' + out.points.count);
  const p = out.points; let tx = 0, ty = 0; for(let i = 0; i < p.count; i++){ tx += p.tangents[i * 3]; ty += p.tangents[i * 3 + 1]; }
  ok(tx > 0 && ty > 0 && tx > ty, 'their tangents follow the motion', `Σt=(${tx.toFixed(1)},${ty.toFixed(1)})`);
  // large motion needs the pyramid: 7 px per frame
  const E2 = V.create(); for(let k = 0; k < 6; k++) out = E2.step(scene(k * 7, 0), 16 / 9, k / 30, 'flow', { smooth:0 });
  let s7 = 0, c7 = 0; for(let fy = 4; fy < V.FH - 4; fy++) for(let fx = 8; fx < V.FW - 8; fx++){ s7 += out.field.data[(fy * V.FW + fx) * 2]; c7++; }
  s7 = s7 / c7 / 30 * V.W;
  ok(Math.abs(s7 - 7) < 1.6, 'a 7 px/frame move is still found (pyramid)', `got ${s7.toFixed(2)} px/frame`);
  // still scene → still field
  const E3 = V.create(); for(let k = 0; k < 6; k++) out = E3.step(scene(0, 0), 16 / 9, k / 30, 'flow', {});
  ok(mean(out.field.data, Math.abs) < 0.01 && out.stats.activity === 0, 'a still scene gives no motion', 'mean|f|=' + mean(out.field.data, Math.abs).toExponential(1));
  ok(out.vis.length === W * H * 4 && out.vis[3] === 255, 'and a picture of it');
}

section('edges');
{
  const E = V.create();
  const cx = 96, cy = 54, R = 30;
  const disc = (x, y) => Math.hypot(x - cx, y - cy) < R ? 230 : 25;
  const img = new Uint8ClampedArray(W * H * 4); for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){ const v = disc(x, y), j = (y * W + x) * 4; img[j] = img[j + 1] = img[j + 2] = v; img[j + 3] = 255; }
  const out = E.step(img, 16 / 9, 0, 'edges', { points:300 });
  const p = out.points; let onRing = 0, perp = 0;
  for(let i = 0; i < p.count; i++){
    const px = p.positions[i * 3] * W - 0.5, py = p.positions[i * 3 + 1] * H - 0.5, r = Math.hypot(px - cx, py - cy);
    if(Math.abs(r - R) < 3) onRing++;
    const rx = (px - cx) / r, ry = (py - cy) / r, dot = Math.abs(p.tangents[i * 3] * rx + p.tangents[i * 3 + 1] * ry);
    if(dot < 0.3) perp++;
  }
  ok(p.count > 40 && onRing / p.count > 0.95, 'edge points sit on the circle', `${onRing}/${p.count}`);
  ok(perp / p.count > 0.9, 'and their tangents run along it (⊥ radius)', `${perp}/${p.count}`);
  ok(PT.isMask(out.mask) && out.mask.data[(cy * W) + cx - R] > 0 && out.mask.data[cy * W + cx] === 0, 'the mask has the ring and not the middle');
  // field near the ring at 3 o'clock should be vertical-ish
  const fx = Math.round((cx + R) / 4), fy = Math.round(cy / 4), o = (fy * V.FW + fx) * 2, f = out.field.data;
  ok(Math.abs(f[o + 1]) > Math.abs(f[o]) * 2 && Math.hypot(f[o], f[o + 1]) > 0.1, 'the orientation field runs vertical at 3 o\'clock', `(${f[o].toFixed(2)},${f[o+1].toFixed(2)})`);
  const flat = ((10 / 4) | 0) + ((10 / 4) | 0) * V.FW;
  ok(Math.hypot(f[flat * 2], f[flat * 2 + 1]) < 0.02, 'and is quiet on flat ground');
  const E2 = V.create(); const hi = E2.step(img, 16 / 9, 0, 'edges', { thresh:0.9 });
  ok(hi.points.count <= out.points.count, 'a higher threshold keeps fewer edges');
}

section('background subtraction');
{
  const E = V.create(); let out;
  for(let k = 0; k < 30; k++) out = E.step(scene(0, 0), 16 / 9, k / 30, 'bgsub', {});
  ok(mean(out.mask.data, v => v > 127 ? 1 : 0) < 0.002, 'an empty room has an empty mask');
  const box = (x, y, v) => (x > 70 && x < 120 && y > 30 && y < 80) ? 240 - (x % 7) * 5 : v;
  for(let k = 0; k < 4; k++) out = E.step(scene(0, 0, box), 16 / 9, (30 + k) / 30, 'bgsub', {});
  const inside = out.mask.data[55 * W + 95], outside = out.mask.data[10 * W + 10];
  const area = mean(out.mask.data, v => v > 127 ? 1 : 0), expect = 49 * 49 / (W * H);
  ok(inside > 200 && outside === 0, 'someone steps in → the silhouette appears', `in=${inside} out=${outside}`);
  ok(Math.abs(area - expect) / expect < 0.25, 'and is about the right size', `${(area*100).toFixed(1)}% vs ${(expect*100).toFixed(1)}%`);
  ok(out.points.count > 5, 'points spread over it', 'count=' + out.points.count);
  // outward field: left of the box points left (negative x), right of it points right
  const f = out.field.data, row = Math.round(55 / 4);
  const L = f[(row * V.FW + Math.round(68 / 4)) * 2], Rr = f[(row * V.FW + Math.round(122 / 4)) * 2];
  ok(L < 0 && Rr > 0, 'the field points away from the silhouette', `L=${L.toFixed(2)} R=${Rr.toFixed(2)}`);
  // stay for a long while: the selective update keeps it
  for(let k = 0; k < 120; k++) out = E.step(scene(0, 0, box), 16 / 9, (34 + k) / 30, 'bgsub', {});
  ok(out.mask.data[55 * W + 95] > 200, 'someone standing still stays in the mask (slow absorb)');
  // leaves: the mask goes away
  for(let k = 0; k < 60; k++) out = E.step(scene(0, 0), 16 / 9, (160 + k) / 30, 'bgsub', {});
  ok(out.mask.data[55 * W + 95] < 30, 'and leaves it again when they go');
}

section('tracks');
{
  const E = V.create(); let out;
  for(let k = 0; k < 10; k++) out = E.step(scene(k * 1.5, k * 0.5), 16 / 9, k / 30, 'tracks', { points:80 });
  const p = out.points;
  ok(p.count > 25, 'corners are found and held', 'count=' + p.count);
  let sx = 0, sy = 0, n = 0; for(let i = 0; i < p.count; i++){ sx += p.tangents[i * 3]; sy += p.tangents[i * 3 + 1]; n++; }
  ok(sx / n > 0.5 && sy / n > 0.1, 'their headings follow the scene', `mean t=(${(sx/n).toFixed(2)},${(sy/n).toFixed(2)})`);
  // positions really follow: ids moved by about the shift
  const E2 = V.create(); let prev = null, moved = [];
  for(let k = 0; k < 12; k++){
    out = E2.step(scene(k * 2, 0), 16 / 9, k / 30, 'tracks', { points:60 });
  }
  ok(PT.isField(out.field) && Math.abs(mean(out.field.data.filter((_, i) => i % 2 === 0), v => v)) > 0.05, 'the splatted field carries the motion');
  ok(out.mask === null, 'tracks make no mask');
  // an empty frame loses them without crashing
  const flat = new Uint8ClampedArray(W * H * 4).fill(100);
  out = E2.step(flat, 16 / 9, 20 / 30, 'tracks', { points:60 });
  ok(out.points.count < 60, 'a blank frame drops tracks');
}

section('plumbing');
{
  const E = V.create();
  const out = E.step(scene(0, 0), 16 / 9, 0, 'nonsense', {});
  ok(E.mode === 'flow', 'an unknown mode falls back to flow');
  const r = V.resolve('flow', { gain:99, points:-5, thresh:'x' });
  ok(r.gain === 4 && r.points === 8 && r.thresh === 0.3, 'parameters are clamped and defaulted', JSON.stringify(r));
  let t0 = Date.now(); const E2 = V.create();
  for(const m of V.MODES){ const t = Date.now(); for(let k = 0; k < 10; k++) E2.step(scene(k, 0), 16 / 9, k / 30, m, {}); console.log('       ' + m + ': ' + ((Date.now() - t) / 10).toFixed(1) + ' ms/frame'); }
}
console.log(failures ? '\n' + failures + ' FAILED' : '\nALL VISION CHECKS PASSED');
process.exit(failures ? 1 : 0);
