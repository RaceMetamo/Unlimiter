# Dice — roll, blend and evolve parameters (`unlimiter-dice.js`)

Drive moves a parameter *by a signal*. Dice moves the values underneath: it writes a tool's own base
parameters, the same ones the sliders write. So a roll behaves exactly like someone moving the sliders:
the tool's preset save keeps whatever you land on, and any Drive modulation still rides on top.

**Status**

| Tool | Dice | Switches it can flip (off until ticked) |
|---|---|---|
| ouroboros | yes | mirror mode, input blend, frame edges, auto brush motion |
| lattice | yes | palette, link colour, mesh, mesh fill, hair colour, motion history, Manifold forms A/B |
| manifold | yes | surface, placement, target form, which points, colour from |
| relief | yes | draw as, colour from |
| sediment | yes | colour from, blending, draw, shape, rotation — a finished painting restarts when dice moves something |
| anchor | yes | shape, rotation, colour from, size varies by, blending, draw — static renders redraw while values move |
| flow-weave | yes | — |
| melted-world | yes | — |
| flow-field-plotter | yes | — (no Drive, so no beat sync) |

## What it does

- **Roll** moves the ticked parameters toward random values. **Amount** is how far: 10% nudges, 100% goes anywhere in range.
  **Per roll** picks that many of the ticked parameters at random, or all of them. **Glide** sets how long the move takes.
- **Undo / Redo** covers every roll and recall.
- **Evolve** keeps rolling, either every N seconds or every N beats on the Drive clock (internal, tapped or MIDI). **Glide share** is the fraction
  of each interval spent moving. At 100% it never stops; lower values hold each look for a while before moving on.
- **Stay near home** draws every evolve roll around the look you set as home rather than from wherever it has drifted to, so a long
  show wanders without getting lost. **Set home** captures the current look as home. Starting Evolve sets a home if there isn't one yet.
- **Favourites** are six slots per tool. Click an empty slot to save, click a full one to glide back to it. Shift-click overwrites a slot and Alt-click
  clears it. **Evolve towards** can be new random values, the favourites (with a little wiggle scaled by Amount), or either.
- **What the dice can change** lists every parameter, grouped like the panel. Tick or untick single parameters or whole groups. Rack-input
  sliders and a few that can blank the picture (Lattice's motion gate, tracker settings) start unticked. Switches (palettes, modes) are
  listed under *Switches*, start unticked, and flip with a chance that grows with Amount.

Settings, ticks, home and favourites persist per tool in this browser (`localStorage`, key `unlimiter.dice.<tool>`).
Evolve also resumes after a reload, so a show survives a refresh.

## Wiring a tool

```js
<script src="unlimiter-dice.js"></script>

const dice = UnlimiterDice.create({
  tool: "ouroboros",
  get: k => P[k], set: (k, v) => { P[k] = v; },
  // Drive targets are by definition safe to change every frame; the element gives min/max/step
  params: UnlimiterDice.fromDrive(Drive, k => rows[k] && rows[k].querySelector("input[type=range]")),
  refresh: k => bound[k] && bound[k](),     // put a value back on its slider, no side effects
  switches: [{ key:"mirrorMode", label:"Mirror mode", el: rows.mirrorMode.querySelector("select") }],
  drive: Drive,                              // beat-synced evolve
  off: ["rkStr"],                            // listed, but not ticked to begin with
  onChange: () => {}, changeMs: 300          // optional, throttled while values move
});
dice.mountPanel(document.getElementById("g-dice"));
```

Without `refresh`, dice puts each value back on its slider by setting the element and firing its
`input` event. That is what Flow Weave, Melted World and the Plotter use. `fromTargets(table, elOf)` builds the list from the older
`{key:{label}}` target tables. Switches are applied by setting the `<select>` and firing `change`, so
the tool's own side effects run.

Only parameters the tool already exposes to Drive are rolled. Structural ones (counts that reallocate
buffers, resolution, source choice) are left alone on purpose.
