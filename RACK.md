# The Rack — node-graph control surface

`rack.html` is the suite as one instrument. Five real tools run in hidden
same-origin iframes; a node graph says what feeds what; the **OUTPUT** node is
the mix OBS captures, and it also feeds the volume renderer. One
`unlimiter-drive.js` instance modulates all of it.

**It must be served over http.** `file://` pages are cross-origin, so the rack
can't reach into the tool frames. `python -m http.server` in the repo folder, or
GitHub Pages. The rack says so on screen if you forget.

## The graph

```
Flow Weave ─┐
Melted World ┤
Sediment    ─┼──▶ OUTPUT ──▶ Volume
Anchor      ─┤       │
Ouroboros ──┘       │
    ▲                │
    └────────────────┘   (feedback: the mix feeds the recursive engine)
```

- **Drag** a node's right port to another's left port to patch.
- **OUTPUT** takes as many feeds as you like; each cable is a layer with its own
  opacity and blend mode. Tool inputs and the Volume node take exactly one feed
  (patching a second replaces the first).
- **Click a cable** to set that layer's opacity/blend, mute it, or delete it.
  Select + `Delete` also removes it.
- Cycles are allowed on purpose — OUTPUT → Ouroboros is the default, and it is
  the signature move: the composite feeds the engine that draws into it.
- Node positions, cables, layer settings and mix gain persist to localStorage.
  **Reset layout** puts it back.

## Clicking a node gives you its controls

| Node | Inspector |
|---|---|
| a tool | Edit in stage · Open tab · Wake · Solo; its layer's opacity/blend; what feeds its input; **all of its own parameters** |
| OUTPUT | the layer stack in draw order with ↑↓ reordering, mix gain, background (black, or *keep* for trails) |
| Volume | mix relief/gain/point size, the renderer's own params, and scene buttons |
| a cable | opacity, blend, mute, delete |

The Drive panel (audio, MIDI, LFOs, matrix) sits under every view — it is one
live DOM tree that gets moved between views rather than rebuilt, so its state
never resets.

### Editing a layer while it feeds the output

**Edit in stage** puts that tool's own real UI in the middle pane. It is the
actual tool, with all its own controls — not a reimplementation — and the mix
keeps running the whole time, because the frame is never moved in the DOM or
reloaded, only repositioned. **Open tab ↗** gives it a full window instead.

### Parameters, with no list to maintain

The rack hardcodes no parameters. Every tool already told its own drive what is
modulatable, with real bounds and labels, so the rack reads `Drive.targets` back
out of each frame: 25–47 parameters per tool, with the tool's own names
("Displacement — Amplitude", "Size — Start"). Filter them with the search box.

Each row has a **◎** button. Off, the slider writes straight into the tool's `P`.
On, that parameter is registered with the rack's drive — it appears in the
modulation matrix and can be routed from audio, LFOs, clock or MIDI. Four per
tool are pre-registered; toggling is reversible.

The rack keeps the same `P`/`Q` contract as the tools: `RP` holds your values,
`RQ = Drive.resolve(RP)` resolves once per frame, and applying `RQ` writes into
each tool's own `P`. The rack is a remote hand on their sliders, and each tool's
own drive modulation still layers on top.

## How capture works without editing the tools

Two paths, because the tools differ:

- **pull** — the canvas reads back (2D, or WebGL with `preserveDrawingBuffer`),
  so the rack `drawImage`s it each frame. Flow Weave, Sediment, Anchor (from its
  offscreen `work` canvas).
- **push** — WebGL with `preserveDrawingBuffer:false` reads back blank outside
  its own draw call. Those tools already call `Drive.pushFrame(canvas)` at the
  end of their render for the output window, so the rack wraps that method on
  the tool's own drive instance and copies the frame as it passes, then calls the
  original. Melted World, Ouroboros. Nothing in the tools changed.

Reach-in uses each frame's own `eval`, not window properties: the tools declare
`Drive`, `P`, `work`, `upload`, `setSource` as top-level `const`/`let`, which live
in the realm's global *lexical* environment and never appear on `window`.

Input feeds run at sensible rates: per-frame for Ouroboros, ~8/s for Melted
World's texture, and once per 6s for Sediment (its `setSource()` restarts the
accumulation).

## Volume renderer

`volume-renderer.html?embed=1` starts with an empty scene and hidden chrome, and
publishes `window.UnlimiterVolumeAPI`:

```js
pushMixFrame(canvas)   // sample the mix into a live volumetric source
setMix({relief, gain, size, opacity})
setParam(id, value)    // any renderer param, by manifest id
params(), addScene('galaxy'|'nebula'|'gi'), clearScene(), hasMix()
```

The mix arrives as a 160×90 point grid: luminance becomes depth and opacity,
pixel colour becomes point colour. It uses the existing `pointcloud` kind, so no
shader path changed — only `Renderer.updateSourceGPU()` was added. Without
WebGPU the API still publishes with `ready:false` so the rack reports it rather
than waiting.

## Verified by running it

Served locally and driven with headless Chromium:

- all five tools load and attach (`Drive` + `P` reached in every frame)
- every node's inspector renders with content; parameter lists are 25–47 rows
- a slider moved Anchor's own `P.scatter` 0 → 79.2
- the ◎ toggle registers and unregisters drive targets
- **Edit in stage** shows the tool without reloading its frame (`performance.timeOrigin` unchanged)
- patching a new cable rewires the input feed
- the mix animates; OUTPUT → Ouroboros feedback reports `hasIn:true`

Two things that environment can't judge: the volume renderer (no WebGPU in
headless) and Flow Weave's image (it renders near-black under software GL,
standalone too). Both want your 4090.

## Next

- Per-layer transform (scale/rotate/offset) before compositing.
- A mask input alongside the source input.
- More node kinds: a plain colour/gradient source, a feedback-delay node, a
  "send to Resolume" node.
- Saveable graph presets beyond the single autosaved layout.
