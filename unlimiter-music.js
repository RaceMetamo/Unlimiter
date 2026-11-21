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
  // Score — where the melody's geometry comes from
  P("fluidStir",  "Auto stir",      0, 1,   0.01, 0.35, { group: "Fluid" }),
  P("fluidSwirl", "Swirl",          0, 1,   0.01, 0.45, { group: "Fluid" }),
  P("fluidFade",  "Hold",           0.9, 0.999, 0.001, 0.985, { group: "Fluid" }),
  P("fluidSpeed", "Flow speed",     0.1, 3, 0.01, 1,    { group: "Fluid" }),
  P("fluidKick",  "Kick push",      0, 1,   0.01, 0.3,  { group: "Fluid" }),
  P("fluidLife",  "Particle life (s)", 1, 30, 0.1, 8,   { group: "Fluid" }),
  P("brush",      "Brush size",     0.01, 0.25, 0.005, 0.06, { group: "Fluid" }),
  P("fluidParticles", "Particles",  50, 3000, 10, 700,  { group: "Fluid", noMod: true }),
  P("pointsStir", "Stir strength",  0, 1,   0.01, 0.5,  { group: "Points in" }),
  // Transport
  P("swing",    "Swing",        0, 0.5, 0.01, 0.12, { group: "Transport" }),
  P("humanize", "Humanize",     0, 1,   0.01, 0.2,  { group: "Transport" }),
  P("master",   "Master",       0, 1,   0.01, 0.8,  { group: "Transport" }),
  P("seed",     "Seed",         0, 9999, 1,   7,    { group: "Transport", noMod: true }),
  // Harmony
  P("root",     "Root note",    0, 11,  1,    9,    { group: "Harmony" }),
  // Geometry — the built-in score
  P("geoDrift", "Evolve rate",  0, 2,   0.01, 0.2,  { group: "Geometry" }),
  P("geoNoise", "Noise warp",   0, 80,  1,    18,   { group: "Geometry" }),
  P("geoRipple","Ripple",       0, 80,  1,    0,    { group: "Geometry" }),
  P("presLow",  "Carve low",    0.2, 0.7, 0.01, 0.40, { group: "Geometry" }),
  P("presHigh", "Carve high",   0.3, 0.95, 0.01, 0.62, { group: "Geometry" }),
  P("rows",     "Rows",         6, 60,  1,    24,   { group: "Geometry", noMod: true }),
  P("cols",     "Columns",      6, 80,  1,    36,   { group: "Geometry", noMod: true }),
  P("shells",   "Shells",       1, 6,   1,    2,    { group: "Geometry", noMod: true }),
  P("geoRotX",  "Tilt (°)",     -90, 90, 1,   20,   { group: "Geometry" }),
  P("geoRotY",  "Turn (°)",     -180, 180, 1, 0,    { group: "Geometry" }),
  P("geoSpin",  "Spin (°/bar)", -90, 90, 0.5, 0,    { group: "Geometry" }),
  // Rolls — drum rolls and synth ratchets
  P("rollRamp", "Roll crescendo", 0, 1, 0.01, 0.6, { group: "Rolls" }),
  P("bassRoll", "Bass ratchet chance", 0, 1, 0.01, 0, { group: "Bass" }),
  P("leadRoll", "Lead ratchet chance", 0, 1, 0.01, 0, { group: "Lead" }),
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
  // Bass — a lens on the score
  P("bassLevel","Level",0, 1, 0.01, 0.7, { group: "Bass" }),
  P("bassOct",  "Octave",1, 3, 1, 2, { group: "Bass" }),
  P("bassSpan", "Span (oct)", 0.5, 3, 0.25, 1, { group: "Bass" }),
  P("bassDensity","Density",0, 1, 0.01, 0.55, { group: "Bass" }),
  P("bassEK",   "Euclid hits", 0, 16, 1, 5, { group: "Bass" }),
  P("bassERot", "Euclid rotate", 0, 15, 1, 1, { group: "Bass" }),
  P("bassGate", "Gate (steps)", 0.25, 4, 0.05, 0.9, { group: "Bass" }),
  P("bassTable","Wave", 0, 5, 0.01, 2.2, { group: "Bass" }),
  P("bassMorph","Wave wander", 0, 2.5, 0.01, 0.5, { group: "Bass" }),
  P("bassRate", "Wander rate", 0, 2, 0.01, 0.12, { group: "Bass" }),
  P("bassShimmer","Shimmer", 0, 1, 0.01, 0.15, { group: "Bass" }),
  P("bassCut",  "Cutoff (Hz)", 60, 3000, 1, 340, { group: "Bass", log: true }),
  P("bassRes",  "Resonance", 0, 1, 0.01, 0.45, { group: "Bass" }),
  P("bassEnv",  "Filter env", 0, 1, 0.01, 0.55, { group: "Bass" }),
  // Lead
  P("leadLevel","Level",0, 1, 0.01, 0.5, { group: "Lead" }),
  P("leadOct",  "Octave",3, 6, 1, 4, { group: "Lead" }),
  P("leadSpan", "Span (oct)", 0.5, 4, 0.25, 2, { group: "Lead" }),
  P("leadDensity","Density",0, 1, 0.01, 0.45, { group: "Lead" }),
  P("leadEK",   "Euclid hits", 0, 16, 1, 7, { group: "Lead" }),
  P("leadERot", "Euclid rotate", 0, 15, 1, 2, { group: "Lead" }),
  P("leadGate", "Gate (steps)", 0.25, 6, 0.05, 1.2, { group: "Lead" }),
  P("leadTable","Wave", 0, 5, 0.01, 2.6, { group: "Lead" }),
  P("leadMorph","Wave wander", 0, 2.5, 0.01, 0.9, { group: "Lead" }),
  P("leadRate", "Wander rate", 0, 2, 0.01, 0.25, { group: "Lead" }),
  P("leadShimmer","Shimmer", 0, 1, 0.01, 0.3, { group: "Lead" }),
  P("leadCut",  "Cutoff (Hz)", 300, 12000, 1, 3200, { group: "Lead", log: true }),
  P("leadRes",  "Resonance", 0, 1, 0.01, 0.2, { group: "Lead" }),
  P("leadDetune","Detune (cents)", 0, 50, 0.5, 9, { group: "Lead" }),
  P("leadFM",   "FM amount", 0, 1, 0.01, 0.35, { group: "Lead" }),
  // Pad
  P("padLevel", "Level",0, 1, 0.01, 0.35, { group: "Pad" }),
  P("padOct",   "Octave",2, 5, 1, 3, { group: "Pad" }),
  P("padEK",    "Euclid hits", 0, 16, 1, 3, { group: "Pad" }),
  P("padERot",  "Euclid rotate", 0, 15, 1, 0, { group: "Pad" }),
  P("padTable", "Wave", 0, 5, 0.01, 3.4, { group: "Pad" }),
  P("padMorph", "Wave wander", 0, 2.5, 0.01, 1.2, { group: "Pad" }),
  P("padRate",  "Wander rate", 0, 2, 0.01, 0.08, { group: "Pad" }),
  P("padShimmer","Shimmer", 0, 1, 0.01, 0.45, { group: "Pad" }),
  P("padCut",   "Cutoff (Hz)", 200, 8000, 1, 1400, { group: "Pad", log: true }),
  P("padAttack","Attack (s)", 0.02, 3, 0.01, 0.6, { group: "Pad" }),
  P("padRelease","Release (s)", 0.1, 5, 0.01, 1.4, { group: "Pad" }),
  P("padSpread","Detune (cents)", 0, 40, 0.5, 14, { group: "Pad" }),
  // Master FX — on the whole mix, returns included
  P("fxCut",    "Filter cutoff (Hz)", 40, 18000, 1, 18000, { group: "FX", log: true }),
  P("fxRes",    "Filter resonance", 0, 1, 0.01, 0.15, { group: "FX" }),
  P("fxDrive",  "Drive", 0, 1, 0.01, 0, { group: "FX" }),
  P("fxCrush",  "Bit crush", 0, 1, 0.01, 0, { group: "FX" }),
  P("fxWidth",  "Stereo width", 0, 1.5, 0.01, 1, { group: "FX" }),
  // Space
  P("delayMix", "Delay return", 0, 1, 0.01, 0.6, { group: "Space" }),
  P("delayFb",  "Delay feedback", 0, 0.92, 0.01, 0.5, { group: "Space" }),
  P("delayTone","Delay tone (Hz)", 400, 9000, 10, 3200, { group: "Space", log: true }),
  P("verbMix",  "Reverb return", 0, 1, 0.01, 0.7, { group: "Space" }),
  P("verbSize", "Reverb size (s)", 0.5, 6, 0.1, 2.6, { group: "Space", noMod: true })
];

/* every track gets pan and its own delay / reverb sends, in its own group */
const TRACK_GROUP = { kick: "Kick", clap: "Clap", hat: "Hat", perc: "Perc", bass: "Bass", lead: "Lead", pad: "Pad" };
const SEND_DEF = { kick:[0,0,0], clap:[0.1,.3,.5], hat:[0.25,.15,.1], perc:[-0.3,.5,.3], bass:[0,0,.02], lead:[-0.1,.6,.4], pad:[0,.3,.7] };
DRUMS.forEach(p => PARAMS.push(P(p + "Roll", "Roll chance", 0, 1, 0.01, 0, { group: TRACK_GROUP[p] })));
PARTS.forEach(p => {
  const g = TRACK_GROUP[p], d = SEND_DEF[p];
  PARAMS.push(P(p + "Pan", "Pan", -1, 1, 0.01, d[0], { group: g }));
  PARAMS.push(P(p + "Dly", "Delay send", 0, 1, 0.01, d[1], { group: g }));
  PARAMS.push(P(p + "Vrb", "Reverb send", 0, 1, 0.01, d[2], { group: g }));
});

/** Choices that are not numbers: dice flips them, presets save them. */
const SWITCHES = [
  { key: "scoreSource", label: "Score from",  group: "Score",    def: "geometry", options: ["geometry", "fluid", "points in"] },
  { key: "pointsUse", label: "Use points to", group: "Points in", def: "stir + drive", options: ["drive only", "stir + drive"] },
  { key: "depthTo",   label: "Depth →", group: "Score", def: "velocity", options: ["velocity", "pan", "cutoff", "octave"] },
  { key: "geoView",   label: "View",         group: "Geometry", def: "3d", options: ["3d", "flat"] },
  { key: "rollRate",  label: "Roll speed",   group: "Rolls", def: "32nds", options: ["32nds", "triplets", "64ths", "mixed"] },
  { key: "fillEvery", label: "Fill every",   group: "Rolls", def: "8 bars", options: ["off", "2 bars", "4 bars", "8 bars", "16 bars"] },
  { key: "scale",     label: "Scale",        group: "Harmony",  def: "Minor pentatonic", options: Object.keys(SCALES) },
  { key: "surface",   label: "Form",         group: "Geometry", def: "torus",
    options: ["sphere", "torus", "supershape", "mobius", "saddle", "cylinder", "disc"] },
  { key: "placement", label: "Placement",    group: "Geometry", def: "grid",
    options: ["grid", "rings", "fibonacci", "jitter"] },
  { key: "bassRhythm",label: "Rhythm",       group: "Bass", def: "score",  options: ["score", "euclid"] },
  { key: "bassTime",  label: "Time axis",    group: "Bass", def: "x",      options: ["x", "y", "z", "angle"] },
  { key: "bassPitch", label: "Pitch axis",   group: "Bass", def: "z",      options: ["x", "y", "z", "radius"] },
  { key: "leadRhythm",label: "Rhythm",       group: "Lead", def: "score",  options: ["score", "euclid"] },
  { key: "leadSteps", label: "Loop (steps)", group: "Lead", def: "32",     options: ["16", "32", "64"] },
  { key: "leadTime",  label: "Time axis",    group: "Lead", def: "angle",  options: ["x", "y", "z", "angle"] },
  { key: "leadPitch", label: "Pitch axis",   group: "Lead", def: "y",      options: ["x", "y", "z", "radius"] },
  { key: "leadVoice", label: "Voice",        group: "Lead", def: "table",  options: ["table", "pluck", "fm"] },
  { key: "padRhythm", label: "Rhythm",       group: "Pad",  def: "bar",    options: ["bar", "euclid"] },
  { key: "kickSrc",   label: "Pattern from", group: "Kick", def: "euclid", options: ["euclid", "steps"] },
  { key: "clapSrc",   label: "Pattern from", group: "Clap", def: "euclid", options: ["euclid", "steps"] },
  { key: "hatSrc",    label: "Pattern from", group: "Hat",  def: "euclid", options: ["euclid", "steps"] },
  { key: "percSrc",   label: "Pattern from", group: "Perc", def: "euclid", options: ["euclid", "steps"] },
  { key: "fxFilter",  label: "Filter",       group: "FX",   def: "off",    options: ["off", "lowpass", "highpass", "bandpass"] },
  { key: "delayDiv",  label: "Delay time",   group: "Space", def: "3/16",  options: ["1/16", "1/8", "3/16", "1/4"] }
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

/* ---- the pattern bank: drawn drum steps, A–H, linked into a chain ----
   A cell is 0 off, 1 hit, 2 accent, 3 roll. Strings make presets readable:
   "." off, "x" hit, "X" accent, "r" roll — "x...x...x...x..." is four on the floor. */
const LETTERS = "ABCDEFGH";
function newSeq(){
  const pats = {};
  for(const L of LETTERS){ pats[L] = {}; DRUMS.forEach(d => { pats[L][d] = new Array(16).fill(0); }); }
  return { pats, chain: "A", follow: true, edit: "A" };
}
function parseSteps(str){
  const out = new Array(16).fill(0), m = { ".": 0, "-": 0, "x": 1, "X": 2, "r": 3, "R": 3 };
  String(str || "").replace(/\s+/g, "").slice(0, 16).split("").forEach((c, i) => { out[i] = m[c] != null ? m[c] : 0; });
  return out;
}
function stepsToString(arr){ return arr.map(v => ".xXr"[v | 0] || ".").join(""); }
/** "A A B Ax2 C*3" → ["A","A","B","A","A","C","C","C"]. Unknown letters are dropped. */
function parseChain(str){
  const out = [];
  String(str || "").toUpperCase().split(/[\s,;|]+/).forEach(tok => {
    const m = tok.match(/^([A-H])(?:[X*×]?(\d+))?$/);
    if(!m) return;
    const n = Math.min(64, Math.max(1, parseInt(m[2] || "1", 10)));
    for(let i = 0; i < n; i++) out.push(m[1]);
  });
  return out;
}
/** The pattern letter that plays in `bar`. */
function patternAt(seq, bar){
  if(!seq) return "A";
  if(!seq.follow) return seq.edit || "A";
  const c = seq._chainStr === seq.chain && seq._chain ? seq._chain : (seq._chain = parseChain(seq.chain), seq._chainStr = seq.chain, seq._chain);
  if(!c.length) return seq.edit || "A";
  return c[((bar % c.length) + c.length) % c.length];
}
function cloneSeq(seq){
  const o = newSeq();
  if(!seq) return o;
  for(const L of LETTERS) DRUMS.forEach(d => { const src = seq.pats && seq.pats[L] && seq.pats[L][d]; if(src) o.pats[L][d] = Array.from(src).map(v => v | 0); });
  o.chain = seq.chain || "A"; o.follow = seq.follow !== false; o.edit = seq.edit || "A";
  return o;
}

const ROLL_N = { "32nds": 2, "triplets": 3, "64ths": 4 };
/** How many sub-hits a roll at this step gets (2–4). */
function rollCount(Q, step, bar, salt){
  const r = Q.rollRate;
  if(ROLL_N[r]) return ROLL_N[r];
  return 2 + Math.floor(hash3(step * 5 + 1, bar * 7 + salt, (Q.seed | 0) + 3) * 3);       // mixed
}
/** Is this step of this bar inside a fill (the last beat of every Nth bar)? */
function inFill(Q, step, bar){
  const n = parseInt(Q.fillEvery, 10);
  return n > 0 && ((bar % n) + n) % n === n - 1 && step >= 12;
}
/** Deterministic roll decision for a track's hit. */
function wantsRoll(Q, chance, step, bar, salt){
  let p = (chance || 0) * (step >= 12 ? 1.4 : step >= 8 ? 1 : 0.6);
  if(salt < 4 && inFill(Q, step, bar)) p += 0.55;           // fills are a drum thing
  return p > 0 && hash3(step * 13 + 7, bar * 31 + salt * 5, (Q.seed | 0) + 11) < p;
}

/**
 * One drum track at `step` of `bar`: { vel, roll, accent } or null.
 * Pure. `seq` (the pattern bank) is used when the track's source is "steps".
 */
function drumNote(part, step, bar, Q, seq){
  const idx = DRUM_IDX[part];
  const chaos = Q[part + "Chaos"], seed = Q.seed | 0;
  let base, cell = 0;
  if(Q[part + "Src"] === "steps" && seq){
    const pat = seq.pats[patternAt(seq, bar)];
    cell = pat && pat[part] ? pat[part][step & 15] | 0 : 0;
    base = cell > 0;
  } else base = !!euclid(Q[part + "K"], 16, Q[part + "Rot"])[step & 15];
  // slow field: moves a little every bar, differs per part and per step
  const field = noise3(step * 0.43 + seed * 7.13, idx * 5.7 + 1.3, bar * 0.19 + seed * 0.37);
  const field2 = noise3(step * 0.91 + 40 + seed * 3.1, idx * 3.3, bar * 0.31);
  let vel = 0, ghost = false;
  if(base){
    if(cell < 2 && field2 < chaos * 0.28) return null;   // dropped hit (drawn accents and rolls always play)
    vel = (step & 3) === 0 ? 1 : (step & 1) ? 0.62 : 0.8;
    vel *= 0.85 + 0.15 * field;
    if(cell === 2) vel = 1;
  } else if(field > 1 - chaos * 0.32 && part !== "kick"){
    vel = 0.22 + 0.25 * field2; ghost = true;           // ghost
  } else if(field > 1 - chaos * 0.12 && part === "kick"){
    vel = 0.45; ghost = true;                           // rare kick ghost
  }
  if(vel <= 0) return null;
  let roll = 0;
  if(!ghost && (cell === 3 || wantsRoll(Q, Q[part + "Roll"], step, bar, idx))) roll = rollCount(Q, step, bar, idx);
  return { vel, roll, accent: cell === 2 };
}
/** The velocity of a drum hit at `step` of `bar` (0 = none). Pure. */
function drumHit(part, step, bar, Q, seq){
  const n = drumNote(part, step, bar, Q, seq);
  return n ? n.vel : 0;
}
/**
 * Spread a rolled event into its sub-hits: [{ off (in 16th steps), ev }].
 * Velocity climbs to the hit (crescendo); synth ratchets shorten to fit.
 */
function expandRoll(ev, Q){
  const n = ev.roll | 0;
  if(n < 2) return [{ off: 0, ev }];
  const ramp = Q.rollRamp != null ? Q.rollRamp : 0.6, out = [];
  for(let k = 0; k < n; k++){
    const e = Object.assign({}, ev, { roll: 0, vel: ev.vel * ((1 - ramp) + ramp * (k + 1) / n) });
    if(!ev.notes && DRUMS.indexOf(ev.part) < 0) e.dur = Math.min(ev.dur, 0.25 / n * 0.85);
    out.push({ off: k / n, ev: e });
  }
  return out;
}

/* ---- 3D: turn the score in space before reading it ---- */
/** Rotate a 3D points frame (tilt about x, then turn about y, degrees) into `out`. */
function rotateFrame(fr, tiltDeg, turnDeg, out){
  const n = fr.count | 0;
  if(!out || out.positions.length < n * 3) out = { type: "points", space: fr.space, positions: new Float32Array(Math.max(3, n * 3)) };
  out.count = n; out.space = fr.space; out.capacity = n;
  out.colors = fr.colors; out.presence = fr.presence; out.sizes = fr.sizes; out.tangents = null;
  out.version = (fr.version || 0) + 1;
  const a = turnDeg * Math.PI / 180, b = tiltDeg * Math.PI / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  const P = fr.positions, O = out.positions;
  for(let i = 0; i < n; i++){
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;            // turn (yaw)
    const y2 = y * cb + z1 * sb, z2 = -y * sb + z1 * cb;           // tilt (pitch): positive leans the top away
    O[i * 3] = x1; O[i * 3 + 1] = y2; O[i * 3 + 2] = z2;
  }
  return out;
}

/* ============================================================
   5 · the lens — a points frame read as a score
   ============================================================ */
function axisValue(frame, i, axis){
  const p = frame.positions;
  if(frame.space === "uv"){                     // u right, v down: pitch goes up the screen
    const u = p[i * 3], v = 1 - p[i * 3 + 1];
    switch(axis){
      case "x": return u;
      case "y": return v;
      case "z": return p[i * 3 + 2];
      case "angle": return Math.atan2(v - 0.5, u - 0.5);
      case "radius": return Math.hypot(u - 0.5, v - 0.5);
    }
    return 0;
  }
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
  const UVR = { x: [0, 1], y: [0, 1], z: [-1, 2], angle: [-Math.PI, TAU], radius: [0, 0.7072] };
  const fixed = frame.space === "uv";             // a picture-space frame keeps its picture: no stretching
  const rt = fixed ? UVR[ta] : range(ta), rp = fixed ? UVR[pa] : range(pa), rv = fixed ? UVR[va] : range(va);
  out.ranges = { t: rt, p: rp, v: rv, axes: [ta, pa, va] };
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
    const note = { deg: Math.round(v * totalDegrees), vel: 0.35 + 0.65 * w, idx: i, pres: strength, hue, w, p: pres };
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
   5b · evolving wavetables
   Six harmonic spectra in a row — sine, triangle, saw, square, vox
   (two formant humps), glass (sparse partials). A position 0..5 blends
   neighbours; a slow seeded noise walks the position ("wander") and
   breathes each harmonic ("shimmer"), so no two notes share a timbre.
   ============================================================ */
const HARMONICS = 48;
const WAVES = ["sine", "triangle", "saw", "square", "vox", "glass"];
const GLASS = { 1: 1, 2: 0.6, 5: 0.5, 9: 0.42, 14: 0.34, 20: 0.28, 27: 0.22, 35: 0.18, 44: 0.14 };
function basisAmp(b, h){
  switch(b){
    case 0: return h === 1 ? 1 : 0;
    case 1: return h & 1 ? ((((h - 1) >> 1) & 1) ? -1 : 1) / (h * h) : 0;
    case 2: return 1 / h;
    case 3: return h & 1 ? 1 / h : 0;
    case 4: return 0.22 / h + Math.exp(-Math.pow((h - 7) / 2.2, 2)) + 0.55 * Math.exp(-Math.pow((h - 17) / 3, 2));
    case 5: return GLASS[h] || 0;
  }
  return 0;
}
const PART_IDX = { kick: 0, clap: 1, hat: 2, perc: 3, bass: 4, lead: 5, pad: 6 };
/** Where `part`'s wave sits at time t (seconds): base position plus a seeded wander. */
function wavePos(Q, part, t){
  const base = +Q[part + "Table"] || 0, m = +Q[part + "Morph"] || 0, r = +Q[part + "Rate"] || 0;
  if(m <= 0) return clamp(base, 0, 5);
  const n = noise3(t * r, PART_IDX[part] * 7.7 + ((Q.seed | 0) % 97) * 0.31, 3.3) * 2 - 1;
  return clamp(base + m * n, 0, 5);
}
/** Harmonic spectrum (sine terms, index 1..HARMONICS) at a wave position and time. */
function wavetable(pos, t, shimmer, rate, seed, part, out){
  out = out || new Float32Array(HARMONICS + 1);
  out.fill(0);
  pos = clamp(pos, 0, 5);
  const i0 = Math.min(4, Math.floor(pos)), f = pos - i0;
  const pid = PART_IDX[part] || 0, tt = t * (0.3 + rate * 2);
  for(let h = 1; h <= HARMONICS; h++){
    let a = basisAmp(i0, h) * (1 - f) + basisAmp(i0 + 1, h) * f;
    if(shimmer > 0 && a !== 0) a *= 1 + shimmer * 1.4 * (noise3(h * 0.53, tt, (seed | 0) * 0.017 + pid * 11) * 2 - 1);
    out[h] = a;
  }
  return out;
}
/** One cycle of a spectrum as samples, peak-normalised — for drawing. */
function waveSamples(spec, n, out){
  out = out || new Float32Array(n);
  let pk = 1e-6;
  for(let i = 0; i < n; i++){
    const x = i / n * TAU; let v = 0;
    for(let h = 1; h < spec.length; h++) if(spec[h]) v += spec[h] * Math.sin(h * x);
    out[i] = v; if(Math.abs(v) > pk) pk = Math.abs(v);
  }
  for(let i = 0; i < n; i++) out[i] /= pk;
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

/** What the score's third axis does to a note. Velocity is the default (the lens already
 *  maps it); the others free velocity to follow the point's strength instead. */
function depthNote(e, nt, Q){
  const to = Q.depthTo, w = nt.w != null ? nt.w : 0.5;
  if(!to || to === "velocity") return e;
  e.vel = 0.55 + 0.4 * (nt.p != null ? nt.p : 1);
  if(to === "pan") e.pan = (w * 2 - 1) * 0.9;
  else if(to === "cutoff") e.cut = 0.3 + 1.6 * w;
  else if(to === "octave") e.midi += w > 0.7 ? 12 : w < 0.3 ? -12 : 0;
  return e;
}

/** A note from a lens grid at index i. gate -1: the grid decides (score rhythm).
 *  gate 0: silence. gate 1: a hit — take the nearest occupied cell, so the euclid
 *  pattern decides when and the score decides what. */
function pickNote(grid, i, gate){
  const n = grid.length;
  if(gate === -1) return grid[i] && grid[i].length ? grid[i][0] : null;
  if(!gate) return null;
  for(let d = 0; d <= n >> 1; d++){
    const a = grid[(i + d) % n], b = grid[((i - d) % n + n) % n];
    if(a && a.length) return a[0];
    if(b && b.length) return b[0];
  }
  return null;
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
    seq: null, raw: null, spin: 0,
    /**
     * refresh(Q, tGeo, external, spinDeg, keepGeometry)
     * spinDeg: extra turn added to Q.geoRotY (the caller accumulates Q.geoSpin).
     * keepGeometry: re-read the last generated cloud (after a rotation) without regenerating it.
     */
    refresh(Q, tGeo, external, spinDeg, keepGeometry){
      let src;
      if(external && (external.count | 0) > 0){
        src = external; this.source = "points in";
      } else {
        if(!PTS) throw new Error("createComposer: needs UnlimiterPoints to generate a score");
        if(!(keepGeometry && frame)) frame = PTS.generate(geometrySpec(Q), tGeo, frame, null);
        src = frame; this.source = "generated";
      }
      this.raw = src; this.spin = spinDeg || 0;
      // a 3D score is turned in space before it is read: what faces you is what plays
      const tilt = +Q.geoRotX || 0, turn = (+Q.geoRotY || 0) + (spinDeg || 0);
      this.frame = src.space !== "uv" && (tilt || turn) ? (this._rot = rotateFrame(src, tilt, turn, this._rot)) : src;
      const sz = scaleSize(Q.scale);
      this.leadSteps = parseInt(Q.leadSteps, 10) || 32;
      const eu = k => Q[k + "Rhythm"] === "euclid";
      this.lead = lens(this.frame, { timeAxis: Q.leadTime, pitchAxis: Q.leadPitch, steps: this.leadSteps,
        density: eu("lead") ? 1 : Q.leadDensity, poly: 1, cutoff: 0.3, span: Q.leadSpan, scaleSize: sz }, this.lead);
      this.bass = lens(this.frame, { timeAxis: Q.bassTime, pitchAxis: Q.bassPitch, steps: 16,
        density: eu("bass") ? 1 : Q.bassDensity, poly: 1, cutoff: 0.3, span: Q.bassSpan, scaleSize: sz }, this.bass);
      // pad: 16 bins; a chord takes the strongest note near its step
      this.pad = lens(this.frame, { timeAxis: Q.leadTime, pitchAxis: "y", steps: 16,
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
        const dn = drumNote(part, step, bar, Q, this.seq);
        if(!dn) return;
        const e = { part, step, vel: dn.vel, dur: 0.25, roll: dn.roll, accent: dn.accent };
        if(part === "perc"){
          const f = noise3(step * 0.6 + Q.seed, 9.1, bar * 0.13);
          e.midi = degreeToMidi(Math.floor(f * scaleSize(sc) * 2), root, sc, Math.round(Q.percOct));
        }
        if(part === "hat") e.open = (step & 3) === 2 && noise3(step, bar * 0.2, Q.seed) > 0.55;
        ev.push(e);
      });

      // bass — lens on the score, 16 steps per bar; or euclid hits pitched by the score
      if(Q.bassLevel > 0 && this.bass){
        const nt = pickNote(this.bass.grid, step, Q.bassRhythm === "euclid" ? euclid(Q.bassEK, 16, Q.bassERot)[step] : -1);
        if(nt) ev.push(depthNote({ part: "bass", step, vel: nt.vel, dur: Q.bassGate * 0.25, hue: nt.hue,
            midi: degreeToMidi(nt.deg, root, sc, Math.round(Q.bassOct)), idx: nt.idx,
            roll: wantsRoll(Q, Q.bassRoll, step, bar, 4) ? rollCount(Q, step, bar, 4) : 0 }, nt, Q));
      }
      // lead — lens loop of 16/32/64 steps
      if(Q.leadLevel > 0 && this.lead){
        const ls = ((absStep % this.leadSteps) + this.leadSteps) % this.leadSteps;
        const nt = pickNote(this.lead.grid, ls, Q.leadRhythm === "euclid" ? euclid(Q.leadEK, 16, Q.leadERot)[step] : -1);
        if(nt) ev.push(depthNote({ part: "lead", step, vel: nt.vel, dur: Q.leadGate * 0.25, hue: nt.hue,
            midi: degreeToMidi(nt.deg, root, sc, Math.round(Q.leadOct)), idx: nt.idx,
            roll: wantsRoll(Q, Q.leadRoll, step, bar, 5) ? rollCount(Q, step, bar, 5) : 0 }, nt, Q));
      }
      // pad — a chord per bar, or on euclid hits held to the next hit
      if(Q.padLevel > 0 && this.pad){
        let dur = 0;
        if(Q.padRhythm === "euclid"){
          const pat = euclid(Q.padEK, 16, Q.padERot);
          if(pat[step]){ let k = 1; while(k < 16 && !pat[(step + k) & 15]) k++; dur = k * 0.25; }
        } else if(step === 0) dur = 4;
        if(dur > 0){
          const nt = pickNote(this.pad.grid, step, 1);
          const d = nt ? nt.deg : 0, o = Math.round(Q.padOct);
          const tones = [d, d + 2, d + 4, d + 6].map(x => degreeToMidi(x, root, sc, o));
          ev.push({ part: "pad", step, vel: 0.7, dur, notes: tones, midi: tones[0] });
        }
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
  if(opts.seq) comp.seq = opts.seq;
  let spin = 0;
  for(let abs = 0; abs < bars * 16; abs++){
    if(abs % 16 === 0) comp.refresh(Q, abs / 16 * Q.geoDrift * (opts.tScale || 1), opts.external, spin);
    spin += (+Q.geoSpin || 0) / 16;
    comp.step(Q, abs).forEach(e0 => expandRoll(e0, Q).forEach(({ off, ev: e }) => {
      const beat = (abs + off) / 4 + (abs & 1 ? Q.swing * 0.25 : 0);
      const base = { part: e.part, beat, dur: e.dur, vel: e.vel };
      if(e.notes) e.notes.forEach(m => out.push(Object.assign({}, base, { midi: m })));
      else out.push(Object.assign(base, { midi: e.midi != null && e.part !== "kick" && e.part !== "clap" && e.part !== "hat" ? e.midi : drumNotes[e.part] }));
    }));
  }
  return out;
}

const api = {
  SCHEMA_VERSION, SCALES, PARTS, DRUMS, PARAMS, SWITCHES,
  defaults, degreeToMidi, scaleSize, TRACK_GROUP,
  HARMONICS, WAVES, wavePos, wavetable, waveSamples, pickNote,
  noise3, hash3, mulberry32, euclid,
  drumHit, drumNote, expandRoll, rollCount, wantsRoll, inFill, lens, axisValue, rotateFrame, depthNote,
  LETTERS, newSeq, cloneSeq, parseSteps, stepsToString, parseChain, patternAt, geometrySpec, createComposer,
  toMidiFile, renderEvents
};
return api;
})();

if(typeof window !== "undefined") window.UnlimiterMusic = UnlimiterMusic;
if(typeof module !== "undefined" && module.exports) module.exports = UnlimiterMusic;
