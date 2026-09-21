# The Rack — template control surface

`rack.html` hosts the whole suite as one instrument: five real tools running in
hidden same-origin iframes, blended into one mix, with that mix fed to the volume
renderer as a live 3D source. One `unlimiter-drive.js` instance modulates all of
it — layer opacities *and* each tool's own registered parameters.

**It must be served over http.** `file://` pages are cross-origin, so the rack
can't reach into the tool frames. `python -m http.server` in the repo folder, or
GitHub Pages. The rack says so on screen if you forget.

## What's wired

| Layer | Tool | Capture | Source feed |
|---|---|---|---|
| 1 | Flow Weave | pull (`preserveDrawingBuffer:true`) | — |
| 2 | Melted World | push (wraps `Drive.pushFrame`) | texture, ~8/s |
| 3 | Sediment | pull (2D) | `setSource()`, throttled to 6s |
| 4 | Anchor | pull (its offscreen `work` canvas) | — |
| 5 | Ouroboros | push (wraps `Drive.pushFrame`) | per-frame — defaults to **MIX** |

Ouroboros defaulting to the mix means the rack starts with a feedback loop: the
composite is fed back into the recursive engine, which then draws into the
composite. That is the signature move and it costs nothing to turn off.

## How it captures without editing the tools

Two paths, because the tools differ:

- **pull** — the canvas reads back, so the rack `drawImage`s it each frame.
- **push** — WebGL with `preserveDrawingBuffer:false` reads back blank from
  outside its own draw call. Those tools already call `Drive.pushFrame(canvas)`
  at the end of their render for the output window. The rack wraps that method
  on the tool's own drive instance and takes a copy as the frame goes past, then
  calls the original. Nothing in the tools changed.

Reach-in uses the frame's own `eval`, not window properties: the tools declare
`Drive`, `P`, `work`, `upload` etc. as top-level `const`/`let`, which live in the
realm's global *lexical* environment and never appear on `window`.

## Parameters: no list to maintain

The rack does not hardcode each tool's parameters. Every tool already told its
own drive what is modulatable, with real bounds and labels, so the rack reads
`Drive.targets` back out of each frame and registers a curated subset (the
`prefer` list per tool, falling back to whatever the tool registered). Add a
slider to a tool and the rack can see it with no edits here.

The rack keeps the same `P`/`Q` contract as the tools: `RP` holds your values,
`RQ = Drive.resolve(RP)` is resolved once per frame, and applying `RQ` writes
into each tool's own `P`. So the rack acts as a remote hand on the tools'
sliders, and each tool's own drive modulation still layers on top.

## Volume renderer link

`volume-renderer.html?embed=1` starts with an empty scene and hidden chrome, and
publishes `window.UnlimiterVolumeAPI`:

```js
pushMixFrame(canvas)   // sample the mix into a live volumetric source
setMix({relief, gain, size, opacity})
setParam(id, value)    // any renderer param, same ids as the Control Surface
params(), addScene('galaxy'|'nebula'|'shell'|'gi'), clearScene(), hasMix()
```

The mix arrives as a 160×90 grid of points: luminance becomes depth and opacity,
pixel colour becomes point colour. It uses the existing `pointcloud` kind, so no
shader path changed — only `Renderer.updateSourceGPU()` was added, to re-upload a
source's buffer in place each frame. If WebGPU is missing the API still publishes
with `ready:false` so the rack reports it instead of waiting forever.

## Verified by running it

Served locally and driven with headless Chromium:

- all five tools load, attach, and expose their drive + `P` (30–47 targets each)
- the mix animates (large frame-to-frame delta, not a still)
- an LFO routed to `an.waveAmp` moved Anchor's own `P.waveAmp` 0 → 149 → 172
- Ouroboros reports `hasIn:true` with the mix routed in

Not verifiable in that environment: the volume renderer (no WebGPU in headless)
and Flow Weave's image (it renders near-black under software GL — it reads blank
standalone there too, so it is the environment, not the rack).

## Next, when you want to go further

- Replace the fixed layer list with the Control Surface node graph, so routing
  between tools is patched rather than picked from dropdowns.
- Per-layer transform (scale/rotate/offset) before compositing.
- Mix → a tool's *mask* input rather than its source.
- Record the rack: the drive's output window already gives OBS a clean capture.
