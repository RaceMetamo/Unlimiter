# Ports — typed data between tools

`unlimiter-drive.js` moves **scalars** between tools. `unlimiter-ports.js` moves
everything else: points, strokes, fields, masks — the data each tool computes
internally, which until now never left its iframe except as a picture of itself.

**Status**

| Tool | Publishes | Notes |
|---|---|---|
| flow-weave | `out` image · `emitters` points in | reference implementation — every point becomes a brush |
| rack generator nodes | `3D`, `2D` points · `image` | `unlimiter-points.js` running in the rack, no iframe |
| volume-renderer | `pushPoints()` on its API | the rack routes a points cable into it |
| tbg-facade | `out` image · `seeds` points in | each point roots a folding-panel growth, panel centred on the point and facing outward |
| flow-field-plotter | `out` image · `image` source in · `seeds` points in | a Rack image replaces the file/webcam source; seeds start most agents (tangent heading) |
| time-cube | `out` image · `image` source in | a Rack image stands in for the camera, filling the time volume |
| anchor, sediment, phylo | — | next; ARCHITECTURE.md lists the seam in each |

---

## The four types

Scalars stay in the drive. Everything else is one of four types, each defined
once in `unlimiter-ports.js`:

```js
// image — a canvas, ImageBitmap or video
{ type:"image", source, w, h, version }

// points — the unlimiter-points frame, extended
{ type:"points", count, version,
  space: "uv" | "3d",               // see below
  aspect,                           // uv only: w/h of the frame the uvs are laid out on
  positions: Float32Array(n*3), colors: Float32Array(n*3),    // colours 0..1
  sizes: Float32Array(n), presence: Float32Array(n),           // presence 0..1
  tangents?: Float32Array(n*3),     // direction: strokes, agents, branch headings
  offsets?:  Uint32Array(m+1),      // polylines: points grouped into strokes or branches
  parents?:  Int32Array(m) }        // trees

// field — a 2D vector field (velocity, orientation, displacement)
{ type:"field", w, h, data: Float32Array(w*h*2), space:"uv", version }

// mask
{ type:"mask", w, h, data: Uint8Array(w*h), version }
```

A polyline is a point set plus grouping, so strokes and branches are the same
type as clouds — they just carry `offsets`.

### Spaces

| Space | Meaning |
|---|---|
| `"uv"` | u right, v **down**, both 0..1 across a frame of `aspect`; z is depth −1..1, **+1 nearest the viewer** |
| `"3d"` | centred on the origin, roughly unit radius, y up |
| `"world"` | whatever the producer measures in. Never on a port — normalise to `"3d"` first |

Producers normalise **on publish**. A consumer should never have to know how the
producer measured things. `UnlimiterPorts.fitUV()` maps a uv laid out for one
aspect into a frame of another, contain-fit, so a circle stays a circle.

---

## Publishing a tool's ports

Load the module, then declare what the tool gives and takes, once, after its
state exists:

```html
<script src="unlimiter-drive.js"></script>
<script src="unlimiter-ports.js"></script>
```

```js
if(window.UnlimiterPorts){
  UnlimiterPorts.publish({
    tool: "flow-weave", label: "Flow Weave",
    outputs: { out:      { type:"image",  label:"image",    get: () => cv } },
    inputs:  { emitters: { type:"points", label:"emitters", set: setEmitters } }
  });
}
```

- `get()` is called only for outputs that are actually patched, so an expensive
  output (a GPU readback) costs nothing until someone wants it.
- `set(value)` is called every host frame with the current value, and **once
  with `null`** when the cable goes away — deleted, muted, or its producer gone.
  On `null`, fall back to the tool's own content.
- An output named `out` of type image replaces the host's guessing: the rack
  captures whatever it returns.
- `publish` throws on a malformed contract (an output without `get`, an unknown
  type), so the mistake shows up while the tool is being written.

A host reads the contract off the tool's own window:

```js
const io = UnlimiterPorts.read(toolWindow);   // null if the tool publishes nothing
```

Each iframe loads its own copy of the module, so each tool's contract lives on
its own window. A tool that publishes nothing keeps working exactly as before:
the rack falls back to its old behaviour for it.

## Receiving points — the pattern Flow Weave uses

```js
function setEmitters(frame){
  EM.src = frame || null;              // keep the reference; never mutate it
  if(!frame){ EM.n = 0; EM.ver = -1; }
}
// in the tool's own frame loop
if(EM.src && EM.src.version !== EM.ver){
  EM.ver = EM.src.version;             // only repack when the producer moved
  …read EM.src.positions / colors / presence…
}
```

Velocity, when a consumer needs it, is the change since the last *version* seen,
not since the last frame — so it is an impulse per real displacement whatever
the producer's and consumer's frame rates are.

## Rules

- **By reference, never copied.** Inside the rack every tool shares one JS heap:
  the frame Flow Weave holds is the very object the generator produced. So
  consumers must not mutate what they receive.
- **Structural checks, never `instanceof`.** A `Float32Array` from another iframe
  fails `instanceof Float32Array` in yours. The module's `isPoints` /
  `isField` / `isMask` use `ArrayBuffer.isView` and the internal type tag, and
  are tested against a value made in a foreign realm.
- **Publish on `window` explicitly.** A top-level `const` in a classic script is
  never a window property. The module does `globalThis.UnlimiterPorts = …`
  itself; a tool's contract is reached through that.
- **Fresh frames are visible.** `makePoints()` defaults presence, colour and size
  to 1, so a producer that fills positions and forgets the rest gets visible
  points, not silently invisible ones.

## Helpers

| Function | Does |
|---|---|
| `makePoints(capacity, space)`, `ensurePoints(frame, count, space)` | allocate, or reuse — growth goes to the next power of two so a wobbling count never reallocates every frame |
| `makeField(w, h)`, `makeMask(w, h)`, `bump(value)` | constructors; bump the version |
| `isType(type, v)`, `isPoints`, `isField`, `isMask`, `isImage` | cheap, cross-realm-safe validation |
| `normalize3d(src, centre, scale, out)` | world → `"3d"` |
| `project(src, view, out)` | `"3d"` → `"uv"` through `{yaw, pitch, roll, zoom, persp, aspect}` |
| `fitUV(u, v, srcAspect, dstAspect)` | contain-fit a uv into another aspect |
| `packVolume(src, cutoff, out)` | → the volume renderer's 16-float layout, reusing `out` |
| `publish(contract)`, `read(win)`, `compatible(a, b)` | the contract |

## Cost

Normalise + project + pack of 16,800 points: about 1.3 ms. The transport layer
is a small fraction of a frame; the generator itself is the cost.

## Testing

```
node test_ports.js      # values, validation, cross-realm, projection, packing, contract
node test_points.js     # the geometry module the generator nodes run
```
