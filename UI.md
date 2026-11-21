# Unlimiter UI standard

Every visual tool in the suite loads `unlimiter-ui.js` as its **first** script:

```html
<script src="unlimiter-ui.js"></script>
```

## Output window

`unlimiter-ui.js` pins an **OUTPUT** bar to the top of the sidebar. It is always visible and never inside a collapsible section.

- **⧉ Open output window**: a bare black window showing the tool's canvas (titled `UNLIMITER OUTPUT — <tool>`). It tries to open on the second display (Chrome asks once for window-management permission). Double-click it, or press **F** in it, for fullscreen. The cursor is hidden in it, and keys typed in it pass back to the tool.
- **⛶ Fullscreen** appears once the window is live. If Chrome refuses fullscreen from the control window, double-click the output window instead.
- **Keeps running while the control window is covered.** While the output is open, the tool's animation frames follow the output window's clock. The show keeps playing on the projector even when the control window is behind other windows. Closing the output hands the frames back.
- What it shows: the canvas the tool hands over (Drive's `getOutputCanvas`, or `UnlimiterUI.setSource(fn)`). Otherwise it shows the largest visible canvas, plus any canvases stacked exactly on top of it, drawn over the tool's background colour.
- WebGL canvases without `preserveDrawingBuffer` are copied right after each frame. WebGPU canvases are copied right after each `queue.submit`.
- Drive's **Open output window** button opens the same window, and `Drive.pushFrame` and `Drive.outputOpen` go through it.
- Same window works as a MetaMapper **+ Tab / window** source, or as an OBS window capture.

Options (on the script tag or `<body>`): `data-ulx-bar="off"` hides the bar when the tool has its own button (the Rack does this). `data-ulx-canvas="#id"` picks the canvas. A `<div data-ulx-output></div>` chooses where the bar goes, for tools without collapsible sections. Inside an iframe (a tool hosted by the Rack) the script does nothing.

API: `UnlimiterUI.openOutput(getCanvas?)`, `closeOutput()`, `isOpen()`, `toggleFullscreen()`, `setSource(fn)`, `pushFrame(canvas?)`, `onChange(fn)`, `outputWindow()`.

## Feeding MetaMapper (and other same-site pages)

`UnlimiterUI.feed()` returns a plain 2D canvas copy of the tool's output, refreshed after every frame while someone keeps asking for it. `UnlimiterUI.setHost(fn)` lets the page reading it lend its animation clock. While the tool's own window is minimized or hidden, the tool draws on the host's frames instead of freezing. MetaMapper's **+ Tool** uses both (its status shows `· direct`), so a tool window can be minimized during a show. If the host goes away, the tool falls back to its own clock.

Timers (`setTimeout` / `setInterval`) in a minimized window are still slowed by the browser. Tools should keep their animation in `requestAnimationFrame`.

## Sidebar order

Sections in a tool's sidebar run in this order. The tool's own sections keep their relative order in the middle.

| # | Group | Examples |
|---|---|---|
| — | **OUTPUT bar** (pinned) | output window, fullscreen |
| 1 | **Presets / Looks** | Presets, Looks |
| 2 | **Source / input** | Source, Source image, Input, Point source, Depth sensor, anything "— from the rack" |
| 3 | **The tool itself** | form, geometry, motion, colour… in the tool's own order |
| 4 | **View** | Camera (view), Display, View, Post, Afterimage, Canvas, Layout |
| 5 | **Rack data out** | Rack ports, Hand off |
| 6 | **Dice** | Dice — roll & evolve (starts collapsed) |
| 7 | **Drive** | Drive — audio, MIDI, modulation / Audio (starts collapsed) |
| 8 | **Record / Output settings** | export size, record settings, presets save/load |

When adding a section to a tool, put it in its group. `<details>` blocks in one run can be re-sorted with the classifier used for this pass (titles are matched by their first words).

Tools without collapsible sections (Starfold, Worldseed 1 & 2, Time Cube, Volume, Neko Gacha) have the OUTPUT bar under their header. The Rack keeps its own **Output window** button in the toolbar, which now opens the shared window.
