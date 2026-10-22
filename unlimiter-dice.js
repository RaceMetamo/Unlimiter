/* ============================================================
   unlimiter-dice.js — roll, blend and evolve a tool's parameters

   Drive moves parameters by a signal (audio, LFO, MIDI). Dice moves the
   values underneath: it writes the tool's own base parameters, the same
   ones the sliders write, so a roll looks exactly like someone moving the
   sliders — presets save it, and any Drive modulation still rides on top.

     Roll        pick some (or all) of the parameters you allow and move
                 each a set fraction of the way toward a random value,
                 gliding there over a few seconds
     Evolve      roll again every N seconds or N beats, forever — a show
                 that keeps changing on its own
     Home        evolve around a look you chose instead of wandering off
     Favourites  six slots per tool; click to save, click to glide back;
                 evolve can travel between them
     Undo / Redo every roll and recall is undoable

   A tool hands over its parameter list (usually straight from its Drive
   targets: those are by definition safe to change every frame) and a few
   callbacks:

     const dice = UnlimiterDice.create({
       tool: "ouroboros",
       get: k => P[k], set: (k, v) => { P[k] = v; },
       params: UnlimiterDice.fromDrive(Drive, k => rows[k] && rows[k].querySelector("input[type=range]")),
       refresh: k => bound[k] && bound[k](),          // put a value back on its slider, no side effects
       switches: [{ key:"mirrorMode", label:"Mirror", el: selectElement }],   // optional, off by default
       drive: Drive,                                   // optional: beat-synced evolve
       off: ["exposure"],                              // optional: listed but not in the dice to begin with
       onChange: () => {}, changeMs: 300               // optional: called (throttled) while values move
     });
     dice.mountPanel(container);

   Settings, the parameter selection, home and favourites persist per tool
   in localStorage.
   ============================================================ */
(function(global){
"use strict";

const VERSION = "1.0";
const LS = "unlimiter.dice.";

/* ---------- param list helpers ---------- */
function stepOfEl(el){ const s = el && parseFloat(el.step); return isFinite(s) && s > 0 ? s : 0; }
/* Drive targets are {key:{label,min,max}}; labels are "Group — Label" in most tools */
function fromDrive(Drive, elOf){
  return function(){
    if(!Drive || !Drive.targets) return [];
    const out = [];
    for(const k in Drive.targets){
      const t = Drive.targets[k], el = elOf ? elOf(k) : null;
      out.push(paramFrom(k, t.label || k, el ? parseFloat(el.min) : t.min, el ? parseFloat(el.max) : t.max, stepOfEl(el), el));
    }
    return out;
  };
}
/* the older {key:{label}} target tables (Flow Field Plotter) plus a key → slider id map */
function fromTargets(table, elOf){
  return function(){
    const out = [];
    for(const k in table){
      const el = elOf ? elOf(k) : null; if(!el) continue;
      out.push(paramFrom(k, table[k].label || k, parseFloat(el.min), parseFloat(el.max), stepOfEl(el), el));
    }
    return out;
  };
}
function paramFrom(key, label, min, max, step, el){
  let group = "Parameters", name = label;
  const m = /^(.*?)\s+—\s+(.*)$/.exec(label);
  if(m){ group = m[1]; name = m[2]; }
  else if(el && el.closest){
    // no group in the label: use the panel section the slider sits in
    const d = el.closest("details"), sm = d && d.querySelector("summary");
    if(sm) group = sm.textContent.replace(/\s+/g, " ").trim() || group;
  }
  return { key, label:name, group, min:Number(min), max:Number(max), step:step || 0, el:el || null };
}

/* ---------- small maths ---------- */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const ease = t => t * t * (3 - 2 * t);
function quant(v, p){
  v = clamp(v, Math.min(p.min, p.max), Math.max(p.min, p.max));
  if(p.step > 0){ v = p.min + Math.round((v - p.min) / p.step) * p.step; v = +v.toFixed(6); }
  return v;
}

/* ---------- styles, injected once ---------- */
let styled = false;
function injectStyle(){
  if(styled) return; styled = true;
  const s = document.createElement("style");
  s.textContent = `
  .ud{display:flex;flex-direction:column;gap:6px;font-size:12px}
  .ud *{box-sizing:border-box}
  .ud-row{display:flex;align-items:center;gap:8px;min-height:24px}
  .ud-row > span.l{flex:none;width:96px;color:var(--dim,#8d9490);font-size:11.5px}
  .ud-row > input[type=range]{flex:1;min-width:0}
  .ud-row > b{font-family:var(--mono,ui-monospace,monospace);font-weight:400;font-size:11px;width:44px;text-align:right;flex:none}
  .ud-btns{display:flex;gap:5px}
  .ud-btns button{flex:1}
  .ud button.ud-roll{font-weight:600;font-size:13px}
  .ud button.ud-on{border-color:var(--accent,#7fd1c0);color:var(--accent,#7fd1c0)}
  .ud-slots{display:grid;grid-template-columns:repeat(6,1fr);gap:4px}
  .ud-slots button{padding:5px 0;font-family:var(--mono,ui-monospace,monospace)}
  .ud-slots button.full{border-color:var(--accent,#7fd1c0);color:var(--accent,#7fd1c0)}
  .ud-slots button.last{background:var(--accent,#7fd1c0);color:#121718}
  .ud-note{color:var(--dim,#8d9490);font-size:11px;line-height:1.5}
  .ud-sub{font-weight:600;font-size:11.5px;padding-top:6px;margin-top:2px;border-top:1px solid var(--line,#2e3338)}
  .ud-list{max-height:260px;overflow-y:auto;border:1px solid var(--line,#2e3338);border-radius:3px;padding:4px 6px}
  .ud-list .g{display:flex;align-items:center;gap:6px;font-weight:600;font-size:11px;padding:5px 0 2px;cursor:pointer;color:var(--text,#e8e6e1)}
  .ud-list label{display:flex;align-items:center;gap:6px;font-size:11px;padding:1px 0 1px 10px;color:var(--dim,#8d9490);cursor:pointer}
  .ud-list label.on{color:var(--text,#e8e6e1)}
  .ud-list input[type=checkbox]{width:13px;height:13px;margin:0;flex:none}
  .ud-bar{height:2px;background:var(--line,#2e3338);position:relative;overflow:hidden;border-radius:2px}
  .ud-bar > i{position:absolute;left:0;top:0;bottom:0;background:var(--accent,#7fd1c0);width:0}
  .ud select{flex:1;min-width:0}
  .ud-hidden{display:none !important}`;
  document.head.appendChild(s);
}

/* ============================================================ */
function create(opt){
  const tool = opt.tool || "tool";
  const get = opt.get, set = opt.set;
  const listFn = typeof opt.params === "function" ? opt.params : () => (opt.params || []);
  // a list, or a function returning one (for panels that rebuild their controls)
  const swList = typeof opt.switches === "function" ? opt.switches : () => (opt.switches || []);
  let switches = swList();
  // keys or simple globs ("L*.lOffX") that start unticked, and safe ranges a roll stays inside
  const globRe = g => new RegExp("^" + String(g).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  const offList = (opt.off || []).map(globRe);
  const rangeList = Object.entries(opt.ranges || {}).map(([g, r]) => [globRe(g), r]);
  const offDefault = { has: k => offList.some(re => re.test(k)) };
  const safeRange = p => { for(const [re, r] of rangeList) if(re.test(p.key)) return [Math.max(Math.min(p.min, p.max), r[0]), Math.min(Math.max(p.min, p.max), r[1])]; return [p.min, p.max]; };
  const drive = opt.drive || null;
  const refreshMs = opt.refreshMs || 90;
  const changeMs = opt.changeMs || 0;

  /* persistent state */
  const S = Object.assign({
    amount:0.35, count:0, glide:3, evolve:false, every:12, onBeat:false, beats:16,
    glideShare:0.8, home:null, useHome:true, towards:"random", sel:{}, swSel:{}, slots:[null,null,null,null,null,null]
  }, load());
  // a reload never restarts evolve on its own: a show resumes when someone presses Evolve
  const wasEvolving = !!S.evolve; S.evolve = false;
  function load(){ try{ return JSON.parse(localStorage.getItem(LS + tool) || "{}"); }catch(e){ return {}; } }
  function save(){ try{ localStorage.setItem(LS + tool, JSON.stringify(S)); }catch(e){} }

  let PARAMS = [];
  function params(){ PARAMS = listFn().filter(p => isFinite(p.min) && isFinite(p.max) && p.max !== p.min); return PARAMS; }
  const pByKey = k => PARAMS.find(p => p.key === k);
  const isOn = k => S.sel[k] !== undefined ? !!S.sel[k] : !offDefault.has(k);
  const swOn = k => !!S.swSel[k];

  /* ---------- undo ---------- */
  const undo = [], redo = [];
  function snapshot(){
    switches = swList();
    const o = { v:{}, s:{} };
    PARAMS.forEach(p => { o.v[p.key] = Number(get(p.key)); });
    switches.forEach(w => { if(w.el) o.s[w.key] = w.el.value; });
    return o;
  }
  function pushUndo(){ undo.push(snapshot()); if(undo.length > 40) undo.shift(); redo.length = 0; ui && ui.sync(); }

  /* ---------- the glide ---------- */
  let G = null;            // { t0, dur, items:[{p, from, to, last}] }
  let lastRefresh = 0, lastChange = 0;
  function writeNow(p, v){
    set(p.key, v);
    return v;
  }
  function startGlide(targets, dur){
    const items = [];
    for(const k in targets){
      const p = pByKey(k); if(!p) continue;
      const from = Number(get(k));
      if(!isFinite(from)) continue;
      items.push({ p, from, to:targets[k], last:from });
    }
    if(!items.length) return;
    if(!(dur > 0.02)){
      items.forEach(it => { writeNow(it.p, it.to); refresh(it.p); });
      G = null; changed(true); return;
    }
    G = { t0:performance.now(), dur:dur * 1000, items };
    kick();
  }
  function refresh(p){
    if(opt.refresh) { try{ opt.refresh(p.key); }catch(e){} }
    else if(p.el){
      p.el.value = get(p.key);
      p.el.dispatchEvent(new Event("input", { bubbles:true }));
    }
  }
  function changed(force){
    if(!opt.onChange) return;
    const now = performance.now();
    if(force || now - lastChange >= changeMs){ lastChange = now; try{ opt.onChange(); }catch(e){} }
  }
  function applySwitch(w, value){
    if(!w.el || w.el.value === value) return;
    w.el.value = value;
    w.el.dispatchEvent(new Event("change", { bubbles:true }));
  }

  /* ---------- rolls ---------- */
  function pickKeys(){
    const keys = PARAMS.filter(p => isOn(p.key)).map(p => p.key);
    const n = S.count > 0 ? Math.min(S.count, keys.length) : keys.length;
    for(let i = keys.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]]; }
    return keys.slice(0, n);
  }
  function roll(o){
    o = o || {};
    params();
    pushUndo();
    switches = swList();
    const amt = clamp(o.amount != null ? o.amount : S.amount, 0, 1);
    const base = (o.fromHome && S.home) ? S.home : null;
    const targets = {};
    pickKeys().forEach(k => {
      const p = pByKey(k), cur = Number(get(k));
      const b = base && base.v && isFinite(base.v[k]) ? base.v[k] : cur;
      const sr = safeRange(p), r = sr[0] + Math.random() * (sr[1] - sr[0]);
      targets[k] = quant(b + (r - b) * amt, p);
    });
    // switches flip with a chance that grows with the amount
    switches.forEach(w => {
      if(!swOn(w.key) || !w.el) return;
      if(Math.random() < 0.15 + amt * 0.6){
        const opts = [...w.el.options].map(x => x.value).filter(v => !(w.skip || []).includes(v));
        if(opts.length > 1) applySwitch(w, opts[Math.floor(Math.random() * opts.length)]);
      } else if(base && base.s && base.s[w.key] != null) applySwitch(w, base.s[w.key]);
    });
    startGlide(targets, o.glide != null ? o.glide : S.glide);
    ui && ui.flash();
  }
  function recall(snap, glide, wiggle){
    if(!snap) return;
    params();
    pushUndo();
    const targets = {};
    for(const k in snap.v){
      const p = pByKey(k); if(!p || !isOn(k)) continue;
      let v = snap.v[k];
      if(wiggle > 0) v = v + (p.min + Math.random() * (p.max - p.min) - v) * wiggle;
      targets[k] = quant(v, p);
    }
    for(const k in (snap.s || {})){ const w = switches.find(x => x.key === k); if(w && swOn(k)) applySwitch(w, snap.s[k]); }
    startGlide(targets, glide != null ? glide : S.glide);
  }
  function stepUndo(dir){
    params();
    const from = dir < 0 ? undo : redo, to = dir < 0 ? redo : undo;
    if(!from.length) return;
    to.push(snapshot());
    const s = from.pop();
    G = null;
    const targets = {}; for(const k in s.v){ const p = pByKey(k); if(p) targets[k] = s.v[k]; }
    for(const k in s.s){ const w = switches.find(x => x.key === k); if(w) applySwitch(w, s.s[k]); }
    startGlide(targets, Math.min(1, S.glide));
    ui && ui.sync();
  }

  /* ---------- evolve ---------- */
  let nextAt = 0, lastBeatIdx = null, lastSlot = -1;
  function evolveRoll(intervalSec){
    const glide = Math.max(0.05, intervalSec * S.glideShare);
    const filled = S.slots.map((s, i) => s ? i : -1).filter(i => i >= 0);
    const toFav = S.towards === "favourites" || (S.towards === "either" && Math.random() < 0.5);
    if(toFav && filled.length){
      let i = filled[Math.floor(Math.random() * filled.length)];
      if(filled.length > 1 && i === lastSlot) i = filled[(filled.indexOf(i) + 1) % filled.length];
      lastSlot = i;
      recall(S.slots[i], glide, S.amount * 0.25);
      ui && ui.sync();
    } else roll({ glide, fromHome:S.useHome && !!S.home });
  }

  /* ---------- the loop: glides and evolve ---------- */
  let raf = 0;
  function kick(){ if(!raf) raf = requestAnimationFrame(loop); }
  function loop(now){
    raf = 0;
    if(G){
      const t = clamp((now - G.t0) / G.dur, 0, 1), e = ease(t);
      const doRefresh = now - lastRefresh >= refreshMs || t >= 1;
      G.items = G.items.filter(it => {
        const cur = Number(get(it.p.key));
        // somebody moved the slider by hand: let go of this one
        if(Math.abs(cur - it.last) > Math.max(1e-6, it.p.step * 1.01)) return false;
        const v = it.from + (it.to - it.from) * e;
        writeNow(it.p, t >= 1 ? it.to : v);
        if(doRefresh) refresh(it.p);
        it.last = Number(get(it.p.key));
        return true;
      });
      if(doRefresh) lastRefresh = now;
      changed(t >= 1);
      if(t >= 1 || !G.items.length) G = null;
    }
    if(S.evolve){
      const beat = S.onBeat && drive && drive.state && drive.state.clock;
      if(beat){
        const per = Math.max(1, S.beats), b = drive.state.clock.beats, idx = Math.floor(b / per);
        if(lastBeatIdx === null) lastBeatIdx = idx;
        if(idx !== lastBeatIdx){
          lastBeatIdx = idx;
          const bpm = drive.bpm || 120;
          evolveRoll(per * 60 / bpm);
        }
        ui && ui.progress((b / per) % 1);
      } else {
        if(!nextAt) nextAt = now + S.every * 1000;
        if(now >= nextAt){ nextAt = now + S.every * 1000; evolveRoll(S.every); }
        ui && ui.progress(1 - (nextAt - now) / (S.every * 1000));
      }
    } else { ui && ui.progress(0); }
    if(G || S.evolve) raf = requestAnimationFrame(loop);
  }

  function setHome(){ params(); S.home = snapshot(); save(); ui && ui.sync(); }
  function setEvolve(on){
    S.evolve = !!on; nextAt = 0; lastBeatIdx = null;
    if(S.evolve && S.useHome && !S.home) setHome();
    save(); kick(); ui && ui.sync();
  }

  /* ============================ panel ============================ */
  let ui = null, evolvedOnce = false;
  function mountPanel(host){
    injectStyle();
    params();
    const root = document.createElement("div"); root.className = "ud";
    host.appendChild(root);
    const h = (tag, cls, txt) => { const e = document.createElement(tag); if(cls) e.className = cls; if(txt != null) e.textContent = txt; return e; };
    const sliderRow = (label, min, max, step, key, fmt, onInput) => {
      const r = h("div", "ud-row"), l = h("span", "l", label), i = h("input"), b = h("b");
      i.type = "range"; i.min = min; i.max = max; i.step = step; i.value = S[key];
      const show = () => { b.textContent = fmt(S[key]); };
      i.addEventListener("input", () => { S[key] = Number(i.value); show(); save(); if(onInput) onInput(); });
      show(); r.append(l, i, b); root.appendChild(r);
      return { r, i, sync:() => { i.value = S[key]; show(); } };
    };

    // roll / undo / redo
    const top = h("div", "ud-btns");
    const bRoll = h("button", "ud-roll", "⚄ Roll"), bUndo = h("button", "", "Undo"), bRedo = h("button", "", "Redo");
    bRoll.title = "Move the chosen parameters toward random values";
    top.append(bRoll, bUndo, bRedo); root.appendChild(top);
    bRoll.addEventListener("click", () => roll());
    bUndo.addEventListener("click", () => stepUndo(-1));
    bRedo.addEventListener("click", () => stepUndo(1));

    const sAmt = sliderRow("Amount", 0, 1, 0.01, "amount", v => Math.round(v * 100) + "%");
    const sCount = sliderRow("Per roll", 0, 40, 1, "count", v => v > 0 ? String(v) : "all");
    const sGlide = sliderRow("Glide", 0, 20, 0.1, "glide", v => v.toFixed(1) + " s");

    // evolve
    root.appendChild(h("div", "ud-sub", "Evolve over the show"));
    const evRow = h("div", "ud-btns");
    const bEvolve = h("button", "", "Evolve"), bHome = h("button", "", "Set home");
    bEvolve.title = "Keep rolling on a timer or on the beat"; bHome.title = "Evolve rolls are drawn around this look";
    evRow.append(bEvolve, bHome); root.appendChild(evRow);
    const bar = h("div", "ud-bar"), barI = h("i"); bar.appendChild(barI); root.appendChild(bar);
    const evNote = h("div", "ud-note", "Evolve was running when this page last closed. It stays off after a reload — press Evolve to carry on.");
    root.appendChild(evNote);
    bEvolve.addEventListener("click", () => { evolvedOnce = true; setEvolve(!S.evolve); });
    bHome.addEventListener("click", () => setHome());
    const sEvery = sliderRow("Every", 1, 180, 0.5, "every", v => v.toFixed(v < 10 ? 1 : 0) + " s", () => { nextAt = 0; });
    const beatRow = h("div", "ud-row"), beatChk = h("input"); beatChk.type = "checkbox"; beatChk.checked = !!S.onBeat;
    beatRow.append(h("span", "l", "On the beat"), beatChk); root.appendChild(beatRow);
    beatChk.addEventListener("change", () => { S.onBeat = beatChk.checked; lastBeatIdx = null; save(); ui.sync(); });
    const sBeats = sliderRow("Every", 1, 128, 1, "beats", v => v + " beats", () => { lastBeatIdx = null; });
    const sShare = sliderRow("Glide share", 0.05, 1, 0.01, "glideShare", v => Math.round(v * 100) + "%");
    const homeRow = h("div", "ud-row"), homeChk = h("input"); homeChk.type = "checkbox"; homeChk.checked = !!S.useHome;
    homeRow.append(h("span", "l", "Stay near home"), homeChk); root.appendChild(homeRow);
    homeChk.addEventListener("change", () => { S.useHome = homeChk.checked; if(S.useHome && !S.home) setHome(); save(); });
    const towRow = h("div", "ud-row"), tow = h("select");
    [["random", "New random values"], ["favourites", "Favourites"], ["either", "Either"]].forEach(([v, t]) => { const o = h("option", "", t); o.value = v; tow.appendChild(o); });
    tow.value = S.towards;
    towRow.append(h("span", "l", "Evolve towards"), tow); root.appendChild(towRow);
    tow.addEventListener("change", () => { S.towards = tow.value; save(); });

    // favourites
    root.appendChild(h("div", "ud-sub", "Favourites"));
    const slots = h("div", "ud-slots"); root.appendChild(slots);
    const slotBtns = S.slots.map((_, i) => {
      const b = h("button", "", String(i + 1));
      b.title = "Click: save here when empty, glide to it when full · Shift-click: overwrite · Alt-click: clear";
      b.addEventListener("click", e => {
        params();
        if(e.altKey){ S.slots[i] = null; }
        else if(!S.slots[i] || e.shiftKey){ S.slots[i] = snapshot(); }
        else { recall(S.slots[i]); lastSlot = i; }
        save(); ui.sync();
      });
      slots.appendChild(b); return b;
    });

    // what the dice may touch
    root.appendChild(h("div", "ud-sub", "What the dice can change"));
    const allRow = h("div", "ud-btns"), bAll = h("button", "", "All"), bNone = h("button", "", "None"), bDef = h("button", "", "Default");
    allRow.append(bAll, bNone, bDef); root.appendChild(allRow);
    const list = h("div", "ud-list"); root.appendChild(list);
    const countNote = h("div", "ud-note"); root.appendChild(countNote);
    function buildList(){
      params(); switches = swList();
      list.innerHTML = "";
      const groups = new Map();
      PARAMS.forEach(p => { if(!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); });
      if(switches.length) groups.set("Switches", switches.map(w => ({ key:w.key, label:w.label, sw:true })));
      groups.forEach((ps, g) => {
        const head = h("div", "g"), hc = h("input"); hc.type = "checkbox";
        const allOn = () => ps.every(p => p.sw ? swOn(p.key) : isOn(p.key));
        hc.checked = allOn();
        head.append(hc, document.createTextNode(g));
        head.addEventListener("click", e => {
          const v = e.target === hc ? hc.checked : !allOn();
          ps.forEach(p => { if(p.sw) S.swSel[p.key] = v; else S.sel[p.key] = v; });
          save(); buildList();
        });
        list.appendChild(head);
        ps.forEach(p => {
          const lb = h("label"), c = h("input"); c.type = "checkbox";
          c.checked = p.sw ? swOn(p.key) : isOn(p.key);
          lb.classList.toggle("on", c.checked);
          lb.append(c, document.createTextNode(p.label));
          c.addEventListener("change", () => { if(p.sw) S.swSel[p.key] = c.checked; else S.sel[p.key] = c.checked; lb.classList.toggle("on", c.checked); hc.checked = allOn(); save(); countLine(); });
          list.appendChild(lb);
        });
      });
      countLine();
    }
    function countLine(){
      const n = PARAMS.filter(p => isOn(p.key)).length, sw = switches.filter(w => swOn(w.key)).length;
      countNote.textContent = `${n} of ${PARAMS.length} parameters` + (switches.length ? ` · ${sw} of ${switches.length} switches` : "") + " in the dice.";
    }
    bAll.addEventListener("click", () => { PARAMS.forEach(p => S.sel[p.key] = true); save(); buildList(); });
    bNone.addEventListener("click", () => { PARAMS.forEach(p => S.sel[p.key] = false); switches.forEach(w => S.swSel[w.key] = false); save(); buildList(); });
    bDef.addEventListener("click", () => { S.sel = {}; S.swSel = {}; save(); buildList(); });
    buildList();

    root.appendChild(h("div", "ud-note",
      "Amount is how far each roll moves a parameter from where it is toward a random value — small for nudges, 100% for anything goes. " +
      "Per roll picks that many of the ticked parameters at random each time. Evolve keeps rolling on its own; with Stay near home every roll is drawn around the look you set as home, " +
      "so a long show drifts without getting lost. Favourites are six saved looks per tool in this browser; evolve can glide between them. " +
      "Dice writes the same values the sliders do, so the tool's own preset save keeps whatever you land on, and Drive modulation still plays on top."));

    ui = {
      sync(){
        evNote.classList.toggle("ud-hidden", !(wasEvolving && !S.evolve && !evolvedOnce));
        bEvolve.classList.toggle("ud-on", !!S.evolve); bEvolve.textContent = S.evolve ? "Evolving" : "Evolve";
        bHome.classList.toggle("ud-on", !!S.home);
        bUndo.disabled = !undo.length; bRedo.disabled = !redo.length;
        beatRow.classList.toggle("ud-hidden", !drive);
        sEvery.r.classList.toggle("ud-hidden", !!(S.onBeat && drive));
        sBeats.r.classList.toggle("ud-hidden", !(S.onBeat && drive));
        slotBtns.forEach((b, i) => { b.classList.toggle("full", !!S.slots[i]); b.classList.toggle("last", i === lastSlot && !!S.slots[i]); });
        sCount.i.max = Math.max(1, PARAMS.length);
        [sAmt, sCount, sGlide, sEvery, sBeats, sShare].forEach(s => s.sync());
        beatChk.checked = !!S.onBeat; homeChk.checked = !!S.useHome; tow.value = S.towards;
      },
      flash(){ bRoll.classList.add("ud-on"); setTimeout(() => bRoll.classList.remove("ud-on"), 160); },
      progress(f){ barI.style.width = (clamp(f, 0, 1) * 100).toFixed(1) + "%"; },
      rebuild: buildList
    };
    ui.sync();
    if(S.evolve) kick();
    return root;
  }

  return {
    version:VERSION, roll, recall, setHome, setEvolve, mountPanel,
    undo:() => stepUndo(-1), redo:() => stepUndo(1),
    get state(){ return S; },
    get params(){ return params(); },
    rebuild(){ if(ui) ui.rebuild(); }
  };
}

const UnlimiterDice = { version:VERSION, create, fromDrive, fromTargets };
global.UnlimiterDice = UnlimiterDice;
if(typeof module !== "undefined" && module.exports) module.exports = UnlimiterDice;
})(typeof window !== "undefined" ? window : globalThis);
