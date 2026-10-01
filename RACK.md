# The Rack — node-graph control surface

`rack.html` is the suite as one instrument. Tools run in hidden same-origin
iframes; generator nodes run inside the rack itself; a typed graph says what
feeds what. The **OUTPUT** node is the mix OBS captures, and the volume
renderer takes both pictures and real 3D points.

**It must be served over http.** `file://` pages are cross-origin, so the rack
can't reach into the tool frames. `python -m http.server` in the repo folder, or
GitHub Pages. The rack says so on screen if you forget.

## The graph

```
                 ┌──────────── 2D points ─────────────┐
Points (gen) ────┤                                    ▼
                 └── 3D points ──┐           Flow Weave ─┐
Melted World ─┐                  │           Sediment   ─┼──▶ OUTPUT ──▶ Volume (image)
Anchor       ─┼──────────────────┼──────────────────────┘       │
Ouroboros   ─┘                  └─────────────────────────────┼──▶ Volume (points)
     ▲                                                          │
     └──────────────────────────────────────────────────────────┘  (feedback)
```

Every cable has a **type**, and only ports of the same type connect:

| Type | Cable | Carries |
|---|---|---|
| image | solid, the source node's colour | a picture — what the rack has always passed |
| points | dotted teal | a points frame, by reference (see PORTS.md) |
| scalar | dashed yellow | a 0–1 signal — audio, clock, LFO, MIDI, a knob — that thickens and brightens with its value |
| field, mask | dotted amber / violet | reserved; the types exist, no producer yet |

- **Drag** from an output port (right) to an input port (left) to patch. A port
  on a node with more than one port on that side is labelled.
- Every input takes one cable — a new one replaces the old — except OUTPUT's,
  which stacks as many layers as you like, and scalar inputs, where several
  signals add together. Each OUTPUT cable is a layer with its
  own opacity and blend mode.
- **Click a cable** to set that layer's opacity/blend, mute it, or delete it.
  Select + `Delete` also removes it. Data cables have no opacity or blend: mute
  one and the receiving tool is told once, and falls back to its own content.
- Cycles are allowed on image cables on purpose — OUTPUT → Ouroboros is the
  default, and it reads the previous frame's mix, so the loop is one frame late
  by construction.
- **Moving around:** drag empty space to pan, wheel (or pinch) to zoom about the
  cursor, **F** or double-click empty space to fit everything, **0** for 1:1, or
  the Fit / 1:1 buttons bottom-right. The view is remembered. Control Surface
  pans and zooms the same way.
- **Disconnecting:** double-click a cable, right-click it, or select it and press
  Delete. Or grab a patched **input** port and drag: the cable comes off in your
  hand — drop it on another input to move it, on empty space to disconnect.
- **Bypass:** tools and generators have an **off** button in their header (also
  **B** with the node selected, or the inspector button). A bypassed node is
  dimmed and all its outgoing cables go silent — image layers drop out of the mix
  and data receivers fall back to their own content — without losing any patching.
  Bypass is saved with the layout. OUTPUT and Volume aren't bypassable.
- Node positions, cables, generator settings, layer settings and mix gain
  persist to localStorage (`unlimiter.rack.graph.v2`). A layout saved by the
  older rack (`…v1`) is migrated once on first load — every old cable becomes a
  typed image cable — and the v1 entry is left untouched. **Reset layout** puts
  it back to the default graph.

## Generator nodes

**+ Manifold** (formerly *Points generator*) adds a node that is `unlimiter-points.js` running inside
the rack's own realm — no iframe. Maths needs no GL context and no UI of its
own, so it steps on the rack's clock and hands its frames out by reference.

It has three outputs:

| Port | Type | What it is |
|---|---|---|
| **3D** | points | the form centred in unit space — the volume renderer takes these |
| **2D** | points | the same points through the node's own 2D view (yaw, pitch, spin, zoom, perspective) — Flow Weave's emitters take these |
| **image** | image | the 2D points drawn as light, far side dimmer, for the mix |

Its inspector is built from the module's own parameter metadata — the same
lists `manifold.html` builds its sliders from: form, placement, three modifier
slots, which points, colour and size, and the view. Every continuous slider has
a **◎**; spin and zoom are routable from the start. Rows, columns and shells
reallocate buffers, so they are never modulated. `Delete` removes a generator
(tools, OUTPUT and Volume are fixed).

**Morph.** Switch *morph* on and the node blends its form into a second one: pick
the target form, set its own parameters (the `b_` rows) and drive **mix** by hand
or from a signal. Both forms must share rows and columns.

**Hosted tools that take points or images.** TBG Facade (seeds → one folding-panel
growth per point), Flow Field Plotter (seeds start its agents; an image cable
replaces its source) and Time Cube (an image cable replaces the camera) are Rack
tools with ports. Patch a Manifold's **2D** or **3D** output, or any image, into
them. Cut the cable and they return to their own source. They have no Drive yet,
so their own sliders are not routable from the Rack — only their ports are.

The default graph, and the first load of a migrated v1 layout, include one
generator wired **2D → Flow Weave's emitters** and **3D → Volume's points**.

## Vision nodes

**+ Vision** adds `unlimiter-vision.js` running inside the Rack — plain JS on a 192×108
copy of the picture, no library, about 5–10 ms a frame. It takes any picture (the patched
image cable, or the webcam) and gives back all three data types. What it makes depends on
the mode:

| Mode | field | mask | points |
|---|---|---|---|
| **Motion** (pyramidal Lucas–Kanade) | velocity, uv per second | where it moves | on the moving areas, heading along the motion |
| **Edges** (Sobel, thinned) | orientation of structure (sign arbitrary) | the edges | on the edges, tangent runs along them |
| **Foreground** (running background, selective update) | points out of the silhouette | the silhouette | spread over it |
| **Feature tracks** (Shi–Tomasi + sparse LK) | their motion, smoothed | — | tracked corners, tangent = velocity, `ids` stable per track |

An output a mode doesn't make is empty, and whatever was patched to it falls back to its
own content. The **image** output is a picture of what it found (flow as hue and
brightness, edges glowing, the cut-out, trails) and mixes like any layer. Analysis rate,
point count and each mode's thresholds are sliders with a **◎**, so audio or a signal can
drive them. **Reset** forgets the background and the tracks.

Patch **field → Plotter's field** and strokes are pushed and steered by it (*Field push*, *Field steer*); **mask → Plotter's mask** and strokes only start inside it and are cut off when they wander out (*Stay inside mask*, plus *Invert* to draw outside). **mask → Melted World's mask** and only the lit parts melt (the same strength slider as the mask image); **field → Melted World's field** and the lookup is pushed along it (*Field warp*). **field → Sediment's field** and particles drift along it instead of the noise (*Field drift*, *Field over noise*); **mask → Sediment's mask** and particles only deposit where it is lit (*Invert* flips it). **points → Ouroboros's brushes** and every point stamps the loop like a held-down brush (a Manifold's 2D or 3D, or a Vision node's points); the loop carries the smear. Strength, size, colour mix and a cap on how many are sliders in its *Brushes — points from the rack* group. Patch **field → Flow Weave's force** and camera motion pushes the fluid; **points → Flow
Weave's emitters / Plotter's seeds / Facade's seeds** and found things become brushes,
agent starts and panel roots. Flow Weave's *Follow strength* sets how hard the fluid tracks
the field.

**Lattice** is the drawing end of the same vision engine, as a tool of its own (`lattice.html`,
also hosted here). Patch an **image** into it and it tracks that picture as if it were a camera;
patch **points** in and it draws those (a Manifold's 3D points are linked in 3D). Its own
**points** output carries what it tracked with real velocity — tangent is the direction of
travel, size grows with speed, and every point has a stable `ids` entry — so Lattice can feed
Ouroboros's brushes or Flow Weave's emitters with tracked, velocity-coloured points.

## Signals — the old Control Surface, inside the graph

There is one graph. **+ Signal ▾** adds three kinds of node, all wired with
scalar cables:

| Node | What it is |
|---|---|
| **Source** | one signal from the Drive: audio low / mid / high / level / onset, clock beat / bar ramps and pulses, random-per-beat, the four LFOs, any MIDI CC or note it has seen — or a hand **Manual knob** |
| **Utility** | Scale / remap (min, max, curve), Smooth (lag), Invert, Combine (mix of a and b), Threshold (gate) |
| **Parameter** | takes the 0–1 arriving at its input and drives one parameter across that parameter's own range — any tool parameter, any generator parameter, the volume renderer's |

Each cable carries `value × scale + offset` (click it to edit), and several cables
into one input add together — so two LFOs into one parameter just sum. Scalar
cables can't loop: a cable that would close a cycle is refused.

A parameter node **has the last word**. The Drive panel's routes resolve first,
then a patched parameter node replaces the value outright. Unpatch it, bypass it
or delete it and the parameter returns to its own value — the tool's `P` was never
touched, same override mechanism as ◎. A parameter node whose tool hasn't loaded
yet waits and binds when it does, so a saved graph restores in any order.

Sources, utilities and parameters have the same header **off** button and `B` key
as every other node. Every node draws a live scope of the value passing through
it.

The Drive panel (audio input, LFO shapes and rates, clock, MIDI learn, the routing
matrix) still sits under the inspector — it is the signal *engine*; the graph is
where signals are *patched*. Both work at once.

**Import:** `+ Signal ▾ → Control Surface patch…` brings in a patch saved from the
old `control-surface.html`: its `band.*`/`env.*`/`onset`/`tempo`/`lfo` sources map
onto the Drive's, utilities keep their settings, cable scale and offset carry over,
and targets that name a real tool parameter are bound (targets on that page's two
demo tools have no counterpart and are skipped, and the count is reported).
`control-surface.html` itself stays as a standalone sandbox with a pointer here.

## Clicking a node gives you its controls

| Node | Inspector |
|---|---|
| a tool | Edit in stage · Open tab · Wake · Solo; its layer's opacity/blend; what feeds its input; the **data ports** it publishes and what they're patched to; **all of its own parameters** |
| a generator | form, placement, modifiers, look, 2D view — from `unlimiter-points.js` metadata |
| OUTPUT | the layer stack in draw order with ↑↓ reordering, mix gain, background (black, or *keep* for trails) |
| Volume | what's on its image and points ports, mix relief/gain/point size, the renderer's own params, scene buttons |
| a signal node | its source / settings and a live value; bypass, delete |
| a cable | its type; for image cables into OUTPUT, opacity and blend; for scalar cables, scale and offset; mute, delete |

The Drive panel (audio, MIDI, LFOs, matrix) sits under every view — it is one
live DOM tree that gets moved between views rather than rebuilt, so its state
never resets.

### Editing a layer while it feeds the output

**Edit in stage** puts that tool's own real UI in the middle pane. It is the
actual tool, with all its own controls — not a reimplementation — and the mix
keeps running the whole time, because the frame is never moved in the DOM or
reloaded, only repositioned. **Open tab ↗** gives it a full window instead
(a separate instance, not connected to the rack).

### Parameters, with no list to maintain

The rack hardcodes no parameters. Every tool already told its own drive what is
modulatable, with real bounds and labels, so the rack reads `Drive.targets` back
out of each frame (25–47 per tool). Filter them with the search box.

Each row has a **◎** button. Off, the slider writes straight into the tool's
`P` — it is a user edit, the same as moving the tool's own slider. On, the
parameter is also registered with the rack's drive and routable from audio,
LFOs, clock or MIDI.

**The rack never writes modulated values into a tool's `P`.** It resolves
`RQ = Drive.resolve(RP)` once per frame and hands each result to the tool as an
override (`Drive.setOverride`, drive 1.5), which the tool applies inside its own
`Q`. So the tool's `P` keeps what the user set, its presets save that, its
sliders stay honest, and turning the ◎ off hands the parameter back exactly
where it was. It works both ways: move a registered parameter in the tool's own
UI during *Edit in stage* and the rack adopts that as its new base instead of
overwriting it next frame. A tool that loads a preset replaces its `P` object;
the rack notices within a quarter second and adopts the new values.

## How capture works

- **ports** — a tool that publishes an `out` image port through
  `unlimiter-ports.js` is captured from whatever that port returns. Flow Weave.
- **pull** — otherwise the canvas reads back (2D, or WebGL with
  `preserveDrawingBuffer`), so the rack `drawImage`s its `sel` canvas each
  frame. Sediment (its finished `#view`), and Anchor from its offscreen `work`
  canvas — only tools that declare `from:"work"` are captured that way.
- **push** — WebGL with `preserveDrawingBuffer:false` reads back blank outside
  its own draw call. Those tools already call `Drive.pushFrame(canvas)` at the
  end of their render for the output window, so the rack wraps that method on
  the tool's own drive instance and copies the frame as it passes. Melted World,
  Ouroboros.

Every layer is captured to a 640×360 canvas, so sources are stretched to 16:9.

Image input feeds run at sensible rates: per-frame for Ouroboros, ~8/s for Melted
World's texture, and once per 6s for Sediment (its `setSource()` restarts the
accumulation). Data cables deliver every rack frame; receivers skip work when
the value's `version` hasn't moved.

## Volume renderer

`volume-renderer.html?embed=1` starts with an empty scene and hidden chrome, and
publishes `window.UnlimiterVolumeAPI`:

```js
pushMixFrame(canvas)      // an image as a live relief: luminance → depth
pushPoints(packed, n, o)  // real 3D points (16-float layout) as a live source; (null, 0) removes it
setMix({relief, gain, size, opacity})
setParam(id, value)       // any renderer param, by manifest id
params(), addScene('galaxy'|'nebula'|'shell'|'gi'), clearScene(), hasMix(), hasPoints()
```

The **image** port takes whichever image node is patched into it — the mix by
default, but a single tool or a generator's image works too. Patching something
else no longer silently stops the feed. The mix arrives as a 160×90 point grid:
luminance becomes depth and opacity, pixel colour becomes point colour.

The **points** port takes real 3D positions. The live point source is allocated
once at a power-of-two capacity and reused: the renderer's GPU sort bakes its
point count in at creation, so the count never changes frame to frame — unused
slots are written invisible (alpha 0), and the source is only rebuilt when a
frame outgrows its capacity. Point size is per source, not per point.

Without WebGPU the API still publishes with `ready:false` so the rack reports it
rather than waiting.

## Verified by running it

Served locally and driven with headless Chromium (software GL and WebGPU):

- all five tools load and attach; Sediment is captured from `#view`, Anchor from `work`
- a rack target modulated to 90% of its range reaches the tool's `Q` while its
  `P` stays at the user's value; moving the tool's own slider becomes the rack's
  new base; unregistering returns the tool to its `P` — for Flow Weave (drive via
  adapter) and Ouroboros (native P/Q)
- the default graph has a generator producing 1,320 finite points in unit space
  and drawing them; points→image and image→points cables are refused; patching a
  generator's image into Volume replaces the old feed and is what gets pushed
- a v1 layout migrates with positions, muted cables, blends, mix settings and the
  feedback loop intact, gains exactly one wired generator, and doesn't re-migrate
- **Flow Weave holds the very object the generator produced** — nothing is copied
  between realms. With nothing emitting its fluid reads zero velocity and zero
  dye; with the generator patched, 137,549 dye pixels in the generator's colour
  and a mean velocity of 1.11. Muting the cable releases it; unmuting reconnects
- the volume renderer's live point source: added at capacity 2048, a smaller frame
  reuses it with the extras retired, a bigger one reallocates once (4096), removal
  works — with zero WebGPU validation errors
- all 17 pages boot with no errors after the drive change, same as before

What that environment can't judge:

- **Volume pixels.** WebGPU runs, but neither screenshots nor buffer readback
  work there (the renderer's own galaxy is invisible to it too). The points reach
  the GPU through the same source path the mix feed uses; seeing them is for your
  own GPU.
- **The three WebGL tools inside the full rack.** Under software GL the browser
  drops their contexts once all five tools are loaded — the original rack does
  the same. That is why Flow Weave "renders near-black" there. With Melted World
  and Ouroboros left out, Flow Weave's context survives and the end-to-end check
  above passes with pixels.

## Next

- Signal nodes for MIDI learn and the LFO shapes themselves (today they are set in
  the Drive panel); a sample-and-hold / slew utility; one engine per page.

- More tools taking `field` and `mask`: Anchor (mask regions), Time Cube (a mask as its cut-out). Relief.
- More Vision modes: contours, depth. (Corner-pin warp for projection mapping, parked.)
- Give Facade, Plotter and Time Cube a Drive so their settings are routable.
- Phylo: lift its IIFE so its branches can leave.
- One engine per page — the rack's clock and audio shared by every hosted tool.
- Per-layer transform (scale/rotate/offset) before compositing, and masks —
  likely with a WebGL compositor.
- Saveable graph presets beyond the single autosaved layout; persist the rack's
  own drive matrix and ◎ registrations.
