# Starfold — galaxy generator

`galaxy.html`. A galaxy grown from a seed, rendered on the Volume engine, that
Worldseed systems can be flown into and out of.

## What it renders with

The splat pipeline is the one in `volume-renderer.html` (EWA covariance
projection, back-to-front counting sort, rgba16float target, bloom). Starfold
carries its own copy with these additions:

| Addition | Why |
|---|---|
| Per-source transform: offset, spin about Y, tilt about X | Galaxies turn, planets spin and orbit, without re-uploading splats |
| Differential spin (`spin.y` exponent) | Flat-curve or Keplerian rotation (belts use 1.5) |
| Floating origin | The camera target is the origin every frame. A 100-unit galaxy and a 0.003-unit planet share one frame with no float jitter |
| Splat class in `pos.w` | 0 star, 1 gas, 2 dust, 3 knot; +4 = lit by the source's light. Per-class alpha/brightness gains are uniforms, so gas, dust and knots can be modulated live |
| Star pixel cap | Past a few pixels, stars stop growing and get brighter, so flying through the disc shows points of light, not fog balls |
| Near fade for diffuse splats | Gas and dust thin out as the camera enters them |
| Mip-splat energy compensation | Sub-pixel stars keep their brightness, not their size |
| Raymarched haze | Emissive only, drawn under the splats, shaped by the same arm maths as the stars |
| Lens shift | The subject centres in the space left of the panel |

Dust is a splat class rather than part of the haze, so it sorts in with the
stars and really occludes them. That is what makes the lanes in an edge-on
view.

If this proves out, the transform/class/cap additions can move back into
`volume-renderer.html`. The two copies are kept apart for now so the Rack's
embedded renderer does not change underneath it.

## Parameters

`SCHEMA` follows Worldseed's shape (`g`, `id`, `l`, `min`, `max`, `step`, `v`,
`int`, `sel`, `chk`), with two extra flags:

- `live: true` — read while drawing. Registered with the Drive and in the
  Control Surface manifest. No rebuild.
- `sys: true` — rebuilds the systems only.

Everything else rebuilds the galaxy (about 0.3–0.5 s at the default 220k stars).

URL overrides work for any parameter: `galaxy.html?type=0&arms=2&seed=123`.

## Worldseed hand-off

Systems are kept in **Worldseed's own export format**
(`{stars, multi, belts, bodies:[{name, world:{p,seed,colors}, orbit, scale, spin, parent}]}`),
so they travel both ways without conversion. Procedural systems are written in
the same format, so any of them can be opened in Worldseed.

| Direction | How |
|---|---|
| Worldseed → Starfold | Worldseed's **Send to Galaxy** writes `localStorage["unlimiter.galaxy.inbox"]` and posts `{type:"inbox"}` on `BroadcastChannel("unlimiter-galaxy")`. An open Starfold tab answers `{type:"took"}`; otherwise Worldseed opens `galaxy.html#inbox`. Duplicates are skipped by `sentAt` |
| Starfold → Worldseed | **Open in Worldseed** writes `localStorage["unlimiter.galaxy.outbox"]` and opens `worldseed.html#from-galaxy`. Worldseed asks before replacing its system and backs the old one up to `worldseed.system.backup` |
| Pull | **Pull from Worldseed** reads `localStorage["worldseed.system"]` directly |
| Files | A Worldseed system export (`worldseed-system.json`) can be dropped onto Starfold. **Export system** writes the same format back |

All of this needs both pages on the same origin (GitHub Pages, or one local
server).

## Scale

`System scale` maps Worldseed units into galaxy units (default 0.012: a system
35 units across becomes about 0.4 of a 100-unit galaxy). Planet and star sizes
keep Worldseed's proportions, so a whole system reads as it does in Worldseed.

Only the focused system is built in full (stars, bodies, orbit paths, belts).
Every other system is a marker splat that turns with the galaxy.

## Automation

`?still` stops the render loop, and `?offscreen` composites into a private
texture instead of the canvas (headless Chromium cannot present a WebGPU
canvas). `window.Starfold` exposes `step()`, `snap()`, `capture()`, `flyTo()`
and `importSystem()` for scripted renders and tests.
