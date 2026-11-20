/* Headless tests for unlimiter-ports.js.   node test_ports.js */
const vm = require('vm');
const X = require('./unlimiter-ports.js');
const U = require('./unlimiter-points.js');

let failures = 0;
function ok(cond, label, extra){
  if(!cond){ failures++; console.log('  FAIL  ' + label + (extra ? '  ' + extra : '')); }
  else console.log('  ok    ' + label + (extra ? '  ' + extra : ''));
}
function section(s){ console.log('\n== ' + s + ' =='); }
const finite = a => { for(let i = 0; i < a.length; i++) if(!isFinite(a[i])) return false; return true; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

section('values');
let f = X.makePoints(10, '3d');
ok(f.capacity === 10 && f.count === 0 && f.positions.length === 30, 'makePoints sizes its buffers');
let g = X.ensurePoints(f, 8);
ok(g === f && g.count === 8, 'ensurePoints reuses a frame with room');
g = X.ensurePoints(f, 11);
ok(g !== f && g.capacity === 16 && g.count === 11, 'and grows to the next power of two', 'capacity=' + g.capacity);
const g2 = X.ensurePoints(g, 13);
ok(g2 === g, 'so a count that wobbles below capacity never reallocates');
const v0 = g.version; X.bump(g);
ok(g.version === v0 + 1, 'bump increments version');
ok(X.isType('field', X.makeField(4, 3)) && X.isType('mask', X.makeMask(4, 3)), 'field and mask constructors validate');

section('validation');
const pts = X.makePoints(4, '3d'); pts.count = 4;
ok(X.isPoints(pts), 'a well-formed points value passes');
ok(!X.isPoints({ count: 4, positions: new Float32Array(6) }), 'too-short positions are rejected');
ok(!X.isPoints({ count: 2, positions: new Float64Array(6) }), 'Float64 positions are rejected');
ok(!X.isPoints(Object.assign({}, pts, { space: 'screen' })), 'an unknown space is rejected');
ok(!X.isType('nonsense', pts), 'unknown types are rejected');
ok(X.isImage({ width: 2, height: 2 }) && X.isImage({ videoWidth: 2 }) && !X.isImage({}), 'images are duck-typed by size');

section('cross-realm (why nothing here uses instanceof)');
// A Float32Array made in another realm, the way one arrives from a rack iframe
const other = vm.runInNewContext('({ type:"points", space:"3d", count:3, positions:new Float32Array(9), colors:new Float32Array(9), sizes:new Float32Array(3), presence:new Float32Array(3) })');
ok(!(other.positions instanceof Float32Array), 'instanceof really does fail across realms', '(the trap)');
ok(X.isPoints(other), 'isPoints still accepts it');
const otherMask = vm.runInNewContext('({ type:"mask", w:2, h:2, data:new Uint8Array(4) })');
ok(X.isMask(otherMask), 'isMask accepts a foreign Uint8Array');
const n3 = X.normalize3d(other, [0,0,0], 1, null);
ok(n3.count === 3 && finite(n3.positions), 'and ops run on foreign frames');

section('normalize3d');
const w = X.makePoints(2, 'world'); w.count = 2;
w.positions.set([110, 20, 30, 90, 20, 30]);
const n = X.normalize3d(w, [100, 20, 30], 0.1, null);
ok(near(n.positions[0], 1) && near(n.positions[3], -1) && near(n.positions[1], 0), 'centre and scale are applied', JSON.stringify(Array.from(n.positions.subarray(0, 6))));
ok(n.space === '3d' && n.version > 0, 'result is space "3d" with a bumped version');
ok(n.presence[0] === 1 && n.colors[0] === 1, 'a fresh frame defaults to fully present, white');
const bare = { count: 2, positions: new Float32Array([1,0,0, 0,1,0]) };
const nb2 = X.normalize3d(bare, null, 1, null);
ok(nb2.presence[0] === 1 && nb2.presence[1] === 1 && nb2.colors[4] === 1 && nb2.sizes[1] === 1, 'a producer that sends only positions still gets visible points');

section('project');
const p3 = X.makePoints(4, '3d'); p3.count = 4;
p3.positions.set([1,0,0,  0,1,0,  0,0,1,  0,0,-1]);
let uv = X.project(p3, { yaw:0, pitch:0, roll:0, zoom:1, persp:0, aspect:1 }, null);
ok(near(uv.positions[0], 1) && near(uv.positions[1], 0.5), '+X lands on the right edge', `(${uv.positions[0]}, ${uv.positions[1]})`);
ok(near(uv.positions[3], 0.5) && near(uv.positions[4], 0), '+Y lands on the top edge (v runs down)');
ok(near(uv.positions[8], 1) && near(uv.positions[11], -1), 'z is +1 nearest the viewer, -1 behind');
uv = X.project(p3, { yaw:0, zoom:1, persp:0, aspect:2 }, uv);
ok(near(uv.positions[0], 0.75), 'on a 2:1 frame +X is pulled in so a circle stays round', 'u=' + uv.positions[0]);
uv = X.project(p3, { yaw:90, zoom:1, persp:0, aspect:1 }, uv);
ok(near(uv.positions[0], 0.5) && near(uv.positions[2], -1), 'yaw 90 turns +X to the back');
uv = X.project(p3, { yaw:0, zoom:1, persp:1, aspect:1 }, uv);
const front = Math.abs(uv.positions[6] - 0.5), back = Math.abs(uv.positions[9] - 0.5);
// both sit at the centre; check scale via a displaced pair instead
const pp = X.makePoints(2, '3d'); pp.count = 2; pp.positions.set([0.5,0,1,  0.5,0,-1]);
const up = X.project(pp, { zoom:1, persp:1, aspect:1 }, null);
ok(up.positions[0] - 0.5 > up.positions[3] - 0.5, 'with perspective, nearer points spread wider', `${(up.positions[0]-0.5).toFixed(3)} > ${(up.positions[3]-0.5).toFixed(3)}`);

section('fitUV');
const o = X.fitUV(1, 0.5, 1, 2);
ok(near(o[0], 0.75) && near(o[1], 0.5), 'a square layout fits inside a wide frame, centred');
const o2 = X.fitUV(0.5, 1, 2, 1);
ok(near(o2[0], 0.5) && near(o2[1], 0.75), 'a wide layout fits inside a square frame, centred');

section('packVolume');
const pv = X.makePoints(4, '3d'); pv.count = 4;
pv.positions.set([1,2,3, 4,5,6, 7,8,9, 10,11,12]);
pv.colors.set([.1,.2,.3, .4,.5,.6, .7,.8,.9, 1,1,1]);
pv.presence.set([1, 0.01, 0.5, 1]);
let pk = X.packVolume(pv, 0.02, null);
ok(pk.count === 3, 'points under the cutoff are dropped', 'count=' + pk.count);
ok(pk.packed[0] === 1 && pk.packed[16] === 7 && near(pk.packed[16 + 7], 0.5), 'stride 16: xyz at 0-2, alpha at 7');
ok(near(pk.packed[4], 0.1) && near(pk.packed[6], 0.3), 'rgb at 4-6');
ok(pk.positions[3] === 7, 'positions mirror xyz for the CPU sort');
const cap = pk.capacity; const buf = pk.packed;
pv.presence.set([0, 0, 0, 1]);
pk = X.packVolume(pv, 0.02, pk);
ok(pk.packed === buf && pk.count === 1, 'a later, smaller frame reuses the same buffer', 'capacity ' + cap);
ok(pk.packed[16] === 0 && pk.packed[32] === 0, 'and zeroes what the previous frame left behind');

section('contract');
let threw = null;
try{ X.publish({ tool: 't', outputs: { a: { type: 'points' } } }); }catch(e){ threw = e.message; }
ok(!!threw, 'an output without get() is refused at publish time', threw);
threw = null;
try{ X.publish({ tool: 't', inputs: { a: { type: 'sound', set(){} } } }); }catch(e){ threw = e.message; }
ok(!!threw, 'an unknown type is refused', threw);
const c = X.publish({ tool: 'demo', outputs: { pts: { type: 'points', get: () => pv } }, inputs: { src: { type: 'image', set(){} } } });
ok(c.schemaVersion === 1 && c.outputs.pts.id === 'pts' && c.outputs.pts.label === 'pts', 'publish normalises ids, labels and version');
ok(X.contract === c, 'the module exposes what was published');
ok(X.read({ UnlimiterPorts: X }) === c, 'a host reads it back off a window');
ok(X.read({}) === null && X.read(null) === null, 'a window without ports reads as null');
const hostile = {}; Object.defineProperty(hostile, 'UnlimiterPorts', { get(){ throw new Error('SecurityError'); } });
ok(X.read(hostile) === null, 'a cross-origin window (throws on access) reads as null');
ok(X.read({ UnlimiterPorts: { contract: { schemaVersion: 99 } } }) === null, 'a future schema version is not mistaken for this one');
ok(X.compatible('points', 'points') && !X.compatible('points', 'image'), 'only same-type ports connect');

section('with unlimiter-points');
const spec = U.PRESETS['Carved torus'];
let world = U.generate(spec, 1.5, null, null);
ok(world.type === 'points' && world.space === 'world' && world.version === 1, 'generated frames now identify themselves', `type=${world.type} space=${world.space} v=${world.version}`);
ok(X.isPoints(world), 'and validate as a points value');
world = U.generate(spec, 1.6, world, null);
ok(world.version === 2, 'version bumps on every generate');
const bb = U.bounds(world);
const unit = X.normalize3d(world, bb.centre, 1 / bb.radius, null);
let maxR = 0; for(let i = 0; i < unit.count; i++){ if(unit.presence[i] < 0.02) continue; const i3 = i*3;
  maxR = Math.max(maxR, Math.abs(unit.positions[i3]), Math.abs(unit.positions[i3+1]), Math.abs(unit.positions[i3+2])); }
ok(maxR > 0.9 && maxR <= 1.0001, 'bounds-normalised geometry fills the unit cube', 'max |coord| = ' + maxR.toFixed(4));
const view = { yaw: 30, pitch: 20, zoom: 0.9, persp: 0.3, aspect: 16/9 };
const flat = X.project(unit, view, null);
let inFrame = 0, live = 0;
for(let i = 0; i < flat.count; i++){ if(flat.presence[i] < 0.02) continue; live++;
  const u = flat.positions[i*3], v = flat.positions[i*3+1];
  if(u >= 0 && u <= 1 && v >= 0 && v <= 1) inFrame++; }
ok(finite(flat.positions) && inFrame === live, 'projected to uv, every live point lands in frame', inFrame + '/' + live);
const mo = U.morph(U.PRESETS['Shell rings'], Object.assign({}, U.PRESETS['Carved torus'], { rows: 40, cols: 36 }), 0.5, 1, null);
ok(mo.frame.type === 'points' && mo.frame.version >= 1 && X.isPoints(mo.frame), 'morph output is a typed points value too');

section('throughput');
const big = U.generate(Object.assign({}, spec, { rows: 120, cols: 140 }), 0, null, null);
let nb = null, pj = null, pkk = null;
const t0 = Date.now();
for(let k = 0; k < 50; k++){
  nb = X.normalize3d(big, [0,0,0], 1/200, nb);
  pj = X.project(nb, view, pj);
  pkk = X.packVolume(nb, 0.02, pkk);
}
const ms = (Date.now() - t0) / 50;
console.log('  info  normalise + project + pack of ' + big.count.toLocaleString() + ' points: ' + ms.toFixed(2) + ' ms');
ok(ms < 8, 'the transport layer costs a small fraction of a frame');

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures ? 1 : 0);
