# Drive integration — the standard pattern

`unlimiter-drive.js` is the single audio/MIDI/modulation layer for the whole suite.
Every tool wires into it the same way. This is that pattern, written down so the
tenth tool works like the first.

**Status**

| Tool | Drive | Notes |
|---|---|---|
| anchor | yes | reference implementation |
| sediment | yes | modulation is painted into the accumulation, not just displayed |
| drive-check | n/a | it *is* the drive |
| flow-field-plotter | — | |
| flow-weave | — | GPU: resolve once per sim step, and use `Drive.pushFrame()` for output |
| melted-world | — | |
| time-cube | — | currently on `modulation.js` — port and retire |
| worldseed | — | currently on `modulation.js` — port and retire |
| tbg-facade | — | |

---

## The contract

A tool owns a plain object of parameters. The drive never writes to it. Once per
rendered frame the tool asks for a **resolved copy** and reads that instead.

```
P  — the user's parameters. Sliders write here. Presets save this.
Q  — P with modulation applied. The render path reads this. Nothing writes here.
```

That split is the whole idea. The user's settings are never overwritten by a kick
drum, so turning the audio off returns you exactly to where you were.

---

## The five edits

### 1. Load the module

```html
<script src="unlimiter-drive.js"></script>
<script>
"use strict";
```

### 2. Add a panel container

Put it in the sidebar, above the canvas/layout group:

```html
<details class="group" open>
  <summary>Drive — audio, MIDI, modulation<span class="chev"></span></summary>
  <div class="body" id="g-drive"></div>
</details>
```

### 3. Create the instance, next to where `P` is declared

```js
let P = Object.assign({}, DEFAULTS);
let Q = P;

const Drive = (window.UnlimiterDrive)
  ? UnlimiterDrive.create({
      onChange: () => restart(),          // whatever this tool calls to redraw
      getOutputCanvas: () => view         // the canvas OBS should capture
    })
  : null;

const NO_MOD = new Set([ /* see "What not to modulate" */ ]);
let GRP = "";
function registerMod(key, label, min, max){
  if(!Drive || NO_MOD.has(key)) return;
  Drive.registerTarget(key, GRP ? GRP + " — " + label : label, min, max);
}
```

### 4. Register targets from the slider factory

Every tool already has a `slider(parent, key, label, min, max, ...)` helper. One
line inside it registers the whole parameter set automatically — no list to
maintain:

```js
registerMod(key, label, min, max);
```

Set `GRP = "Motion"` etc. before building each panel group and the matrix gets
readable names like `Motion — Speed start`.

If a tool has no slider factory, register in bulk instead:

```js
Drive.registerTargets([
  {key:"speed", label:"Speed", min:0, max:100},
  {key:"warp",  label:"Warp",  min:0, max:1}
]);
```

### 5. Resolve per frame, read `Q` in the render path

```js
function frame(){
  Q = Drive ? Drive.resolve(P) : P;
  render(Q);
}
```

Then swap `P.` for `Q.` **inside the render functions only**. Everything else —
panel code, presets, visibility rules, geometry building — keeps using `P`.

---

## What not to modulate

Put a parameter in `NO_MOD` if changing it means **rebuilding something
expensive**: particle counts, seeds, point spacing, text and font, canvas aspect,
simulation grid size, mesh resolution. Modulating those at 60fps rebuilds the
world every frame and the tool dies.

Everything consumed *while drawing* is fair game.

Rule of thumb: if the parameter is read inside `init()`, exclude it. If it's read
inside `draw()`, register it.

---

## Presets

The drive's config rides along inside the tool's preset JSON under `_drive`:

```js
// export
const out = Object.assign({}, P);
if(Drive) out._drive = Drive.serialize();

// import
if(Drive && j._drive) Drive.load(j._drive);
delete j._drive;
P = Object.assign({}, DEFAULTS, j);
```

A saved preset therefore restores the routing, the LFO shapes, the audio
calibration and the drive amount along with the look.

---

## Mounting, with a fallback

```js
const drivePanel = document.getElementById("g-drive");
if(Drive){
  Drive.mountPanel(drivePanel);
} else {
  drivePanel.innerHTML = '<div class="note">unlimiter-drive.js was not found...</div>';
}
```

The fallback matters: a tool must still work as a standalone generator if someone
opens it without the module alongside.

---

## The output window

`getOutputCanvas` tells the drive which canvas OBS should capture. For a 2D tool
that is all you need — the output window pulls frames on its own clock.

**WebGL tools need one extra line.** A WebGL canvas usually reads back blank
outside its own draw call, because the drawing buffer is cleared once the frame
is presented. Two ways round it:

```js
// option A — let the tool push, inside its own render
function render(){
  ...draw...
  if(Drive) Drive.pushFrame(glCanvas);   // last line of the draw
}
```

`pushFrame` suppresses the pull loop automatically; there is no mode to set. If
the tool stops pushing, the pull loop resumes half a second later.

```js
// option B — keep the buffer around
const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
```

Option A is better: option B costs a little performance on every frame whether or
not the output window is open.

---

## Two things that bite

**Secure context.** The microphone and WebMIDI are blocked on `file://` URLs.
Served from GitHub Pages over https they work. There is no way around this and it
is not a bug in the tool — `drive-check.html` will tell you in five seconds.

**Continuous vs. one-shot rendering.** Tools that redraw every frame (Anchor,
Flow Weave) respond instantly. Tools that accumulate or run a finite cycle
(Sediment) paint the modulation permanently into the image and then stop — those
need their loop/repeat switch on to stay live. Neither is wrong, but they feel
completely different to play, and it's worth knowing which kind you're holding.

---

## Sources available to route

| Source | Character |
|---|---|
| `audio.low / mid / high` | band envelopes, attack and release adjustable |
| `audio.level` | broadband — the lazy choice, use sparingly |
| `audio.onset` | spectral-flux transient, snaps and decays |
| `clock.beat / bar` | ramps, reset on the downbeat |
| `clock.beatPulse / barPulse` | decaying spike on the downbeat |
| `lfo.0–3` | free Hz or clock-divided, 8 bars to 1/16 including triplets |
| `random.beat` | new random value per beat |
| `cc.N` / `note.N` | appear once seen; MIDI-learn per route |

**Drive amount** scales every route at once. Bypass is the panic button.
Per-route mute is for A/B-ing a mapping without losing it.
