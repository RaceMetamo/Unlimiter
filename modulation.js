/* =============================================================================
   modulation.js — shared modulation layer for browser-based AV tools
   v1.1 · classic script (no modules, no build step, works from file://)

   Gives any tool: LFO slots, audio-reactive bands (mic or file), a rail UI,
   and preset serialization. The host tool owns its parameters; this module
   only reads them and returns a modulated copy.

   ---------------------------------------------------------------- USAGE ----
   <script src="modulation.js"></script>

   const mod = new Modulation({
     targets: {
       power: { label: 'Power', span: 1.5, min: 0, max: 12 },
       hue:   { label: 'Hue',   span: 60,  min: 0, max: 360 }
     },
     slots: 4,
     mountLfo:   document.getElementById('lfos'),
     mountAudio: document.getElementById('audio'),
     onChange: () => draw(),                  // called when any control moves
     onStatus: (msg, isErr) => say(msg, isErr)
   });

   function frame(dt){
     mod.tick(dt);                            // advance clock, read audio
     const E = mod.apply(PARAMS);             // modulated copy of your params
     render(E);
   }

   mod.serialize()            -> plain object for your preset JSON
   mod.load(obj)              -> restore
   mod.isModulated('power')   -> true if a slot is driving it
   mod.source('bass')         -> current band value, 0..1 (auto-ranged)
   mod.active                 -> true while audio is running

   ------------------------------------------------------------- TARGETS ----
   span   the +/- swing at depth 1. Set it to a musically useful amount for
          THAT parameter, not to the slider range — small spans are usually
          right, since most visual parameters break well before their maximum.
   min/max optional clamp. Omit for no clamp. Pass a function via `range`
          in the config if your limits change at runtime.

   ---------------------------------------------------------------- STYLE ----
   Inherits these CSS variables if the host defines them, else uses fallbacks:
     --mod-accent  --mod-ink  --mod-dim  --mod-line  --mod-field
   ========================================================================= */

(function (global) {
'use strict';

const WAVES = ['Sine', 'Triangle', 'Sawtooth', 'Square', 'Noise'];
const BANDS = [
  { key: 'level', label: 'Level', lo: 20,   hi: 16000, gain: 1.6 },
  { key: 'bass',  label: 'Bass',  lo: 20,   hi: 250,   gain: 1.0 },
  { key: 'mid',   label: 'Mid',   lo: 250,  hi: 2000,  gain: 1.0 },
  { key: 'high',  label: 'High',  lo: 2000, hi: 8000,  gain: 1.0 }
];
const AUDIO_BASE = 10;               // wave ids >= this select an audio band

const CSS = `
.mod-wrap{--a:var(--mod-accent,#e2a13c);--ink:var(--mod-ink,#e6e4df);
  --dim:var(--mod-dim,#8a8a92);--line:var(--mod-line,#2a2a2f);--field:var(--mod-field,#0c0c0e)}
.mod-wrap label{display:block;margin:0 0 9px}
.mod-lab{display:flex;justify-content:space-between;align-items:baseline;
  font-size:11px;color:var(--dim);margin-bottom:3px}
.mod-lab b{color:var(--ink);font-weight:400;font-variant-numeric:tabular-nums;cursor:text}
.mod-lab b:hover{box-shadow:inset 0 -1px 0 var(--dim)}
.mod-wrap input[type=range]{width:100%;height:16px;-webkit-appearance:none;appearance:none;
  background:none;margin:0}
.mod-wrap input[type=range]::-webkit-slider-runnable-track{height:1px;background:var(--line)}
.mod-wrap input[type=range]::-moz-range-track{height:1px;background:var(--line)}
.mod-wrap input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:9px;height:9px;
  background:var(--a);margin-top:-4px;border-radius:0;cursor:ew-resize}
.mod-wrap input[type=range]::-moz-range-thumb{width:9px;height:9px;background:var(--a);
  border:none;border-radius:0;cursor:ew-resize}
.mod-wrap select,.mod-wrap button,.mod-wrap .mod-file{width:100%;background:var(--field);
  color:var(--ink);border:1px solid var(--line);padding:6px 8px;font:inherit;font-size:12px;
  border-radius:0;cursor:pointer}
.mod-wrap select:hover,.mod-wrap button:hover,.mod-wrap .mod-file:hover{border-color:var(--a)}
.mod-file{display:block;text-align:center;margin-bottom:8px}
.mod-file input{display:none}
.mod-row{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px}
.mod-note{font-size:10px;color:var(--dim);line-height:1.5;margin:-2px 0 10px}
.mod-chk{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--dim);
  margin-bottom:9px;cursor:pointer}
.mod-chk input{accent-color:var(--a)}
.mod-meter{display:flex;align-items:center;gap:7px;margin-bottom:3px}
.mod-meter span{font-size:10px;color:var(--dim);width:34px;letter-spacing:.06em}
.mod-meter i{flex:1;height:5px;background:#0a0a0c;border:1px solid var(--line);display:block}
.mod-meter u{display:block;height:100%;width:0;background:var(--a);text-decoration:none;
  transition:width .04s linear}
.mod-meter:first-child u{opacity:.65}
.mod-meters{margin:2px 0 10px}
details.mod-slot{border:1px solid var(--line);padding:0 8px;margin-bottom:7px}
details.mod-slot.on{border-color:var(--a)}
details.mod-slot>summary{list-style:none;cursor:pointer;user-select:none;padding:7px 0;
  font-size:10px;letter-spacing:.1em;color:var(--dim);display:flex;align-items:center;gap:7px}
details.mod-slot>summary::-webkit-details-marker{display:none}
details.mod-slot>summary::before{content:'\\25B8';font-size:9px;opacity:.65;
  transition:transform .12s ease;display:inline-block}
details.mod-slot[open]>summary::before{transform:rotate(90deg)}
details.mod-slot[open]{padding-bottom:6px}
details.mod-slot.on>summary{color:var(--a)}
.mod-wrap select{margin-bottom:6px}
.mod-edit{width:74px;background:#000;color:var(--a);border:1px solid var(--a);
  font:inherit;font-size:11px;padding:0 3px;text-align:right;border-radius:0}
.mod-edit:focus{outline:none}
`;

let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* Click a readout to type an exact value. Typing outside the slider's range
   widens the range rather than refusing — ranges are conveniences, not limits. */
function makeEditable(b, r, commit) {
  b.addEventListener('click', () => {
    if (b._editing) return;
    b._editing = true;
    const prev = b.textContent;
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'mod-edit'; inp.value = r.value;
    b.textContent = ''; b.appendChild(inp);
    inp.focus(); inp.select();
    const done = ok => {
      if (!b._editing) return;
      b._editing = false;
      b.textContent = prev;
      if (!ok) return;
      const v = parseFloat(String(inp.value).replace(/[^0-9eE+\-.]/g, ''));
      if (!isFinite(v)) return;
      if (v > parseFloat(r.max)) r.max = String(v);
      if (v < parseFloat(r.min)) r.min = String(v);
      commit(v);
    };
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    inp.addEventListener('blur', () => done(true));
  });
}

function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/* ph is in cycles; returns -1..1 */
function waveAt(kind, ph) {
  const t = ph - Math.floor(ph);
  switch (kind) {
    case 0: return Math.sin(t * 2 * Math.PI);
    case 1: return 4 * Math.abs(t - 0.5) - 1;
    case 2: return t * 2 - 1;
    case 3: return t < 0.5 ? 1 : -1;
    default: {                                    // value noise, cubic-smoothed
      const i = Math.floor(ph), f = ph - i, u = f * f * (3 - 2 * f);
      return hash1(i) * (1 - u) + hash1(i + 1) * u;
    }
  }
}

function Modulation(cfg) {
  if (!(this instanceof Modulation)) return new Modulation(cfg);
  injectCSS();

  const self = this;
  const targets = cfg.targets || {};
  const keys = Object.keys(targets);
  if (!keys.length) throw new Error('Modulation: config.targets is empty.');

  const slotCount = cfg.slots || 4;
  const rawOnChange = cfg.onChange || function () {};
  const onChange = function () { if (!booting) rawOnChange(); };
  const onStatus  = cfg.onStatus || function () {};
  const rangeOf   = cfg.range || function (k) {
    const t = targets[k];
    return [t && t.min != null ? t.min : -Infinity,
            t && t.max != null ? t.max :  Infinity];
  };

  /* ---- state ---- */
  let booting = true;            // no host callbacks until construction finishes
  const slots = [];
  for (let i = 0; i < slotCount; i++) {
    const d = (cfg.defaults && cfg.defaults[i]) || {};
    slots.push({
      on:     d.on     || false,
      target: d.target || keys[Math.min(i, keys.length - 1)],
      wave:   d.wave   != null ? d.wave   : 0,
      rate:   d.rate   != null ? d.rate   : 0.0167,   // one cycle per minute
      depth:  d.depth  != null ? d.depth  : 0.25,
      phase:  d.phase  != null ? d.phase  : i * 90
    });
  }

  const bands = { level: 0, bass: 0, mid: 0, high: 0 };
  let clock = 0;
  let gain = cfg.audioGain != null ? cfg.audioGain : 1.6;
  let release = cfg.audioRelease != null ? cfg.audioRelease : 0.12;
  let autoRange = cfg.autoRange !== false;

  /* Raw band energy carries a large constant floor: a steady mix can sit at
     0.75 and swing only 0.25, and it clips at 1.0 on peaks. Fed straight to a
     parameter that reads as a DC offset rather than movement — the band looks
     alive on the meter while the visual barely shifts. This tracks a running
     floor and ceiling per band and rescales the gap to 0..1, so Depth means
     the same thing for an audio source as it does for an LFO. */
  const FLOOR_RISE = 0.25, CEIL_FALL = 0.5, MIN_GAP = 0.02;
  const envs = {};
  function resetEnvs() { for (const B of BANDS) envs[B.key] = { lo: 1, hi: 0 }; }
  resetEnvs();
  function autoScale(key, v, dt) {
    const e = envs[key];
    e.lo = v < e.lo ? v : e.lo + (v - e.lo) * Math.min(1, FLOOR_RISE * dt);
    e.hi = v > e.hi ? v : e.hi + (v - e.hi) * Math.min(1, CEIL_FALL * dt);
    const gap = e.hi - e.lo;
    if (gap < MIN_GAP) return 0;                       // silence, or no dynamics yet
    return Math.min(1, Math.max(0, (v - e.lo) / gap));
  }

  let AC = null, analyser = null, freq = null, micStream = null, mediaNode = null;
  this.active = false;

  /* ---- audio ---- */
  function ensureAnalyser() {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    if (!analyser) {
      analyser = AC.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.55;
      freq = new Uint8Array(analyser.frequencyBinCount);
    }
    return AC;
  }
  function bandAvg(lo, hi) {
    const nyq = AC.sampleRate / 2, n = freq.length;
    const a = Math.max(0, Math.floor(lo / nyq * n));
    const b = Math.min(n - 1, Math.ceil(hi / nyq * n));
    if (b < a) return 0;
    let sum = 0;
    for (let i = a; i <= b; i++) sum += freq[i];
    return sum / (b - a + 1) / 255;
  }

  this.startMic = async function () {
    try {
      ensureAnalyser(); await AC.resume();
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      AC.createMediaStreamSource(micStream).connect(analyser);   // not to output
      self.active = true;
      onStatus('', false);
      if (cfg.onAudioStart) cfg.onAudioStart();
    } catch (e) {
      onStatus('Microphone unavailable: ' + e.message +
        '\nBrowsers only grant mic access over https:// or localhost. Opening this ' +
        'file directly from disk may be blocked — serve the folder locally if so.', true);
    }
  };

  this.playFile = async function (file) {
    try {
      ensureAnalyser(); await AC.resume();
      const a = ui.audioEl;
      a.src = URL.createObjectURL(file);
      a.style.display = 'block';
      if (!mediaNode) mediaNode = AC.createMediaElementSource(a);   // once per element
      mediaNode.connect(analyser);
      analyser.connect(AC.destination);                            // so you can hear it
      await a.play();
      self.active = true;
      onStatus('', false);
      if (cfg.onAudioStart) cfg.onAudioStart();
    } catch (e) {
      onStatus('Could not play that audio file: ' + e.message, true);
    }
  };

  this.stopAudio = function () {
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (mediaNode) { try { mediaNode.disconnect(analyser); } catch (e) {} }
    if (ui.audioEl) ui.audioEl.pause();
    self.active = false;
    resetEnvs();
    for (const k in bands) bands[k] = 0;
    if (ui.meters) for (const k in ui.meters) ui.meters[k].style.width = '0%';
    onStatus('', false);
  };

  /* Returns the analyser node so a host can mux audio into a recording. */
  this.analyserNode = function () { return analyser; };
  this.audioContext = function () { return AC; };

  /* ---- per-frame ---- */
  this.tick = function (dt) {
    clock += dt;
    if (!analyser || !self.active) return;
    analyser.getByteFrequencyData(freq);
    const rel = Math.min(1, dt / Math.max(0.01, release));  // fall rate; rise is instant
    for (const B of BANDS) {
      let v = Math.min(1, bandAvg(B.lo, B.hi) * B.gain * gain);
      if (autoRange) v = autoScale(B.key, v, dt);
      bands[B.key] = v > bands[B.key] ? v : bands[B.key] + (v - bands[B.key]) * rel;
      if (ui.meters && ui.meters[B.key])
        ui.meters[B.key].style.width = (bands[B.key] * 100).toFixed(1) + '%';
    }
  };

  this.source = function (k) { return bands[k] || 0; };
  this.clock  = function () { return clock; };
  this.resetClock = function () { clock = 0; };

  /* Returns a modulated copy of params. Never mutates the original. */
  this.apply = function (params) {
    const E = Object.assign({}, params);
    for (const L of slots) {
      if (!L.on) continue;
      const T = targets[L.target];
      if (!T || !(L.target in E)) continue;
      const s = L.wave >= AUDIO_BASE
        ? bands[BANDS[L.wave - AUDIO_BASE].key]                 // audio: unipolar 0..1
        : waveAt(L.wave, clock * L.rate + L.phase / 360);       // LFO: bipolar -1..1
      const r = rangeOf(L.target);
      const v = E[L.target] + T.span * L.depth * s;
      E[L.target] = Math.min(r[1], Math.max(r[0], v));
    }
    return E;
  };

  this.isModulated = function (key) {
    for (const L of slots) if (L.on && L.target === key) return true;
    return false;
  };
  this.modulatedKeys = function () {
    const out = [];
    for (const L of slots) if (L.on && out.indexOf(L.target) < 0) out.push(L.target);
    return out;
  };

  /* ---- presets ---- */
  this.serialize = function () {
    return {
      gain: gain, release: release, autoRange: autoRange,
      slots: slots.map(L => ({ on: L.on, target: L.target, wave: L.wave,
                               rate: L.rate, depth: L.depth, phase: L.phase }))
    };
  };
  this.load = function (o) {
    if (!o) return;
    if (typeof o.gain === 'number') gain = o.gain;
    if (typeof o.release === 'number') release = o.release;
    if (typeof o.autoRange === 'boolean') { autoRange = o.autoRange; resetEnvs(); }
    const list = Array.isArray(o.slots) ? o.slots : (Array.isArray(o) ? o : []);
    list.forEach((s, i) => { if (slots[i]) Object.assign(slots[i], s); });
    syncAll();
  };

  /* ---- UI ---- */
  const ui = { meters: null, audioEl: null, syncs: [] };

  function slider(id, label, min, max, step, val, fmt, set) {
    const wrap = document.createElement('label');
    wrap.innerHTML = '<span class="mod-lab">' + label + ' <b></b></span>' +
      '<input type="range" min="' + min + '" max="' + max + '" step="' + step + '">';
    const b = wrap.querySelector('b'), r = wrap.querySelector('input');
    r.value = val;
    const show = () => { b.textContent = fmt(parseFloat(r.value)); };
    r.addEventListener('input', () => { set(parseFloat(r.value)); show(); onChange(); });
    makeEditable(b, r, v => { r.value = v; set(v); show(); onChange(); });
    wrap._sync = v => { r.value = v; show(); };
    show();
    return wrap;
  }

  function buildAudio(host) {
    if (!host) return;
    host.classList.add('mod-wrap');
    const row = document.createElement('div');
    row.className = 'mod-row';
    const bMic = document.createElement('button'); bMic.textContent = 'Microphone';
    const bStop = document.createElement('button'); bStop.textContent = 'Stop';
    row.append(bMic, bStop);
    host.appendChild(row);

    const fileLab = document.createElement('label');
    fileLab.className = 'mod-file'; fileLab.tabIndex = 0;
    fileLab.textContent = 'Audio file';
    const fin = document.createElement('input');
    fin.type = 'file'; fin.accept = 'audio/*';
    fileLab.appendChild(fin);
    host.appendChild(fileLab);

    const aud = document.createElement('audio');
    aud.controls = true;
    aud.style.cssText = 'width:100%;height:32px;display:none';
    host.appendChild(aud);
    ui.audioEl = aud;

    const mBox = document.createElement('div');
    mBox.className = 'mod-meters';
    ui.meters = {};
    for (const B of BANDS) {
      const m = document.createElement('div');
      m.className = 'mod-meter';
      m.innerHTML = '<span>' + B.label + '</span><i><u></u></i>';
      mBox.appendChild(m);
      ui.meters[B.key] = m.querySelector('u');
    }
    host.appendChild(mBox);

    const gs = slider('g', 'Gain', 0.2, 6, 0.01, gain, v => v.toFixed(2), v => { gain = v; });
    const rs = slider('r', 'Release', 0.01, 0.6, 0.005, release,
                      v => v.toFixed(3) + 's', v => { release = v; });
    host.append(gs, rs);
    ui.syncs.push(() => { gs._sync(gain); rs._sync(release); });

    const arWrap = document.createElement('label');
    arWrap.className = 'mod-chk';
    arWrap.innerHTML = '<input type="checkbox"> Auto-range bands';
    const arIn = arWrap.querySelector('input');
    arIn.addEventListener('change', e => { autoRange = e.target.checked; resetEnvs(); });
    host.appendChild(arWrap);
    ui.syncs.push(() => { arIn.checked = autoRange; });

    const note = document.createElement('div');
    note.className = 'mod-note';
    note.textContent = 'Bands rise instantly and fall at the Release rate. ' +
      'Audio is unipolar, so it only ever adds to a parameter\'s base value. ' +
      'Auto-range strips the constant floor out of each band so the meter shows ' +
      'movement rather than loudness — turn it off if you want absolute level.';
    host.appendChild(note);

    bMic.addEventListener('click', () => self.startMic());
    bStop.addEventListener('click', () => self.stopAudio());
    fin.addEventListener('change', e => {
      const f = e.target.files[0]; e.target.value = '';
      if (f) self.playFile(f);
    });
    fileLab.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fin.click(); }
    });
  }

  function buildSlots(host) {
    if (!host) return;
    host.classList.add('mod-wrap');
    slots.forEach((L, i) => {
      const d = document.createElement('details');
      d.className = 'mod-slot';

      const sum = document.createElement('summary');
      const ttl = document.createElement('span');
      sum.appendChild(ttl);
      d.appendChild(sum);

      const body = document.createElement('div');

      const chk = document.createElement('label');
      chk.className = 'mod-chk';
      chk.innerHTML = '<input type="checkbox"> Enabled';
      const on = chk.querySelector('input');
      body.appendChild(chk);

      const tg = document.createElement('select');
      tg.innerHTML = keys.map(k =>
        '<option value="' + k + '">' + (targets[k].label || k) + '</option>').join('');
      body.appendChild(tg);

      const wv = document.createElement('select');
      wv.innerHTML =
        '<optgroup label="LFO">' + WAVES.map((w, j) =>
          '<option value="' + j + '">' + w + '</option>').join('') + '</optgroup>' +
        '<optgroup label="Audio">' + BANDS.map((b, j) =>
          '<option value="' + (AUDIO_BASE + j) + '">' + b.label + '</option>').join('') +
        '</optgroup>';
      body.appendChild(wv);

      const rateS = slider('rate', 'Rate', 0.002, 0.4, 0.001, L.rate,
        v => v < 0.017 ? (1 / v).toFixed(0) + 's cycle' : v.toFixed(3) + ' Hz',
        v => { L.rate = v; });
      const depthS = slider('depth', 'Depth', 0, 1, 0.01, L.depth,
        v => (v * 100).toFixed(0) + '%', v => { L.depth = v; });
      const phaseS = slider('phase', 'Phase', 0, 360, 1, L.phase,
        v => v.toFixed(0) + '\u00b0', v => { L.phase = v; });
      body.append(rateS, depthS, phaseS);

      d.appendChild(body);
      host.appendChild(d);

      // Never touches open/closed state — only a summary click can collapse a slot.
      const refresh = () => {
        d.classList.toggle('on', L.on);
        const src = L.wave >= AUDIO_BASE
          ? BANDS[L.wave - AUDIO_BASE].label : WAVES[L.wave];
        const tl = targets[L.target] ? (targets[L.target].label || L.target) : L.target;
        ttl.textContent = 'LFO ' + (i + 1) + (L.on ? ' \u00b7 ' + tl + ' \u2190 ' + src
                                                   : ' \u00b7 off');
        const isAudio = L.wave >= AUDIO_BASE;
        rateS.style.opacity  = isAudio ? 0.35 : 1;   // rate and phase are meaningless
        phaseS.style.opacity = isAudio ? 0.35 : 1;   // when an audio band drives the slot
        onChange();
      };
      on.addEventListener('change', e => { L.on = e.target.checked; refresh(); });
      tg.addEventListener('change', e => { L.target = e.target.value; refresh(); });
      wv.addEventListener('change', e => { L.wave = +e.target.value; refresh(); });
      [rateS, depthS, phaseS].forEach(s =>
        s.querySelector('input').addEventListener('input', refresh));

      ui.syncs.push(() => {
        on.checked = L.on; tg.value = L.target; wv.value = L.wave;
        rateS._sync(L.rate); depthS._sync(L.depth); phaseS._sync(L.phase);
        refresh();
      });
      refresh();
    });
  }

  function syncAll() { ui.syncs.forEach(f => f()); }
  this.sync = syncAll;

  buildAudio(cfg.mountAudio);
  buildSlots(cfg.mountLfo);
  syncAll();
  booting = false;               // host may now be called back safely
}

Modulation.WAVES = WAVES;
Modulation.BANDS = BANDS;
Modulation.version = '1.1';

global.Modulation = Modulation;

})(typeof window !== 'undefined' ? window : this);
