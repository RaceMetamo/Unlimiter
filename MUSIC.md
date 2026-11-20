# Overtone — generative music from the suite's geometry (`overtone.html`, `unlimiter-music.js`)

The suite has been visual. Overtone makes sound out of the same parts: the
**points** geometry is the score, the **Drive** LFOs / clock / matrix modulate
the synths and the pattern, **Dice** rolls and evolves the whole piece, and the
**Ports** carry the score in and out as ordinary points.

`unlimiter-music.js` is the headless core (like `unlimiter-points.js`): no DOM, no
Web Audio, deterministic, tested with `node test_music.js`. `overtone.html` is the
tool: synthesis, scheduler, UI, Drive/Dice/Ports wiring.

## Where the notes come from

| Part | Source |
|---|---|
| kick, clap, hat, perc | `euclid(hits, 16, rotate)` is the skeleton. A 3D value-noise field (step × part × slow bar-time, seeded) then **drops** some hits and adds **ghost** hits — the Manifold "carve" idea applied to a step grid. *Chaos* sets how much. |
| lead, bass | A points frame read through a **lens**: one axis → time (x, y, z or angle), one → pitch (x, y, z or radius), the remaining axis → velocity. Pitch is a scale degree, so every note is in key. Density thins to the strongest notes, evenly per beat. |
| pad | four bar-sized bins of the same frame vote for a chord degree (stacked thirds). |

Lead and bass look at **the same geometry** through different lenses, so they are
related but never the same line. Geometry evolves slowly (*Evolve rate*), so the
melody morphs rather than loops identically. Change *Form* / *Placement* and the
whole tune changes character.

## Suite hooks

- **Drive** — every continuous parameter is a Drive target (`registerMod`, same
  pattern as Ouroboros); structural ones (seed, rows, columns, shells, reverb
  size) are `noMod`. Overtone also **publishes sources**: `music.kick … music.pad`
  (per-part hit envelopes), `music.energy`, `music.step`, `music.level`. The
  scheduler is slaved to the Drive clock (`Drive.state.clock.beats`), so tap
  tempo / MIDI clock lead it and every tool on the page shares the beat.
- **Dice** — all drive targets are rolled; scale, form, placement, lens axes,
  lead voice and delay time are dice *switches*. Evolve on the beat clock gives a
  set that keeps changing.
- **Ports** — outputs `out` (image) and `score` (points, `uv`: x = time,
  y = pitch, z = velocity, size flares on a hit). Input `score` (points): any
  points cable — Manifold, a Vision node, Lattice — becomes the score for lead,
  bass and pad. Cut it and Overtone returns to its own geometry.
- **Bus** — if a page loads `unlimiter-bus.js`, `music.*` envelopes are published.

## Output

- **MIDI out** (Web MIDI, Chromium, https/localhost): per-part channel, drums send
  GM notes (36/39/42/37). Untick *Internal audio* to drive hardware only
  (TR-8S, MC-707, deconstruct MINIMAL…). Tempo is not sent.
- **Export MIDI** — N bars, format-1 SMF, one track per part.
- **Bounce WAV** — offline render at the *current* parameters (live Drive
  modulation is not applied; it is a live thing). **Record** captures the live mix.

## Limits worth knowing

- Timing follows the Drive clock, which ticks on `requestAnimationFrame`: a
  backgrounded tab pauses it. Keep the tab (or the Output window) visible.
- The synths are deliberately simple (subtractive / FM / noise). The point is the
  generative layer; voices are one function each in `VOICE` and easy to replace.
- Overtone's own sources reach another tool only if that tool shares its Drive
  or bus. Inside the Rack the Rack's drive is separate — see "Next".

## Next (not built)

1. Expose `music.*` to the Rack's signal nodes (a hosted-tool source list, or
   the cross-tab bridge) so one patch cable makes the visuals follow the music.
2. Add Overtone to the Rack's tool list (ports are published already).
3. Field/mask inputs: a flow field steering the lens angle, a mask gating notes.
4. Per-part geometry slots instead of one shared cloud.
