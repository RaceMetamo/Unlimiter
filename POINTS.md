# Point generator integration — `unlimiter-points.js`

`unlimiter-drive.js` is the suite's modulation layer. `unlimiter-points.js` is
its geometry layer: the procedural point source every other tool can read.

It has no DOM, no WebGL and no three.js in it. It answers one question —

> given an address and a moment in time, where is this point, what colour is
> it, how big is it, and is it there at all?

— and hands back plain `Float32Array`s. `manifold.html` draws them, the volume
renderer ingests them, Anchor can seed from them, the rack can patch them.

**Status**

| Consumer | Points | Notes |
|---|---|---|
| manifold | yes | reference implementation — every surface, placement and modifier |
| volume-renderer | via `.ply` | Manifold exports the pointcloud layout its loader already reads |
| anchor | — | candidate: seeded point clouds instead of only type contours |
| flow-weave | — | candidate: points as emitters rather than as the drawn thing |
| flow-field-plotter | — | candidate: points as stroke seeds |
| rack | — | candidate: generators as source nodes, without Manifold's panel |

---

## The shape of it

Four independent axes. Most of the range comes from crossing them rather than
from any one of them being clever.

```
surface        (u, v, shell) -> xyz     what form the points live on
distribution   index         -> (u, v)  where on that form they land
modifiers      xyz           -> xyz     what happens to them afterwards
presence / colour / size                how they read
```

`u` runs 0..1 the long way round and wraps. `v` runs 0..1 across and clamps.
`shell` is 0..1 across the nested copies of the form, so the layered reading
works on a Möbius band exactly as it does on a sphere.

Surfaces: `sphere`, `disc`, `torus`, `cylinder`, `supershape`, `saddle`,
`mobius`. Placements: `grid`, `rings`, `fibonacci`, `jitter`, `flock`.
Modifiers: `noise`, `twist`, `swirl`, `ripple`, `inflate`, `axis`.

---

## Loading it

```html
<script src="unlimiter-points.js"></script>
<script src="unlimiter-drive.js"></script>
```

Order does not matter — they do not know about each other.

The module publishes itself with `window.UnlimiterPoints = ...`, the same way
`unlimiter-drive.js` ends with `global.UnlimiterDrive = ...`. That explicit
line is load-bearing, not decoration: a top-level `const` in a classic
`<script>` lives in the global **lexical** environment and never becomes a
property of `window`, so without it a consumer reading `window.UnlimiterPoints`
finds nothing while the file has in fact loaded and run perfectly. (This is the
same realm quirk RACK.md relies on when it reaches into tool frames with `eval`
rather than through `window`.) `unlimiter-bus.js` has no such line yet — read
it by its bare name, `UnlimiterBus`, not off `window`.

## Generating a frame

```js
const spec = {
  surface: "torus", surfaceParams: { radius: 175, tube: 70 }, shells: 4,
  distribution: "grid", rows: 60, cols: 80,
  modifiers: [{ type: "twist", params: { amount: 0.2 } }],
  presence: "field", presenceParams: { scale: 4.2, low: 0.44, high: 0.58 },
  colour: "fieldcol", sizeMin: 3, sizeMax: 3
};

let frame = null;
function tick(t){
  frame = UnlimiterPoints.generate(spec, t, frame, null);   // reuses the buffers
  // frame.positions  Float32Array(n*3)
  // frame.colors     Float32Array(n*3)   0..1
  // frame.sizes      Float32Array(n)
  // frame.presence   Float32Array(n)     0..1, carve/fade weight
  // frame.count      n = rows * cols
}
```

Anything left out of a spec falls back to that surface's / modifier's own
declared default, so a partial spec is always valid. Pass the same `frame`
back in every tick — it only reallocates when the count changes.

The generator is pure and deterministic: the same spec and the same `t` give
byte-identical points. A consumer can therefore re-sample at whatever density
it wants without asking the generator to hold state for it.

## Placements with memory

`flock` is the exception — it carries agents:

```js
const state = UnlimiterPoints.createFlock(rows * cols, shells);
UnlimiterPoints.stepFlock(state, dt, t, flockParams, field, band);
frame = UnlimiterPoints.generate(spec, t, frame, state);
```

The agents live in the flat wrap-around `(u, v)` space, never in xyz, which is
why they can walk any surface without special-casing poles and seams. `field`
is optional: `(u, v, shellFrac) => 0..1`. Hand it the same carve the presence
test uses and the flock flies through the gaps the carve leaves open.

## Morphing

```js
const { frame } = UnlimiterPoints.morph(specA, specB, mix, t, frame,
                                        stateA, stateB, scratchA, scratchB);
```

Both specs are evaluated at the same address and blended point for point, so
the geometry travels rather than two pictures cross-fading. The two sides need
the same `rows`/`cols`; if they differ, the result clamps to the smaller.

---

## Handing points to the volume renderer

Two routes, and the second one works today.

**Packed, in memory.** `toVolumePacked(frame, {scale})` returns the renderer's
own source layout — 16 floats a point, xyz at 0–2, rgb at 4–6, alpha at 7,
centred and scaled into its roughly unit-sized world. Points below the presence
cutoff are dropped rather than sent as invisible rows. This is ready for a
`pushPoints(packed, n)` on `UnlimiterVolumeAPI` whenever that gets added; the
API currently only accepts a 2D canvas via `pushMixFrame`, which costs the
third dimension on the way through.

**As a file.** Manifold's **Export .ply** writes the live points as a binary
little-endian point cloud with `x y z` floats and `red green blue` uchars —
exactly the non-gaussian path `parsePly()` already handles. Load it with the
renderer's own PLY button and the form arrives as real 3D points.

> One trap worth knowing: `parsePly` locates the binary data with a *string*
> index into the decoded header (`endIdx + 10`). A single multi-byte character
> anywhere in the header shifts every float it then reads. Keep PLY headers
> strictly ASCII.

## Handing points to the drive

Every surface, placement, modifier, presence rule and colour rule declares its
own numbers as metadata — key, label, min, max, step, default:

```js
UnlimiterPoints.SURFACES.torus.params
// [{key:"radius", label:"Ring radius", min:40, max:360, step:1, def:170}, ...]
```

Manifold builds its sliders from that list and registers its modulation targets
from the same list, so there is no parameter list kept anywhere in the tool —
add a surface to the module and its controls and its mod targets both appear.
`UnlimiterPoints.targets(spec)` returns the whole flattened set with prefixed
keys (`surf.radius`, `mod0.amount`) for the Control Surface.

The usual `NO_MOD` rule applies, with one addition specific to geometry: point
counts and identities (`rows`, `cols`, `shells`, and the surface / placement
selections themselves) reallocate buffers, so they must stay out of the matrix.
Everything consumed while generating is fair game — including the morph mix,
which is one of the better things in the suite to put a kick drum on.

---

## Cost

CPU-side, single-threaded, no GPU involvement:

| Points | Content | Per frame |
|---|---|---|
| 16,800 | carve field + one modifier | ~7 ms |

That is comfortable at 60fps with headroom, and it is the honest ceiling: past
roughly 40k points with modifiers this wants a compute-shader twin rather than
a faster loop. The specs are deliberately plain numbers with no closures in
them, so the same parameters can drive a GPU path later without the consumers
changing.

## Testing

`test_points.js` runs the module headlessly under node — every surface across
its whole domain including edges and zeroed/maxed parameters, normals at poles
and seams, placements staying inside the address space, modifiers at slider
extremes, every preset over 40 frames, flock stability with a jitter metric
(average per-frame heading change stays under 10° even at maximum field pull),
morph endpoints landing exactly on A and B, and the volume packing.

```
node test_points.js
```

This is the main practical reason the geometry lives in a module with no DOM in
it: the maths can be proven before any of it reaches a canvas.
