# Overtone — generative music from the suite's systems (`overtone.html`, `unlimiter-music.js`)

The suite has been visual. Overtone makes sound out of the same parts: **points**
geometry, the **fluid**, **Lattice** tracking, **Drive** LFOs / clock / matrix,
**Dice**, and **Ports** — so you play the music by moving things the visual tools see.

`unlimiter-music.js` is the headless core (like `unlimiter-points.js`): no DOM, no
Web Audio, deterministic, tested with `node test_music.js`. `overtone.html` is the
tool: synthesis, fluid, scheduler, UI, Drive/Dice/Ports wiring, stem export.
`unlimiter-link.js` carries points between tabs.

## The score — where notes come from

**Score from** picks the points the synths read:

| Source | What it is |
|---|---|
| geometry | a Manifold-style cloud (form × placement × noise carve), evolving slowly |
| fluid | a stable-fluids sim (128×57, vorticity confinement) carrying up to 3000 particles. **Drag on the score** to push the fluid and lay particles down — each one is a note waiting for the playhead. Shift-drag scatters. Auto-stir jets keep it moving; **kick hits push the fluid**, so the drums reshape the melody |
| points in | live points from another tool — Lattice tracking your hands, a Vision node, a Manifold |

Each synth reads the score through a **lens**: one axis → time, one → pitch (always
in key), the third → velocity. Picture-space ("uv") scores keep their picture: x is
across the screen, higher on screen is higher pitch. Time axis **x** gives a scanning
bar; **angle** gives a radar sweep from the centre.

**Rhythm** per synth: *score* (the lens decides when) or *euclid* (hits / rotate decide
when, the score decides which note — the nearest occupied step). Pad: once a bar, or
on euclid hits held to the next. Drums are always euclid with a noise carve (*Chaos*).
The euclid rings beside the score draw every track's pattern for the bar.

## Drawn drums — patterns A–H and the chain

Each drum track's **Pattern from** is *euclid* (hits / rotate) or *steps* (drawn).
Draw straight into the grid under the score: click a cell to cycle
**hit → accent → roll → off**, drag to paint, right-click to erase. The first stroke
on a euclid track turns it into a drawn track and copies its euclid pattern into
every empty pattern, so nothing goes silent. A ✎ marks drawn tracks.

Eight patterns, **A–H**. The **chain** links them bar by bar: `A A A B`, `Ax3 C`,
`A*4 B*4`. *Follow chain* plays the chain and edits whichever pattern is playing;
untick it to loop the selected pattern while you work on it. The strip above the grid
shows the chain (click a slot to stop and loop that pattern) and the bank (click to
select, shift-click to append to the chain). *Variation → next* copies the pattern
into the next letter with kick pickups, a clap roll and hat fills, and sets up
`A A A B`. Copy / Paste / Clear / From euclid do what they say. Patterns save in
presets (`"x...x...x...x..."` strings: `.` off, `x` hit, `X` accent, `r` roll).
Chaos still adds ghost notes and drops plain hits on drawn tracks; drawn accents and
rolls always play.

## Rolls, fills and ratchets

- A drawn **r** cell always rolls. Each drum also has a **Roll chance**, likelier
  towards the end of the bar.
- **Rolls & fills**: *Roll speed* (32nds, triplets, 64ths, mixed), *Roll crescendo*
  (sub-hits climb to the beat), *Fill every* N bars (the last beat of that bar rolls).
- Bass and lead have a **ratchet chance**: a note repeats 2–4 times inside its step.
- Rolls are real notes: they show as ticks in the grid, go to MIDI out, the .mid and
  the stems.

## The 3D score

The built-in geometry is drawn and read in 3D. **Tilt**, **Turn** and **Spin (°/bar)**
turn the shape before the lenses read it — what faces you is what plays, so turning
the sculpture changes the melody. Drag on the score to orbit it by hand. The playhead
is a plane cutting through the shape (time axis x / y / z), or a half-plane sweeping
round it (angle). Spin and both angles are Drive targets: an LFO on Turn is a slowly
rotating melody. *View: flat* brings back the 2D lens plot. 3D points arriving from
another tool (a Manifold cable) are drawn and turned the same way.

**Depth →** decides what the third axis does to lead and bass notes: velocity (as
before), **pan** (each note placed in the stereo field by its depth), **cutoff**
(near notes bright, far notes dark) or **octave** (near jumps up, far drops down).

## Techno presets

Warehouse 132 · Detroit stabs 128 · Acid 303 136 · Dub chords 120 · Industrial 140 ·
Minimal click 125 · Peak time 138 — each with drawn drum patterns and a chain.
Presets don't touch your Drive routings.

## Points as a controller

Points arriving (Rack cable or another tab) always publish Drive sources:
`points.count`, `points.x`, `points.y`, `points.speed`, `points.spread`,
`points.motion`. Route them like an LFO: hand height → filter cutoff, motion →
wave wander, spread → reverb. *Use points to: stir + drive* also pushes the fluid
along each point's direction of travel (Lattice publishes velocity as tangents).
A Rack **field** cable (Vision motion, Rewind's mosh field) stirs the fluid too.

**Without the Rack:** open `lattice.html` and `overtone.html` as two tabs of the
same browser. Lattice now sends its points over `unlimiter-link.js` — only while a
tab is listening, 256 points at 20 fps. *Listen to* picks the sender.

## Synths — evolving wavetables

Bass, lead and pad play a 6-step wavetable: sine → triangle → saw → square → vox
(two formant humps) → glass (sparse partials). *Wave* sets the position; *Wave
wander* and *Wander rate* walk it on seeded noise; *Shimmer* breathes individual
harmonics. Every note crossfades from the wave at note-on to the wave at note-off,
so long notes evolve while they sound. The scope in each synth group shows the
wave right now. Lead voices: table, pluck (table through a snapping filter), fm
(table carrier, sine modulator).

## Mixer and FX

- Sidebar sections are coloured: **drums orange, synths violet, FX blue**.
- **Mute / Solo** on every track: in its group header, in the pattern grid, or by
  clicking its ring (shift = solo). Shift-click S adds to the soloed set.
- Per track: level, **pan**, **delay send**, **reverb send**.
- **Master FX** on the whole mix (returns included): filter (low/high/band-pass,
  cutoff, resonance), drive, bit crush, stereo width. Then **Space**: delay (synced)
  and reverb returns. All of it is Drive-routable.

## Export — stems for mastering

**● Capture** while you play: every note, every Drive move, fluid stroke and Lattice
gesture is logged with the parameters at that step. **Export stems .zip** renders the
capture offline (44.1 kHz, 24- or 16-bit):

- one WAV per track, all starting at 0:00 — own pan and sends, master FX optional,
  **no master compressor or clip**, roughly 10 dB of headroom
- `00-mix.wav` through the full chain (respects mute/solo)
- `overtone.mid` (one track per part, channels from MIDI out), `preset.json`, a README

With no capture it renders N bars with the parameters held still (Drive modulation is
a live thing). **Record live** still grabs the real-time output as webm/ogg.

## Suite hooks

- **Drive** — every continuous parameter is a target; structural ones (seed,
  rows/cols/shells, particle count, reverb size) are not. Sources: `music.*` (per
  track hit envelopes, energy, bar position, level), `points.*`, `fluid.energy`.
- **Rack** — Overtone is in the Rack's tool list (`+ Tool`). Hosted, it follows the
  **Rack's clock** and registers its sources in the Rack's Drive as `overtone.*`,
  so Source nodes can make any visual follow the music. (`rack.html` exposes its
  drive as `window.__rackDrive` for this.) Audio needs a click in the tool: use
  *Edit in stage* and press Play.
- **Ports** — out: `out` image, `score` points, `particles` (the fluid, for
  Ouroboros brushes or Flow Weave emitters). In: `points`, `field`.
- **Dice** — every target, plus the switches (scale, form, lens axes, rhythms,
  voice, filter type). Pans, drive and crush start unticked.

## Limits

- The Drive clock ticks on `requestAnimationFrame`: a backgrounded tab pauses it.
  Keep the tab (or the Output window) visible. Lattice in another tab keeps sending
  only while that tab renders — side by side windows, not background tabs.
- Stems render offline from the capture, so they match it note for note, but the
  live humanize randomness is baked in at capture time.
- Cross-tab points are capped at 256 per frame.
