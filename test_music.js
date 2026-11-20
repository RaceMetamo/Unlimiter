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
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
