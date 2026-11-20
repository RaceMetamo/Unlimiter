/* ============================================================
   unlimiter-music.js — The Unlimiter composer (schemaVersion 1)

   The musical twin of unlimiter-points.js. No DOM, no Web Audio, no
   MIDI hardware — it answers one question:

       given a moment in a loop and a set of parameters, which notes
       happen, on which part, how hard and for how long?

   Everything is deterministic: the same params, seed and step give
   byte-identical events, so a pattern can be auditioned, exported
   as a .mid file, or rebuilt on another machine.

   Where the music comes from (the same vocabulary as the visuals):

     drums   euclid(k, 16) as the skeleton; a 3D value-noise field,
             evolving slowly in time, adds ghost hits and removes hits
             — the "carve" idea from Manifold, applied to a step grid
     melody  a Manifold points frame IS the score. A "lens" reads it:
             one axis is time, one axis is pitch, a third is velocity.
             Lead, bass and pad look at the same geometry through
             different lenses, so they stay related but never identical
     pad     the points in each bar vote for a chord degree

   Load before any tool script. Browser global + CommonJS export,
   same pattern as unlimiter-points.js.
   ============================================================ */
const UnlimiterMusic = (() => {
"use strict";

const SCHEMA_VERSION = 1;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* ============================================================
   1 · pitch vocabulary
   ============================================================ */
const SCALES = {
  "Minor pentatonic": [0, 3, 5, 7, 10],
  "Aeolian":          [0, 2, 3, 5, 7, 8, 10],
  "Dorian":           [0, 2, 3, 5, 7, 9, 10],
  "Phrygian":         [0, 1, 3, 5, 7, 8, 10],
  "Lydian":           [0, 2, 4, 6, 7, 9, 11],
  "Harmonic minor":   [0, 2, 3, 5, 7, 8, 11],
  "Hirajoshi":        [0, 2, 3, 7, 8],
  "In-sen":           [0, 1, 5, 7, 10],
  "Hijaz":            [0, 1, 4, 5, 7, 8, 10],
  "Whole tone":       [0, 2, 4, 6, 8, 10],
  "Chromatic":        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

/** Scale degree (any integer, negative allowed) → MIDI note.
 *  degree 0 = the root in `octave` (MIDI octave number, C4 = 60 = octave 4). */
function degreeToMidi(degree, root, scaleName, octave){
  const sc = SCALES[scaleName] || SCALES["Minor pentatonic"];
  const n = sc.length;
  const d = Math.floor(degree);
  const oct = Math.floor(d / n);
  const idx = ((d % n) + n) % n;
  return (octave + 1) * 12 + (Math.round(root) % 12 + 12) % 12 + sc[idx] + oct * 12;
}
function scaleSize(scaleName){ return (SCALES[scaleName] || SCALES["Minor pentatonic"]).length; }

/* ============================================================
   2 · small deterministic primitives
   ============================================================ */
function hash3(x, y, z){
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
const fade = t => t * t * (3 - 2 * t);
/** 3D value noise, 0..1. Third axis is time, so a pattern evolves instead of sliding. */
function noise3(x, y, z){
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return l(l(l(c(0,0,0), c(1,0,0), xf), l(c(0,1,0), c(1,1,0), xf), yf),
           l(l(c(0,0,1), c(1,0,1), xf), l(c(0,1,1), c(1,1,1), xf), yf), zf);
}
function mulberry32(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Euclidean rhythm (evenly spread hits, first on the downbeat); returns Uint8Array(n). */
function euclid(k, n, rot){
  n = Math.max(1, n | 0); k = clamp(Math.round(k), 0, n);
  const out = new Uint8Array(n);
  for(let i = 0; i < n; i++){
    const j = ((i - (rot | 0)) % n + n) % n;
    out[i] = (j * k) % n < k ? 1 : 0;   // hit 0 always lands on j = 0
  }
  return out;
}

/* ============================================================
   3 · parameters — one list, every consumer builds from it
   ============================================================ */
const P = (key, label, min, max, step, def, extra) =>
  Object.assign({ key, label, min, max, step, def }, extra || {});

const PARTS = ["kick", "clap", "hat", "perc", "bass", "lead", "pad"];
const DRUMS = ["kick", "clap", "hat", "perc"];

const PARAMS = [
  // Transport
  P("swing",    "Swing",        0, 0.5, 0.01, 0.12, { group: "Transport" }),
  P("humanize", "Humanize",     0, 1,   0.01, 0.2,  { group: "Transport" }),
  P("master",   "Master",       0, 1,   0.01, 0.8,  { group: "Transport" }),
  P("seed",     "Seed",         0, 9999, 1,   7,    { group: "Transport", noMod: true }),
  // Harmony
  P("root",     "Root note",    0, 11,  1,    9,    { group: "Harmony" }),
  // Geometry — the score
  P("geoDrift", "Evolve rate",  0, 2,   0.01, 0.2,  { group: "Geometry" }),
  P("geoNoise", "Noise warp",   0, 80,  1,    18,   { group: "Geometry" }),
  P("geoRipple","Ripple",       0, 80,  1,    0,    { group: "Geometry" }),
  P("presLow",  "Carve low",    0.2, 0.7, 0.01, 0.40, { group: "Geometry" }),
  P("presHigh", "Carve high",   0.3, 0.95, 0.01, 0.62, { group: "Geometry" }),
  P("rows",     "Rows",         6, 60,  1,    24,   { group: "Geometry", noMod: true }),
  P("cols",     "Columns",      6, 80,  1,    36,   { group: "Geometry", noMod: true }),
  P("shells",   "Shells",       1, 6,   1,    2,    { group: "Geometry", noMod: true }),
  // Drums
  P("kickK",  "Hits",   0, 16, 1, 4,   { group: "Kick" }),
  P("kickRot","Rotate", 0, 15, 1, 0,   { group: "Kick" }),
  P("kickChaos","Chaos",0, 1, 0.01, 0.1, { group: "Kick" }),
  P("kickLevel","Level",0, 1, 0.01, 0.9, { group: "Kick" }),
  P("kickTune", "Tune (Hz)", 30, 80, 0.5, 48, { group: "Kick" }),
  P("kickDecay","Decay (s)", 0.1, 1.2, 0.01, 0.42, { group: "Kick" }),
  P("kickPunch","Punch",0, 1, 0.01, 0.6, { group: "Kick" }),
  P("clapK",  "Hits",   0, 16, 1, 2,   { group: "Clap" }),
  P("clapRot","Rotate", 0, 15, 1, 4,   { group: "Clap" }),
  P("clapChaos","Chaos",0, 1, 0.01, 0.2, { group: "Clap" }),
  P("clapLevel","Level",0, 1, 0.01, 0.55, { group: "Clap" }),
  P("clapTone", "Tone (Hz)", 600, 4000, 10, 1500, { group: "Clap" }),
  P("clapDecay","Decay (s)", 0.05, 0.8, 0.01, 0.22, { group: "Clap" }),
  P("hatK",   "Hits",   0, 16, 1, 7,   { group: "Hat" }),
  P("hatRot", "Rotate", 0, 15, 1, 1,   { group: "Hat" }),
  P("hatChaos","Chaos", 0, 1, 0.01, 0.35, { group: "Hat" }),
  P("hatLevel","Level", 0, 1, 0.01, 0.4, { group: "Hat" }),
  P("hatTone","Tone (Hz)", 4000, 14000, 50, 8500, { group: "Hat" }),
  P("hatDecay","Decay (s)", 0.015, 0.4, 0.005, 0.05, { group: "Hat" }),
  P("percK",  "Hits",   0, 16, 1, 5,   { group: "Perc" }),
  P("percRot","Rotate", 0, 15, 1, 2,   { group: "Perc" }),
  P("percChaos","Chaos",0, 1, 0.01, 0.4, { group: "Perc" }),
  P("percLevel","Level",0, 1, 0.01, 0.35, { group: "Perc" }),
  P("percOct","Octave", 2, 6, 1, 4,    { group: "Perc" }),
  P("percDecay","Decay (s)", 0.03, 0.6, 0.01, 0.12, { group: "Perc" }),
  // Bass — a lens on the geometry
  P("bassLevel","Level",0, 1, 0.01, 0.7, { group: "Bass" }),
  P("bassOct",  "Octave",1, 3, 1, 2, { group: "Bass" }),
  P("bassSpan", "Span (oct)", 0.5, 3, 0.25, 1, { group: "Bass" }),
  P("bassDensity","Density",0, 1, 0.01, 0.55, { group: "Bass" }),
  P("bassGate", "Gate (steps)", 0.25, 4, 0.05, 0.9, { group: "Bass" }),
  P("bassCut",  "Cutoff (Hz)", 60, 3000, 1, 340, { group: "Bass", log: true }),
  P("bassRes",  "Resonance", 0, 1, 0.01, 0.45, { group: "Bass" }),
  P("bassEnv",  "Filter env", 0, 1, 0.01, 0.55, { group: "Bass" }),
  // Lead
  P("leadLevel","Level",0, 1, 0.01, 0.5, { group: "Lead" }),
  P("leadOct",  "Octave",3, 6, 1, 4, { group: "Lead" }),
  P("leadSpan", "Span (oct)", 0.5, 4, 0.25, 2, { group: "Lead" }),
  P("leadDensity","Density",0, 1, 0.01, 0.45, { group: "Lead" }),
  P("leadGate", "Gate (steps)", 0.25, 6, 0.05, 1.2, { group: "Lead" }),
  P("leadCut",  "Cutoff (Hz)", 300, 12000, 1, 3200, { group: "Lead", log: true }),
  P("leadRes",  "Resonance", 0, 1, 0.01, 0.2, { group: "Lead" }),
  P("leadDetune","Detune (cents)", 0, 50, 0.5, 9, { group: "Lead" }),
  P("leadFM",   "FM amount", 0, 1, 0.01, 0.35, { group: "Lead" }),
  // Pad
  P("padLevel", "Level",0, 1, 0.01, 0.35, { group: "Pad" }),
  P("padOct",   "Octave",2, 5, 1, 3, { group: "Pad" }),
  P("padCut",   "Cutoff (Hz)", 200, 8000, 1, 1400, { group: "Pad", log: true }),
  P("padAttack","Attack (s)", 0.02, 3, 0.01, 0.6, { group: "Pad" }),
  P("padRelease","Release (s)", 0.1, 5, 0.01, 1.4, { group: "Pad" }),
  P("padSpread","Detune (cents)", 0, 40, 0.5, 14, { group: "Pad" }),
  // Space
  P("delayMix", "Delay mix", 0, 1, 0.01, 0.25, { group: "Space" }),
  P("delayFb",  "Delay feedback", 0, 0.92, 0.01, 0.5, { group: "Space" }),
  P("delayTone","Delay tone (Hz)", 400, 9000, 10, 3200, { group: "Space", log: true }),
  P("verbMix",  "Reverb mix", 0, 1, 0.01, 0.3, { group: "Space" }),
  P("verbSize", "Reverb size (s)", 0.5, 6, 0.1, 2.6, { group: "Space", noMod: true })
];

/** Choices that are not numbers: dice flips them, presets save them. */
const SWITCHES = [
  { key: "scale",     label: "Scale",        group: "Harmony",  def: "Minor pentatonic", options: Object.keys(SCALES) },
  { key: "surface",   label: "Form",         group: "Geometry", def: "torus",
    options: ["sphere", "torus", "supershape", "mobius", "saddle", "cylinder", "disc"] },
  { key: "placement", label: "Placement",    group: "Geometry", def: "grid",
    options: ["grid", "rings", "fibonacci", "jitter"] },
  { key: "bassTime",  label: "Bass time axis",  group: "Bass", def: "x",      options: ["x", "y", "z", "angle"] },
  { key: "bassPitch", label: "Bass pitch axis", group: "Bass", def: "z",      options: ["x", "y", "z", "radius"] },
  { key: "leadSteps", label: "Lead loop (steps)", group: "Lead", def: "32",   options: ["16", "32", "64"] },
  { key: "leadTime",  label: "Lead time axis",  group: "Lead", def: "angle",  options: ["x", "y", "z", "angle"] },
  { key: "leadPitch", label: "Lead pitch axis", group: "Lead", def: "y",      options: ["x", "y", "z", "radius"] },
  { key: "leadWave",  label: "Lead voice",   group: "Lead", def: "saw",       options: ["saw", "square", "fm", "pluck"] },
  { key: "delayDiv",  label: "Delay time",   group: "Space", def: "3/16",     options: ["1/16", "1/8", "3/16", "1/4"] }
];

function defaults(){
  const o = {};
  PARAMS.forEach(p => { o[p.key] = p.def; });
  SWITCHES.forEach(s => { o[s.key] = s.def; });
  return o;
}

/* ============================================================
   4 · drums — euclid skeleton + an evolving noise carve
   ============================================================ */
const DRUM_IDX = { kick: 0, clap: 1, hat: 2, perc: 3 };

/** The velocity of a drum hit at `step` of `bar` (0 = none). Pure. */
function drumHit(part, step, bar, Q){
  const idx = DRUM_IDX[part];
  const k = Q[part + "K"], rot = Q[part + "Rot"], chaos = Q[part + "Chaos"];
  const seed = Q.seed | 0;
  const base = euclid(k, 16, rot)[step & 15];
  // slow field: moves a little every bar, differs per part and per step
  const field = noise3(step * 0.43 + seed * 7.13, idx * 5.7 + 1.3, bar * 0.19 + seed * 0.37);
  const field2 = noise3(step * 0.91 + 40 + seed * 3.1, idx * 3.3, bar * 0.31);
  let vel = 0;
  if(base){
    if(field2 < chaos * 0.28) return 0;                 // dropped hit
    vel = (step & 3) === 0 ? 1 : (step & 1) ? 0.62 : 0.8;
    vel *= 0.85 + 0.15 * field;
  } else if(field > 1 - chaos * 0.32 && part !== "kick"){
    vel = 0.22 + 0.25 * field2;                         // ghost
  } else if(field > 1 - chaos * 0.12 && part === "kick"){
    vel = 0.45;                                         // rare kick ghost
  }
  return vel;
}

/* ============================================================
   5 · the lens — a points frame read as a score
   ============================================================ */
function axisValue(frame, i, axis){
  const p = frame.positions;
  switch(axis){
    case "x": return p[i * 3];
    case "y": return p[i * 3 + 1];
    case "z": return p[i * 3 + 2];
    case "angle": return Math.atan2(p[i * 3 + 2], p[i * 3]);
    case "radius": return Math.hypot(p[i * 3], p[i * 3 + 2]);
  }
  return 0;
}
function thirdAxis(a, b){
  for(const c of ["y", "z", "x"]) if(c !== a && c !== b) return c;
  return "y";
}
/**
 * Read a frame through a lens.
 *   L = { timeAxis, pitchAxis, steps, density, poly, cutoff, span }
 * Returns { steps, grid, u, v, w, kept, n } where grid[s] is a list of
 * { deg, vel, idx, pres, hue } sorted loud-first, and u/v/w are per-point
 * time / pitch / velocity (0..1) — for drawing the score.
 * Bounds are normalised per axis over the whole frame, so any surface works.
 */
function lens(frame, L, out){
  const n = frame ? frame.count | 0 : 0;
  const steps = L.steps | 0;
  out = out || {};
  out.steps = steps; out.n = n;
  out.grid = new Array(steps);
  for(let s = 0; s < steps; s++) out.grid[s] = [];
  if(n < 1) return out;
  if(!out.u || out.u.length < n){
    out.u = new Float32Array(n); out.v = new Float32Array(n);
    out.w = new Float32Array(n); out.kept = new Uint8Array(n);
  }
  const ta = L.timeAxis, pa = L.pitchAxis, va = thirdAxis(ta, pa);
  const range = axis => {
    let lo = Infinity, hi = -Infinity;
    for(let i = 0; i < n; i++){
      const p = frame.presence ? frame.presence[i] : 1;
      if(p < L.cutoff) continue;
      const v = axisValue(frame, i, axis);
      if(v < lo) lo = v; if(v > hi) hi = v;
    }
    if(!(hi > lo)){ lo = 0; hi = 1; }
    return [lo, hi - lo];
  };
  const rt = range(ta), rp = range(pa), rv = range(va);
  const poly = Math.max(1, L.poly | 0);
  const npc = L.scaleSize;
  const totalDegrees = Math.max(1, Math.round(L.span * npc));
  for(let i = 0; i < n; i++){
    out.kept[i] = 0;
    const pres = frame.presence ? frame.presence[i] : 1;
    const u = clamp((axisValue(frame, i, ta) - rt[0]) / rt[1], 0, 0.999999);
    const v = clamp((axisValue(frame, i, pa) - rp[0]) / rp[1], 0, 1);
    const w = clamp((axisValue(frame, i, va) - rv[0]) / rv[1], 0, 1);
    out.u[i] = u; out.v[i] = v; out.w[i] = w;
    if(pres < L.cutoff) continue;
    const s = Math.floor(u * steps);
    const cell = out.grid[s];
    const hue = frame.colors ? frame.colors[i * 3] : 0.5;
    const strength = pres * (0.5 + 0.5 * w);
    const note = { deg: Math.round(v * totalDegrees), vel: 0.35 + 0.65 * w, idx: i, pres: strength, hue };
    // keep the `poly` strongest; one note per distinct degree
    if(cell.some(c => c.deg === note.deg)) continue;
    if(cell.length < poly) cell.push(note);
    else {
      let wi = 0;
      for(let c = 1; c < cell.length; c++) if(cell[c].pres < cell[wi].pres) wi = c;
      if(cell[wi].pres < note.pres) cell[wi] = note;
    }
  }
  // thin to the requested density. Windows of four steps (one beat on a 16th
  // grid) each keep their strongest notes, so thinning spreads across the loop
  // instead of leaving one loud half and one silent half.
  const dens = clamp(L.density, 0, 1);
  for(let w0 = 0; w0 < steps; w0 += 4){
    const occ = [];
    for(let s = w0; s < Math.min(steps, w0 + 4); s++) if(out.grid[s].length){
      out.grid[s].sort((a, b) => b.pres - a.pres);
      occ.push([s, out.grid[s][0].pres]);
    }
    const keepN = Math.min(occ.length, Math.max(0, Math.ceil(dens * 4 - 0.25)));
    occ.sort((a, b) => b[1] - a[1]);
    for(let k = keepN; k < occ.length; k++) out.grid[occ[k][0]] = [];
  }
  for(let s = 0; s < steps; s++) for(const nt of out.grid[s]) out.kept[nt.idx] = 1;
  return out;
}

/* ============================================================
   6 · the composer — params + clock in, events out
   ============================================================ */
function geometrySpec(Q){
  const rows = Math.round(Q.rows), cols = Math.round(Q.cols);
  return {
    surface: Q.surface, shells: Math.round(Q.shells),
    distribution: Q.placement,
    rows, cols,
    modifiers: [
      { type: "noise",  params: { amount: Q.geoNoise, scale: 2.4, speed: 0.4 } },
      { type: "ripple", params: { amount: Q.geoRipple, cycles: 4, speed: 0.6 }, on: Q.geoRipple > 0.5 }
    ],
    presence: "field",
    presenceParams: { scale: 3.2, low: Math.min(Q.presLow, Q.presHigh - 0.02), high: Q.presHigh, evolve: 0.3 },
    colour: "spectrum", colourParams: { hue: 200, range: 220, sat: 0.7 },
    sizeMin: 3, sizeMax: 3
  };
}

/**
 * createComposer({ points: UnlimiterPoints })
 *   .refresh(Q, tGeo, external)  once per bar: (re)build the score from the geometry
 *   .step(Q, absStep)            events for one 16th: [{part, midi, vel, dur, ...}]
 * `external` is an optional points frame (a Rack cable) used instead of the
 * internal generator — any space, any count.
 */
function createComposer(opts){
  const PTS = opts && opts.points;
  let frame = null;
  const C = {
    frame: null, source: "internal",
    lead: null, bass: null, pad: null,
    padChords: [], leadSteps: 32,
    refresh(Q, tGeo, external){
      if(external && (external.count | 0) > 0){
        this.frame = external; this.source = "points in";
      } else {
        if(!PTS) throw new Error("createComposer: needs UnlimiterPoints to generate a score");
        frame = PTS.generate(geometrySpec(Q), tGeo, frame, null);
        this.frame = frame; this.source = "generated";
      }
      const sz = scaleSize(Q.scale);
      this.leadSteps = parseInt(Q.leadSteps, 10) || 32;
      this.lead = lens(this.frame, { timeAxis: Q.leadTime, pitchAxis: Q.leadPitch, steps: this.leadSteps,
        density: Q.leadDensity, poly: 1, cutoff: 0.3, span: Q.leadSpan, scaleSize: sz }, this.lead);
      this.bass = lens(this.frame, { timeAxis: Q.bassTime, pitchAxis: Q.bassPitch, steps: 16,
        density: Q.bassDensity, poly: 1, cutoff: 0.3, span: Q.bassSpan, scaleSize: sz }, this.bass);
      // pad: four bar-sized bins; the strongest notes of each bin make the chord
      this.pad = lens(this.frame, { timeAxis: Q.leadTime, pitchAxis: "y", steps: 4,
        density: 1, poly: 1, cutoff: 0.3, span: 1, scaleSize: sz }, this.pad);
      return this;
    },
    /** Events for 16th-note `absStep` (0 = the start of bar 0). */
    step(Q, absStep){
      const ev = [];
      const step = ((absStep % 16) + 16) % 16;
      const bar = Math.floor(absStep / 16);
      const sc = Q.scale, root = Q.root;

      // drums
      DRUMS.forEach(part => {
        if(!(Q[part + "Level"] > 0)) return;
        const vel = drumHit(part, step, bar, Q);
        if(vel <= 0) return;
        const e = { part, step, vel, dur: 0.25 };
        if(part === "perc"){
          const f = noise3(step * 0.6 + Q.seed, 9.1, bar * 0.13);
          e.midi = degreeToMidi(Math.floor(f * scaleSize(sc) * 2), root, sc, Math.round(Q.percOct));
        }
        if(part === "hat") e.open = (step & 3) === 2 && noise3(step, bar * 0.2, Q.seed) > 0.55;
        ev.push(e);
      });

      // bass — lens on the geometry, 16 steps per bar
      if(Q.bassLevel > 0 && this.bass){
        const cell = this.bass.grid[step];
        if(cell && cell.length){
          const nt = cell[0];
          ev.push({ part: "bass", step, vel: nt.vel, dur: Q.bassGate * 0.25, hue: nt.hue,
            midi: degreeToMidi(nt.deg, root, sc, Math.round(Q.bassOct)), idx: nt.idx });
        }
      }
      // lead — lens loop of 16/32/64 steps
      if(Q.leadLevel > 0 && this.lead){
        const ls = ((absStep % this.leadSteps) + this.leadSteps) % this.leadSteps;
        const cell = this.lead.grid[ls];
        if(cell && cell.length){
          const nt = cell[0];
          ev.push({ part: "lead", step, vel: nt.vel, dur: Q.leadGate * 0.25, hue: nt.hue,
            midi: degreeToMidi(nt.deg, root, sc, Math.round(Q.leadOct)), idx: nt.idx });
        }
      }
      // pad — a chord on the downbeat of each bar, degree voted by that bin
      if(Q.padLevel > 0 && this.pad && step === 0){
        const bin = this.pad.grid[((bar % 4) + 4) % 4];
        const d = bin && bin.length ? bin[0].deg : 0;
        const o = Math.round(Q.padOct);
        const tones = [d, d + 2, d + 4, d + 6].map(x => degreeToMidi(x, root, sc, o));
        ev.push({ part: "pad", step, vel: 0.7, dur: 4, notes: tones, midi: tones[0] });
      }
      return ev;
    }
  };
  return C;
}

/* ============================================================
   7 · Standard MIDI File export
   ============================================================ */
function vlq(n){
  const b = [n & 0x7f];
  while((n >>= 7) > 0) b.unshift((n & 0x7f) | 0x80);
  return b;
}
const be32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = n => [(n >>> 8) & 255, n & 255];

/**
 * events: [{ part, beat, dur, midi, vel }]   beat in quarter notes (float)
 * channels: { part: 0..15 }
 * Returns a Uint8Array: format 1, a tempo track plus one track per part.
 */
function toMidiFile(events, bpm, channels, ppq){
  ppq = ppq || 480; channels = channels || {};
  const tracks = [];
  const tempo = Math.round(60000000 / bpm);
  tracks.push([0, 0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255,
               0, 0xff, 0x58, 4, 4, 2, 24, 8,
               0, 0xff, 0x2f, 0]);
  PARTS.forEach((part, pi) => {
    const mine = events.filter(e => e.part === part);
    if(!mine.length) return;
    const ch = (channels[part] != null ? channels[part] : pi) & 15;
    const raw = [];
    mine.forEach(e => {
      const on = Math.round(e.beat * ppq);
      const off = Math.max(on + 1, Math.round((e.beat + e.dur) * ppq));
      const note = clamp(Math.round(e.midi), 0, 127), vel = clamp(Math.round(e.vel * 127), 1, 127);
      raw.push({ t: on, order: 1, d: [0x90 | ch, note, vel] });
      raw.push({ t: off, order: 0, d: [0x80 | ch, note, 0] });
    });
    raw.sort((a, b) => a.t - b.t || a.order - b.order);
    const name = Array.from(part).map(c => c.charCodeAt(0));
    const tr = [0, 0xff, 0x03, name.length].concat(name);
    let last = 0;
    raw.forEach(r => { tr.push(...vlq(r.t - last), ...r.d); last = r.t; });
    tr.push(0, 0xff, 0x2f, 0);
    tracks.push(tr);
  });
  const bytes = [0x4d, 0x54, 0x68, 0x64, ...be32(6), ...be16(1), ...be16(tracks.length), ...be16(ppq)];
  tracks.forEach(tr => bytes.push(0x4d, 0x54, 0x72, 0x6b, ...be32(tr.length), ...tr));
  return Uint8Array.from(bytes);
}

/** Run a composer for `bars` bars with fixed params and return MIDI-ready events. */
function renderEvents(comp, Q, bars, opts){
  opts = opts || {};
  const drumNotes = { kick: 36, clap: 39, hat: 42, perc: 37 };
  const out = [];
  for(let abs = 0; abs < bars * 16; abs++){
    if(abs % 16 === 0) comp.refresh(Q, abs / 16 * Q.geoDrift * (opts.tScale || 1), opts.external);
    comp.step(Q, abs).forEach(e => {
      const beat = abs / 4 + (abs & 1 ? Q.swing * 0.25 : 0);
      const base = { part: e.part, beat, dur: e.dur, vel: e.vel };
      if(e.notes) e.notes.forEach(m => out.push(Object.assign({}, base, { midi: m })));
      else out.push(Object.assign(base, { midi: e.midi != null ? e.midi : drumNotes[e.part] }));
    });
  }
  return out;
}

const api = {
  SCHEMA_VERSION, SCALES, PARTS, DRUMS, PARAMS, SWITCHES,
  defaults, degreeToMidi, scaleSize,
  noise3, hash3, mulberry32, euclid,
  drumHit, lens, geometrySpec, createComposer,
  toMidiFile, renderEvents
};
return api;
})();

if(typeof window !== "undefined") window.UnlimiterMusic = UnlimiterMusic;
if(typeof module !== "undefined" && module.exports) module.exports = UnlimiterMusic;
