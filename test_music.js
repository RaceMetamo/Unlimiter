// node test_music.js — headless tests for unlimiter-music.js
const M = require("./unlimiter-music.js");
const PTS = require("./unlimiter-points.js");
let pass = 0, fail = 0;
const ok = (c, m) => { if(c){ pass++; } else { fail++; console.log("FAIL:", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + " got " + JSON.stringify(a));

// pitch
eq(M.degreeToMidi(0, 9, "Aeolian", 3), 57, "A3 root");
eq(M.degreeToMidi(7, 9, "Aeolian", 3), 69, "one octave up at degree 7");
eq(M.degreeToMidi(-1, 9, "Aeolian", 3), 55, "degree -1 is a minor 7th below... G3");
eq(M.degreeToMidi(1, 0, "Minor pentatonic", 4), 63, "C4 + 3 = Eb4");
// euclid
eq(Array.from(M.euclid(4,16,0)), [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], "euclid 4/16");
for(const k of [0,1,3,4,5,7,8,16]) ok(M.euclid(k,16,0).reduce((a,b)=>a+b,0) === k, "euclid hit count " + k);
const e4 = Array.from(M.euclid(4,16,0)); ok(e4.filter((v,i)=>v && i%4===(e4.indexOf(1)%4)).length===4, "euclid 4/16 evenly spaced");
const r = M.euclid(3,8,2), r0 = M.euclid(3,8,0);
ok(r.reduce((a,b)=>a+b)===3 && Array.from(r).join()!==Array.from(r0).join(), "euclid rotation moves hits");
// determinism
const Q = M.defaults();
const a = M.renderEvents(M.createComposer({points:PTS}), Q, 4);
const b = M.renderEvents(M.createComposer({points:PTS}), Q, 4);
eq(a, b, "same params give identical events");
ok(a.length > 40, "4 bars produce a real number of events: " + a.length);
const parts = new Set(a.map(e => e.part));
for(const p of M.PARTS) ok(parts.has(p), "part sounds: " + p);
// seed changes music
const Q2 = Object.assign({}, Q, {seed: 99});
ok(JSON.stringify(M.renderEvents(M.createComposer({points:PTS}), Q2, 4)) !== JSON.stringify(a), "seed changes the music");
// kick four on the floor with no chaos
const Qk = Object.assign({}, Q, {kickChaos: 0});
const kicks = M.renderEvents(M.createComposer({points:PTS}), Qk, 2).filter(e=>e.part==="kick").map(e=>e.beat);
eq(kicks, [0,1,2,3,4,5,6,7], "kick 4/16 chaos 0 = four on the floor");
// notes in range and in scale
const sc = M.SCALES[Q.scale];
a.filter(e => e.part==="lead"||e.part==="bass").forEach(e => {
  ok(e.midi>=12 && e.midi<=120, "midi in range " + e.midi);
  ok(sc.includes(((e.midi - Q.root) % 12 + 12) % 12), "note in scale " + e.midi);
});
// geometry drives melody: evolving time changes lead
const c1 = M.createComposer({points:PTS});
c1.refresh(Q, 0); const g0 = JSON.stringify(c1.lead.grid.map(c=>c.map(n=>n.deg)));
c1.refresh(Q, 5); const g1 = JSON.stringify(c1.lead.grid.map(c=>c.map(n=>n.deg)));
ok(g0 !== g1, "geometry evolution changes the lead line");
// surface changes melody
const Qs = Object.assign({}, Q, {surface:"sphere"}); const c2 = M.createComposer({points:PTS}); c2.refresh(Qs,0);
ok(JSON.stringify(c2.lead.grid.map(c=>c.map(n=>n.deg))) !== g0, "different form, different line");
// density
const Qd = Object.assign({}, Q, {leadDensity: 0.1}); const c3 = M.createComposer({points:PTS}); c3.refresh(Qd,0);
const occ = c => c.lead.grid.filter(x=>x.length).length;
ok(occ(c3) <= occ(c1) && occ(c3) >= 1, "density thins the lead: " + occ(c3) + " <= " + occ(c1));
// external frame (a Rack cable)
const ext = PTS.generate(PTS.PRESETS["Orbit flower"], 0, null, null);
const c4 = M.createComposer({}); c4.refresh(Q, 0, ext);
ok(c4.source === "points in" && occ(c4) > 0, "external points frame becomes the score");
// uv-space frame from another tool
const uv = {type:"points", space:"uv", count:3, positions:new Float32Array([0.1,0.2,0, 0.5,0.8,0.5, 0.9,0.5,-0.5])};
const c5 = M.createComposer({}); c5.refresh(Q, 0, uv); ok(occ(c5) >= 1, "frames without colours/presence still play");
// midi
const mid = M.toMidiFile(M.renderEvents(M.createComposer({points:PTS}), Q, 2), 126);
eq(String.fromCharCode(...mid.slice(0,4)), "MThd", "midi header");
ok(mid[9] === 1 && ((mid[10]<<8)|mid[11]) >= 2, "format 1 with several tracks");
let off = 14, nt = 0; while(off < mid.length){ ok(String.fromCharCode(...mid.slice(off,off+4))==="MTrk","track chunk at "+off); const len=(mid[off+4]<<24)|(mid[off+5]<<16)|(mid[off+6]<<8)|mid[off+7]; off += 8+len; nt++; }
ok(off === mid.length, "chunks tile the file exactly"); ok(nt >= 5, "tracks: " + nt);

// --- v2: euclid synth rhythm, uv scores, wavetables ---
{
  const Qe = Object.assign({}, Q, { leadRhythm: "euclid", leadEK: 5, leadERot: 0, leadLevel: 0.5 });
  const ev = M.renderEvents(M.createComposer({points:PTS}), Qe, 2).filter(e => e.part === "lead");
  const steps = ev.map(e => Math.round((e.beat % 4) * 4));
  const pat = M.euclid(5, 16, 0);
  ok(ev.length === 10, "euclid lead plays exactly 5 hits per bar: " + ev.length);
  ok(steps.every(s => pat[s]), "euclid lead hits land on the pattern");
  const Qp = Object.assign({}, Q, { padRhythm: "euclid", padEK: 3 });
  const pe = M.renderEvents(M.createComposer({points:PTS}), Qp, 1).filter(e => e.part === "pad");
  ok(pe.length === 12, "euclid pad: 3 chords of 4 notes: " + pe.length);
  ok(Math.abs(pe.reduce((a,e)=>a+e.dur,0)/4 - 4) < 1e-9, "euclid pad chords tile the bar");
}
{
  const uv2 = { type:"points", space:"uv", count:2, positions:new Float32Array([0.0,0.95,0, 0.6,0.05,0]) };
  const L = M.lens(uv2, { timeAxis:"x", pitchAxis:"y", steps:16, density:1, poly:1, cutoff:0, span:2, scaleSize:5 });
  ok(L.grid[0].length && L.grid[9].length, "uv frame: x is time across the picture");
  ok(L.grid[9][0].deg > L.grid[0][0].deg, "uv frame: higher on screen = higher pitch");
  const one = { type:"points", space:"uv", count:1, positions:new Float32Array([0.5,0.5,0]) };
  const L1 = M.lens(one, { timeAxis:"x", pitchAxis:"y", steps:16, density:1, poly:1, cutoff:0, span:2, scaleSize:5 });
  ok(L1.grid[8].length === 1 && L1.grid[8][0].deg === 5, "uv frame is not stretched to its own bounds");
}
{
  const saw = M.wavetable(2, 0, 0, 0, 1, "lead"), sq = M.wavetable(3, 0, 0, 0, 1, "lead"), sin = M.wavetable(0, 0, 0, 0, 1, "lead");
  ok(Math.abs(saw[2] - 0.5) < 1e-9 && sq[2] === 0 && Math.abs(sq[3] - 1/3) < 1e-6, "basis spectra");
  ok(sin[1] === 1 && sin[2] === 0, "sine is one partial");
  const mid = M.wavetable(2.5, 0, 0, 0, 1, "lead"); ok(Math.abs(mid[2] - 0.25) < 1e-9, "positions blend neighbours");
  const s0 = M.wavetable(2, 0, 0.8, 0.5, 1, "lead"), s1 = M.wavetable(2, 7, 0.8, 0.5, 1, "lead");
  ok(JSON.stringify(Array.from(s0)) !== JSON.stringify(Array.from(s1)), "shimmer evolves the spectrum over time");
  ok(JSON.stringify(Array.from(M.wavetable(2, 7, 0.8, 0.5, 1, "lead"))) === JSON.stringify(Array.from(s1)), "wavetable is deterministic");
  const Qw = Object.assign({}, Q); const ps = [0,3,6,9,12].map(t => M.wavePos(Qw, "lead", t));
  ok(new Set(ps.map(p => p.toFixed(3))).size > 2 && ps.every(p => p >= 0 && p <= 5), "wave position wanders in range: " + ps.map(p=>p.toFixed(2)));
  const ws = M.waveSamples(saw, 64); ok(Math.max(...ws.map(Math.abs)) > 0.999, "samples normalised");
}
{
  const keys = M.PARAMS.map(p => p.key).concat(M.SWITCHES.map(s => s.key));
  ok(new Set(keys).size === keys.length, "no duplicate parameter keys");
  for(const p of M.PARTS) ok(M.PARAMS.some(x => x.key === p + "Pan") && M.PARAMS.some(x => x.key === p + "Vrb"), "track sends " + p);
  M.PARAMS.forEach(p => ok(p.def >= p.min && p.def <= p.max, "default in range " + p.key));
}

// --- v3: pattern bank, chains, rolls, 3D rotation, depth ---
{
  eq(M.parseChain("A A b Ax2 C*3 Z"), ["A","A","B","A","A","C","C","C"], "chain parsing");
  eq(M.stepsToString(M.parseSteps("x..X..r.")), "x..X..r.........", "steps round-trip");
  const seq = M.newSeq(); seq.chain = "A B"; seq.follow = true;
  seq.pats.A.kick = M.parseSteps("x...x...x...x...");
  seq.pats.B.kick = M.parseSteps("x.x.x.x.x.x.x.x.");
  eq([0,1,2,3].map(b => M.patternAt(seq, b)), ["A","B","A","B"], "chain follows bars");
  seq.follow = false; seq.edit = "B"; ok(M.patternAt(seq, 0) === "B", "follow off: the edited pattern loops");
  seq.follow = true;
  const Qs = Object.assign({}, Q, { kickSrc: "steps", kickChaos: 0, kickRoll: 0, fillEvery: "off" });
  const ev = M.renderEvents(M.createComposer({points:PTS}), Qs, 2, { seq }).filter(e => e.part === "kick").map(e => e.beat);
  eq(ev, [0,1,2,3, 4,4.5,5,5.5,6,6.5,7,7.5], "drawn kick follows the chain A then B");
  // accents and drawn rolls
  seq.pats.A.kick = M.parseSteps("X.......r.......");
  const Qr = Object.assign({}, Qs, { rollRate: "64ths", rollRamp: 0.5 });
  const rk = M.renderEvents(M.createComposer({points:PTS}), Qr, 1, { seq }).filter(e => e.part === "kick");
  ok(rk[0].vel === 1 && rk[0].beat === 0, "accent plays at full velocity");
  eq(rk.slice(1).map(e => e.beat), [2, 2.0625, 2.125, 2.1875], "a drawn roll is 4 64ths across its step");
  ok(rk[1].vel < rk[4].vel, "roll crescendo");
  const Qt = Object.assign({}, Qr, { rollRate: "triplets" });
  ok(M.renderEvents(M.createComposer({points:PTS}), Qt, 1, { seq }).filter(e => e.part === "kick").length === 4, "triplet roll = 3 hits");
}
{
  const Qf = Object.assign({}, Q, { hatRoll: 0, clapRoll: 0, kickRoll: 0, percRoll: 0, fillEvery: "4 bars", rollRate: "32nds", hatChaos: 0, hatK: 16 });
  const ev = M.renderEvents(M.createComposer({points:PTS}), Qf, 4).filter(e => e.part === "hat");
  const perBar = [0,1,2,3].map(b => ev.filter(e => e.beat >= b * 4 && e.beat < b * 4 + 4).length);
  ok(perBar[0] === 16 && perBar[3] > 16, "fills roll only in the 4th bar: " + perBar);
  const Qc = Object.assign({}, Qf, { fillEvery: "off", hatRoll: 1 });
  ok(M.renderEvents(M.createComposer({points:PTS}), Qc, 1).filter(e => e.part === "hat").length > 20, "roll chance adds rolls");
  const Qb = Object.assign({}, Q, { bassRoll: 1, rollRate: "32nds" });
  const bl = M.renderEvents(M.createComposer({points:PTS}), Qb, 1).filter(e => e.part === "bass");
  ok(bl.filter(e => e.dur <= 0.125).length >= 2, "bass ratchets: shorter repeats");
}
{
  const f = { type:"points", space:"3d", count:1, positions:new Float32Array([1,0,0]) };
  const r = M.rotateFrame(f, 0, 90, null);
  ok(Math.abs(r.positions[0]) < 1e-6 && Math.abs(r.positions[2] + 1) < 1e-6, "turn 90° moves +x to -z");
  const r2 = M.rotateFrame({ type:"points", space:"3d", count:1, positions:new Float32Array([0,0,1]) }, 90, 0, null);
  ok(Math.abs(r2.positions[1] - 1) < 1e-6, "tilt 90° lifts +z to +y");
  const c = M.createComposer({points:PTS});
  const Q0 = Object.assign({}, Q, { geoRotX: 0, geoRotY: 0 }); c.refresh(Q0, 0);
  const a = JSON.stringify(c.lead.grid.map(x => x.map(n => n.deg)));
  c.refresh(Q0, 0, null, 70, true);
  ok(JSON.stringify(c.lead.grid.map(x => x.map(n => n.deg))) !== a, "spinning the shape changes the melody");
  ok(c.raw !== c.frame && c.raw.count === c.frame.count, "rotation keeps the raw cloud");
  const uvf = { type:"points", space:"uv", count:2, positions:new Float32Array([0.2,0.2,0, 0.8,0.8,0]) };
  c.refresh(Object.assign({}, Q, { geoRotY: 45 }), 0, uvf); ok(c.frame === uvf, "picture-space scores are not rotated");
}
{
  const Qp = Object.assign({}, Q, { depthTo: "pan" });
  const ev = []; const c = M.createComposer({points:PTS}); c.refresh(Qp, 0);
  for(let s = 0; s < 32; s++) c.step(Qp, s).forEach(e => ev.push(e));
  const leads = ev.filter(e => e.part === "lead");
  ok(leads.length && leads.every(e => e.pan >= -0.9 && e.pan <= 0.9), "depth → pan");
  ok(new Set(leads.map(e => e.pan.toFixed(2))).size > 1, "pan varies with depth");
  const Qo = Object.assign({}, Q, { depthTo: "octave" }); const c2 = M.createComposer({points:PTS}); c2.refresh(Qo, 0);
  const l2 = []; for(let s = 0; s < 32; s++) c2.step(Qo, s).forEach(e => e.part === "lead" && l2.push(e.midi));
  const c3 = M.createComposer({points:PTS}); c3.refresh(Q, 0); const l3 = []; for(let s = 0; s < 32; s++) c3.step(Q, s).forEach(e => e.part === "lead" && l3.push(e.midi));
  ok(l2.some((m, i) => Math.abs(m - l3[i]) === 12), "depth → octave jumps");
}
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
