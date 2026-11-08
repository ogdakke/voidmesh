# Voidmesh: Feature Map (porting reference)

Source of truth: the Voidmesh web app, the rest of this repository, mapped at commit `42dd043`. Paths below are relative to the repo root.

Voidmesh is an infinite canvas. You drop media on it (images, videos, animated GIFs, SVGs), and every item gets its own real-time GPU effect stack: adjustments, then one effect shader, then post-processing. You can play video and GIFs in place, export the processed result per item (PNG/JPEG, MP4/MOV/GIF), and save the whole workspace as a `.vdmsh` zip.

This document describes behavior, not React structure. Where the web app has no such feature (for example resize handles or rotation UI), the absence is stated explicitly, so a port doesn't invent it.

---

## 0. Architecture in one paragraph (for orientation)

- `types/canvas.ts`: domain model (entity, shader params, viewport, palettes).
- `lib/config/index.ts` (`#config`): every default, range and tuning constant. **Most numbers in this doc come from here.**
- `engine/`: GPU-agnostic state (`canvas-store.ts`), input state machines (`canvas-input-controller.ts`, `canvas-selection-controller.ts`, `canvas-viewport-controller.ts`, `entity-drag-controller.ts`), RAF scheduler (`frame-loop.ts`).
- `renderer/`: WebGPU. Per-entity pipeline is `processing-pipeline.ts` + `shaders/*.ts` + `*.wgsl`. Canvas composition is `composition-pass.ts`. Export lives in `export-service.ts`, `video-exporter.ts` and `gif-export.ts`.
- `application/canvas/`: framework-free use cases (placement, cycling, serialization capture).
- `context/canvas-context.tsx`: all user commands (add/delete/duplicate/params/palettes/undo wiring/import/export).
- `hooks/`, `components/`: React adapters and UI.

Data flow: input → store mutation → frame loop decides whether a render is needed → renderer consumes an immutable `RenderState` snapshot. **Rendering happens only when something changed** (see §11).

---

## 1. Canvas

### 1.1 Coordinate system

- **World space**: unbounded 2D, +x right, +y down. Entity `position` is its **top-left corner** in world units. `size` is in world units.
- **Viewport** = `{ offset: Point, zoom: number }` (`types/canvas.ts`). `offset` is the world coordinate at the **top-left of the canvas**. `zoom` 1.0 = 100%.
- Conversions (`lib/canvas-math.ts`) include devicePixelRatio, because the GPU canvas is sized in physical pixels:
  - `world = (screen - containerTopLeft) * dpr / zoom + offset`
  - `screen = (world - offset) * zoom / dpr + containerTopLeft`
  - So at zoom 1, **one world unit = one physical pixel** (not one CSS pixel). A 1920 px image at zoom 1 on a 2× display covers 960 CSS px.
- Initial viewport: zoom 1, offset chosen so world origin (0,0) is at the **center** of the canvas (`calculateCenteredOffset`, `application/canvas/canvas-interaction.ts#initializeViewport`).
- On container resize, the viewport pans by half the size delta, so the center stays fixed (`resizeSurface`).
- **Viewport insets**: UI chrome can cover screen edges (`ViewportInsets {bottom, right}`). Fit/center math targets the uncovered area. On desktop the insets are effectively 0. Mobile uses 180 px bottom, 200 px right in phone landscape (`config.canvas.mobile`). Fullscreen mode forces zero insets.

### 1.2 Zoom

- Limits: `minZoom = 0.01`, `maxZoom = 10` (`config.canvas`).
- **Ctrl+wheel / ⌘+wheel / trackpad pinch** (the browser reports pinch as ctrl+wheel): multiplicative step, `zoom *= deltaY > 0 ? 0.955 : 1.045` per wheel event, clamped. Zooms **around the cursor** (the world point under the cursor stays fixed) (`CanvasViewportController.zoomByWheel/zoomAtScreenPoint`).
- Touch pinch and double-tap-hold-drag zoom (mobile) use **log-space rubber-banding** past the limits (`rubberBandZoom`, coefficient 0.55), plus zoom momentum. Desktop wheel zoom hard-clamps.
- **⌘/Ctrl+0**: animate to 100% around the canvas center, 250 ms, easeOutCubic (`resetZoom`).
- **F** (with a selection): fit the selection's bounding box to the view, 10% padding per side, 320 ms easeOutCubic. Zoom limits are _not_ applied to fit (`fitSelection`).
- **H**: "Center canvas". Despite the label it currently runs fit-selection with 10% padding (no-op without a selection) (`hooks/use-infinite-canvas-keybinds.ts`).
- **Double-click/double-tap an entity** (touch path): select it and fit it to view. Doing it again on the same entity animates back to the saved previous viewport. Any manual pan/zoom invalidates the saved viewport (`handleDoubleTapOnEntity`).
- Adding media via file picker or paste fits the new items to view (§2.3).
- All viewport animations: easeOutCubic. Durations are `zoomResetDuration 250`, `centerCanvasDuration 300`, `fitToViewDuration 320` ms. User input cancels any running animation.

### 1.3 Pan

- **Plain wheel / two-finger trackpad scroll**: pans. `offset += (deltaX, deltaY) * dpr / zoom`. No momentum on desktop wheel; trackpads supply their own inertia.
- **Space + drag**: a state machine `idle → ready (space down) → panning (pointer down) → panned (pointer up, space still held)`. The cursor changes (class `infinite-canvas--space`). **Tapping space without dragging = play/pause** the selected media (fires on keyup only if the state is still `ready`). Space is ignored while typing in inputs.
- **Middle-mouse drag: not implemented.** Right-click opens the context menu.
- Touch (mobile only): one-finger pan with momentum (velocity threshold 0.05 px/ms, max 2.2 px/ms), and two-finger pinch plus pan.

### 1.4 Background / grid

- A full-screen **two-level dot grid** drawn in a fragment shader (`renderer/dot-grid.wgsl`, `renderer/grid-pass.ts`, `calculateGridLevel` in `lib/canvas-math.ts`).
  - Base spacing `gridSize = 25` world units, dot radius `1.5` CSS px (× dpr), subdivisions `N = 5`.
  - Level = `floor(log(zoom)/log 5)`. Fine spacing = `25 * 5^-level`, coarse = fine × 5. Coarse dots are always visible. Minor-only dots fade in with an eased factor `t^5`, where `t` is the fractional level, so the grid never gets too dense or too sparse at any zoom.
  - Dots are antialiased with `smoothstep(r-0.5, r+0.5, dist)` in screen pixels.
  - Colors: light theme bg `[0.98,0.98,0.98]`, dots `[0.75,0.75,0.75]`. Dark theme bg `[0.023,0.023,0.03]`, dots `[0.15,0.15,0.15]` (`DEFAULT_GRID_CONFIG(_DARK)`). The theme follows `prefers-color-scheme`.
- **Snap to grid** (toggle with **G**, persisted): snap cell = `SNAP_GRID_SIZE = 25 × 5 = 125` world units. When on, drags snap the anchor entity's top-left to the nearest 125-multiple, with a small spring settle (response 0.1 s, damping 0.9), and newly placed media snaps too. The layout gap is also 125.

### 1.5 Optional full-canvas post effects (settings)

- **Canvas lensing** (`CanvasLensing` = `off | subtle | extreme`, default `off`, persisted): a screen-space lens-distortion pass over the whole composited canvas, with dispersion, reflection, occlusion and vignette. Presets live in `config.canvas.lens` (`renderer/viewport-lens-pass.ts`, `viewport-lens-distortion.wgsl`). This is polish, defer it.
- **WLUR** progressive-blur overlay under the UI chrome (`packages/wlur`, `renderer/wlur-overlay*.ts`). Polish, defer it.

---

## 2. Entities and media

### 2.1 Supported media (`types/canvas.ts` `MediaType`, `lib/media-loader.ts`)

| Type    | Detection                                                                   | Decoding                                                                                                      | Notes                                                                                                                                                          |
| ------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image` | `image/*` (not gif-animated, not svg)                                       | `createImageBitmap`                                                                                           | The bitmap is a **shared, ref-counted asset** (`MediaImageAsset {id, revision, alphaMode, imageBitmap, blob}`). Duplicates share pixels. JPEG is known opaque. |
| `gif`   | `image/gif` **and** has more than 1 frame                                   | custom decoder `lib/gif-decoder.ts` → `GifFrame[] {bitmap, delay ms, timestamp ms}`                           | A single-frame GIF becomes a static `image`. Playback advances on the CPU from per-frame delays.                                                               |
| `svg`   | `image/svg+xml`                                                             | Rasterized once to **1024 px on the longest axis** (aspect ratio from `viewBox`, else width/height, else 1:1) | Original SVG text is kept for save. Not re-rasterized on zoom.                                                                                                 |
| `video` | `video/mp4, mpeg, webm, ogg, quicktime, matroska` (`config.supports.video`) | `HTMLVideoElement` + first-frame bitmap. FPS detected and rounded to common rates (23.976…120)                | Has `duration`, `fps`, `hasAudio`, `alphaMode`. Rendered zero-copy as an external texture.                                                                     |

There are **no shapes, text, groups or frames.** Every entity is a media item.

Each media type also builds an **alpha hit grid** (16 px cells, alpha > 8/255, at least 1% coverage), so clicks on transparent regions of PNG/SVG/GIF fall through (`lib/alpha-hit-testing.ts`, `config.hitTesting.alphaGrid`). Videos with alpha are sampled live.

### 2.2 Entity data model (`ShaderCanvasEntity`, `types/canvas.ts`)

| Field                        | Type           | Behavior                                                                                                                                         |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                         | string         | `entity-N`, a monotonically increasing counter. After load, the counter resumes at max+1.                                                        |
| `name`                       | string         | The filename, else `Image N`. Duplicates get unique names via an allocator.                                                                      |
| `position`                   | Point          | Top-left, world units.                                                                                                                           |
| `size`                       | Size           | World units. **Initialized to the native pixel size** (SVG: the raster size). Never changed by any UI (no resize).                               |
| `originalSize`               | Size           | Native media pixels. Export uses this.                                                                                                           |
| `zIndex`                     | number         | Monotonic counter at creation. Higher draws on top. **No UI to reorder.** Duplicates go on top.                                                  |
| `rotation`                   | degrees        | Always 0 in practice. The renderer, hit testing, AABB and the drag "crossing" effect all support rotation, but **no UI sets it**.                |
| `locked`                     | bool?          | Locked entities are skipped by hit testing and marquee. **No UI sets it.** It is serialized.                                                     |
| `selected`                   | bool?          | Mirrors store selection.                                                                                                                         |
| `edited`                     | bool           | Serialized flag.                                                                                                                                 |
| `shaderType`                 | `ShaderType`   | One effect per entity (§4).                                                                                                                      |
| `shaderParams`               | `ShaderParams` | All effect, adjustment and post-process params, plus `palette`, `time` and `timeAutoPlay` (§4).                                                  |
| `originalPalette`            | ColorPalette?  | 6 colors extracted by k-means from the image/GIF first frame/SVG after add (async, in the background). Exposed as the "Original" palette option. |
| `playback`                   | PlaybackState? | Video/GIF only: `{isPlaying, currentTime, loop=true, playbackRate=1, muted=true, volume=1}` (`lib/media-playback.ts`).                           |
| `mediaSource`, `imageBitmap` |                | Media payload (see above).                                                                                                                       |
| `texture`, `textureDirty`    |                | Renderer cache plus a dirty flag that triggers re-processing.                                                                                    |

There are **no** per-entity opacity, hidden, blend mode, crop or flip fields.

### 2.3 Adding media (`hooks/use-image-input.ts`, `hooks/use-clipboard-paste.ts`, `application/canvas/entity-placement.ts`)

| Method                                                      | Anchor          | Select new | Fit to view                                                              |
| ----------------------------------------------------------- | --------------- | ---------- | ------------------------------------------------------------------------ |
| File picker ("upload" button, multiple files)               | viewport center | yes        | yes                                                                      |
| Drag-and-drop files onto canvas                             | drop point      | yes        | **no**                                                                   |
| Drag-and-drop a URL (`text/uri-list`/`text/plain`)          | drop point      | yes        | no. Shows a "Dropped Link" toast for at least 2 s                        |
| Paste (⌘V) image/video files from clipboard                 | viewport center | yes        | yes                                                                      |
| Paste a URL to media                                        | viewport center | yes        | yes. Fetches the URL, sniffs `content-type`                              |
| Paste a **same-origin Voidmesh URL with query params**      | n/a             | n/a        | **applies those effect params to the selection** instead of adding media |
| Paste **Voidmesh effects JSON** (`{"__voidmesh":true,...}`) | n/a             | n/a        | applies effects to the selection (§4.9)                                  |
| Drop a `.vdmsh`/`.studio` file                              | n/a             | n/a        | **opens the workspace** (replaces the canvas)                            |

**Placement** (`calculateLayout`):

- One item is centered on the anchor.
- Several items are sorted by area (largest first) and shelf-packed left to right, at most **4 columns** with a **125-unit gap**. The whole block is then centered on the anchor, and each position is snapped to 125 if snap is on.
- Load failures produce per-file toasts.

**New entity effect settings**: the new entity takes the shader type and params **currently in the URL**. The URL mirrors the selected entity's params (§7.4). In effect, _new media inherits the last-selected entity's effect._ With a fresh URL it gets the global defaults: **Dithering, Bayer 8×8, Black & White palette**.

- If the URL palette is "original", the entity starts with B&W and switches to its extracted palette when extraction finishes.
- Videos **autoplay** (muted, looping) when added.

---

## 3. Selection and manipulation

### 3.1 Selection rules (`engine/canvas-selection-controller.ts`, `engine/canvas-input-controller.ts`)

- Hit testing goes **top-most first** (descending z-order), skips locked entities, and is alpha-aware.
- **Click entity**: replace the selection with it.
- **Shift+click entity**: toggle it in the selection.
- **Click an entity that is already in a multi-selection**: on pointer-down it keeps the group (so you can drag the group). On release without movement (< 5 px), it collapses the selection to that entity.
- **Click an already-selected single animated entity (video/GIF)**: toggles play/pause.
- **Click empty canvas**: clears the selection and starts a **marquee**.
  - Marquee mode: plain → `replace`. Shift with an existing selection → `subtractive`. Shift with an empty selection → `additive`.
  - Anything intersecting the rectangle (AABB intersect, not containment) is included. Locked entities are excluded.
  - The selection updates live once per frame after the pointer moves at least 5 px. Rect style: border `rgb(59,130,246)` 2 px; fill `[0,0.1,1,0.15]` light / `[59,130,246,0.25]` dark (`config.selectionRectangle`).
- **Click empty space inside the multi-selection bounding box**: drags the whole group. A click there without moving clears the selection.
- **⌘/Ctrl+A**: select all. **Escape**: clear the selection.
- **ArrowUp / ArrowDown** (no modifier): cycle the selection to the next/previous entity in **insertion order** (not z-order), animating the viewport to fit it. Input is throttled while the animation runs (`application/canvas/entity-cycling.ts`).
- Visuals:
  - Each selected entity gets an outside selection border in the composition shader.
  - Multi-selection (2+) also shows a **bounding box**: same blue, 2 px, no fill (`config.multiSelectBoundingBox`).
  - The selected entity gets a **name label** pill above it: 14 px font, 8 px padding, max width 320 px, 8 px above the entity (`renderer/entity-label-pass.ts`).
- "Multi-select mode" exists in the store (a mobile toggle where taps toggle membership).

### 3.2 Move / drag (`engine/entity-drag-controller.ts`, `engine/entity-drag-visual.ts`)

- Pointer-down on an entity, then move → drags the target (the single entity, or the whole selection).
- While dragging, the selection moves by a **transient offset**. Geometry is committed once on release.
- **Drag visual**: after holding for 200 ms on desktop (100 ms on touch), the dragged entities spring-scale to **0.95** (response 0.2 s, damping 0.94). On the first movement they pop back (0.22 s, 0.4), and on release they spring back (0.3 s, 0.7). This gives a tactile "picked up" feel (`config.touch.dragVisual`).
- Snap-to-grid: see §1.4.
- **Drag moves are not undoable** (they bypass the undo stack). Only command-driven moves (`moveEntity` command) push undo.
- "Prism wake / crossing" polish: when a dragged card passes over another, an RGB-split wake effect is drawn (`renderer/overlap-crossing.ts`, `lib/config/overlap.config.ts`, setting "fancy effects"). Defer it.

### 3.3 Not implemented in the web app (do not port unless desired)

Resize handles, aspect lock, rotation handles, smart guides/alignment snapping, alignment/distribution, grouping, z-order commands (bring forward / send back), lock/unlock UI, hide/show, and arrow-key nudging (arrow keys are used for cycling and media scrubbing instead).

### 3.4 Duplicate / delete

- **Duplicate (⌘/Ctrl+D)**:
  - Clones all selected entities and offsets each by **(+30, +30)** world units. New ids and zIndex (on top), unique names, `shaderParams` copied.
  - Video/GIF media is cloned independently, with playback reset per `createDuplicatePlaybackState`. Image assets are shared by reference.
  - The new items become the selection. One undo step covers the whole duplicate.
- **Delete (Backspace on macOS, Delete elsewhere)**:
  - Removes the selection and pauses media. One undo step; undo restores the media and resumes playback if it was playing.
  - With "fancy effects → deletions" on, the deleted items **disintegrate into dust particles**: a GPU particle sim seeded from a texture snapshot, limited to batches of at most 32 entities (`engine/disintegration-controller.ts`, `renderer/disintegration-*.ts/wgsl`).
- **Clear workspace** (menu): removes everything, clears undo history, resets the viewport and counters.

---

## 4. Effects

Sources: `types/canvas.ts` (param types, enums, option labels), `lib/config/index.ts` (`shaderFeatures`, `shaderDefaults`, `glassKindResets`, `glitchKindResets`, `paramVisibilityRules`, `config.defaults.shaderParams`, `config.shaderParams`, `config.adjustments`, `config.postProcessing`), `lib/shader-defaults.ts`, `lib/get-effective-default.ts`, `lib/config/palettes.config.ts`, `application/canvas/palettes.ts`, `context/canvas-context.tsx`.

### 4.1 Model: one effect per entity, fixed pipeline

- Each entity has exactly **one** `shaderType` and one `ShaderParams` record. Effects **cannot be stacked or reordered**.
- The per-entity pipeline order is fixed:
  1. **blur**
  2. **adjustments** (brightness/contrast/saturation)
  3. the **effect shader**
  4. **post-processing** (chromatic aberration, bloom, grain)
  5. a source-alpha mask
- **Show Original** (`showOriginal`) bypasses the whole pipeline.
- Params are **per entity**. There are no global effect settings. Multi-selection edits apply the same delta to every selected entity, as one undo step.
- There is no per-effect enable flag; you pick an effect type. Post-process sub-effects have their own `enabled` flags (§4.8).
- **No named effect presets, no randomize.** The only "preset" mechanisms are:
  - palette presets (§4.6)
  - the per-type defaults applied when switching type (§4.5)
  - "Reset" (back to the global defaults, §4.11)
  - copy/paste effects (§4.9)

### 4.2 Effect types and exposed params

`ShaderType` (UI order and labels from `SHADER_TYPE_OPTIONS`): **Halftone, Blobs, Melt, Dithering, ASCII, Glass, Glitch**. All use `colorMode: "palette"`.

`shaderFeatures` decides which params each type exposes. For multi-selection, the UI shows the **intersection** across selected types (`getCommonFeatures`).

| Param          | dithering        | halftone | melt | blobs             | ascii                        | glass             | glitch                        |
| -------------- | ---------------- | -------- | ---- | ----------------- | ---------------------------- | ----------------- | ----------------------------- |
| size           | ✓                | ✓        | ✓    | ✓                 | ✓                            | ✓                 | ✓                             |
| intensity      | ✓                | ✓        | ✓    | ✓                 | ✓                            | ✓ ("Refraction")  | ✓                             |
| scale          | ✓¹               | ✓        | ✓    | ✓                 | ✓                            | ✓                 | ✓²                            |
| shape          | –                | ✓        | ✓    | ✓                 | –                            | –                 | –                             |
| preserveColors | ✓                | ✓        | ✓    | ✓                 | ✓                            | –                 | ✓                             |
| reversePalette | ✓                | ✓        | ✓    | ✓                 | ✓                            | –                 | ✓                             |
| showOriginal   | ✓                | ✓        | ✓    | ✓                 | ✓                            | ✓                 | ✓                             |
| palette        | ✓                | ✓        | ✓    | ✓                 | ✓                            | –                 | ✓                             |
| adjustments    | ✓                | ✓        | ✓    | ✓                 | ✓                            | ✓                 | ✓                             |
| postProcess    | ✓                | ✓        | ✓    | ✓                 | ✓                            | ✓                 | ✓                             |
| type-specific  | `dithering.kind` | –        | –    | `blobs.eagerness` | `ascii.kind`, `ascii.invert` | `glass.*`, `time` | `glitch.kind`, `glitch.angle` |

Conditional visibility (`paramVisibilityRules`):

1. Dithering `scale` is hidden for error-diffusion kinds.
2. Glitch `scale` is hidden for `channelShift`. `glitch.angle` is shown only for `channelShift` and `pixelSmear`.
3. Glass: `angle` and `caustic` only for **fluted**. `frostiness` and `highlight` only for **frostedVoronoi**. `flow` and `time` only for **flowing**. `dispersion` shows for all kinds.

One-line look per effect (algorithms omitted; see `renderer/*.wgsl` and `renderer/shaders/*.ts`):

| Effect    | Look                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| Dithering | Ordered dithering at a pixelation `size` with a palette. Kinds: Bayer 2×2/4×4/8×8, White Noise, Blue Noise. |
| Halftone  | A grid of shapes, one per `size` cell, sized by darkness.                                                   |
| Blobs     | Hex-staggered halftone dots that merge into metaballs by `eagerness`.                                       |
| Melt      | Cell shapes dripping downward; brighter cells drip further.                                                 |
| ASCII     | Character cells chosen by brightness from a charset (MSDF glyph atlas `public/media/ascii-atlas.*`).        |
| Glass     | Refraction through fluted ridges, a frosted Voronoi pane, or animated flowing glass. Not palette-based.     |
| Glitch    | Channel shift, scanline tearing, block corruption, or pixel smear, optionally snapped to the palette.       |

### 4.3 Shared params: types, ranges, defaults

UI ranges come from `config.shaderParams`. Global defaults come from `config.defaults.shaderParams`. "Default per type" is the effective default after a type switch (`getEffectiveDefault`: resetParams → mergeParams → global).

| Param            | Type                              | UI range / step                           | Global default               | Default per type (where different)                                                                                              | UI label / widget                                    |
| ---------------- | --------------------------------- | ----------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `size`           | int                               | 1–100, step 1                             | 1                            | halftone 10, blobs 10, melt 8, ascii 12, glass 6 (fluted 20, flowing 40), glitch 25 (blockCorrupt 8, pixelSmear 50, scanline 3) | "Size" slider                                        |
| `intensity`      | float                             | 0–5 (config step 0.01, slider step 0.1)   | 1.0                          | blobs 0.5, glass flowing 4, glitch blockCorrupt/pixelSmear 2                                                                    | "Effect Strength" slider (Glass: "Refraction")       |
| `scale`          | float                             | 0.1–3 (config step 0.01, slider step 0.1) | 1.0                          | blobs 0.5, melt 2.0, glass flowing 1.55                                                                                         | "Scale" slider                                       |
| `shape`          | enum `circle \| square \| rect_v` | select                                    | `circle`                     | melt `rect_v`                                                                                                                   | "Shape" select: Circle / Square / Vertical Rectangle |
| `preserveColors` | bool                              | toggle (key P)                            | false                        | blobs true, glitch true, dithering forced false                                                                                 | "Preserve" toggle                                    |
| `reversePalette` | bool                              | toggle (key R)                            | false                        | –                                                                                                                               | "Reverse" toggle                                     |
| `showOriginal`   | bool                              | toggle (key O)                            | false                        | –                                                                                                                               | "Original" toggle (eye icon)                         |
| `color`          | RGBA 0–1                          | none (legacy)                             | `[33,150,243]/255` (#2196F3) | –                                                                                                                               | –                                                    |
| `background`     | RGBA 0–1                          | none (legacy)                             | `[0,0,0,1]`                  | –                                                                                                                               | –                                                    |
| `palette`        | `ColorPalette` (2–16 colors)      | palette editor + preset select            | Black & White                | –                                                                                                                               | §4.6                                                 |

**Color mode (`ColorMode = "palette" | "bgFgColor"`).** The type exists, but every shader uses `"palette"`. `color` and `background` are legacy foreground/background colors with no UI.

- When the entity's palette has 2 or more colors, the palette drives output.
- Otherwise the renderer falls back to the two-color palette `[background, color]`.

For a port, **palette mode is the only mode**.

**Palette semantics, shared by all palette effects.**

- The first palette color acts as the **background** (the last color when `reversePalette` is on).
- The remaining colors are sorted by luminance and mapped by brightness.
- `preserveColors` keeps source colors instead of mapping to the palette:
  - dithering: per-channel 1-bit, so 8 RGB colors
  - halftone, blobs, melt, ascii: the shapes or glyphs take the source color
  - glitch: skips palette snapping

### 4.4 Type-specific params

| Effect          | Param              | Type      | Range / options (UI labels)                                                                                                                                                                                                                                                                                    | Default                       |
| --------------- | ------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Dithering       | `dithering.kind`   | enum      | UI "Algorithm": `bayer2x2` "Bayer 2x2", `bayer4x4` "Bayer 4x4", `bayer8x8` "Bayer 8x8", `whiteNoise` "White Noise", `blueNoise` "Blue Noise". Also in the enum but **hidden from the UI**: `floydSteinberg, atkinson, jarvisJudiceNinke, stucki, burkes, sierra, sierraLite` (compute-shader error diffusion). | `bayer8x8`                    |
| Blobs           | `blobs.eagerness`  | float     | "Eagerness" 0–1, step 0.01                                                                                                                                                                                                                                                                                     | 0.5 global, **0.4** on switch |
| ASCII           | `ascii.kind`       | enum      | "Character Set": `standard` " .:-=+_#%@" (10 levels), `extended` (49 chars), `binary` "01", `minimal` " .-+_#" (`ASCII_KIND_OPTIONS`)                                                                                                                                                                          | `standard`                    |
| ASCII           | `ascii.invert`     | bool      | toggle "Invert brightness"                                                                                                                                                                                                                                                                                     | false                         |
| Glass           | `glass.kind`       | enum      | "Glass Type": `fluted` "Fluted", `frostedVoronoi` "Frosted Voronoi", `flowing` "Flowing"                                                                                                                                                                                                                       | `frostedVoronoi`              |
| Glass (fluted)  | `glass.angle`      | float deg | "Angle" 0–360, step 1 (0 = vertical ridges, 90 = horizontal)                                                                                                                                                                                                                                                   | 0                             |
| Glass (fluted)  | `glass.caustic`    | float     | "Caustic" 0–2, step 0.01                                                                                                                                                                                                                                                                                       | 1.0 global, **0.1** on switch |
| Glass (frosted) | `glass.frostiness` | float     | "Frostiness" 0–1, step 0.01                                                                                                                                                                                                                                                                                    | 0.8                           |
| Glass (frosted) | `glass.highlight`  | float     | "Highlight" 0–1, step 0.01                                                                                                                                                                                                                                                                                     | 0.1                           |
| Glass (all)     | `glass.dispersion` | float     | "Dispersion" 0–1, step 0.01                                                                                                                                                                                                                                                                                    | 0.6                           |
| Glass (flowing) | `glass.flow`       | float     | "Flow" 0–1, step 0.01                                                                                                                                                                                                                                                                                          | 0.5                           |
| Glitch          | `glitch.kind`      | enum      | "Glitch Type": `channelShift` "Channel Shift", `scanline` "Scanline", `blockCorrupt` "Block Corrupt", `pixelSmear` "Pixel Smear"                                                                                                                                                                               | `channelShift`                |
| Glitch          | `glitch.angle`     | float deg | "Angle" 0–360, step 1                                                                                                                                                                                                                                                                                          | 0                             |

### 4.5 Switching type: resetParams / mergeParams

`applyShaderDefaults(current, fromType, toType)` (`lib/shader-defaults.ts`) does nothing when the type doesn't change. Otherwise it does two things in order:

1. `mergeParams` fills only missing values.
2. `resetParams` force-overwrites values.

All other params (palette, post-process, adjustments other than blur) carry over between types.

| Switch to | resetParams (forced)                                                                                                                                    | mergeParams (fill if missing)       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| dithering | size 1, preserveColors false, blur 0                                                                                                                    | dithering.kind bayer8x8             |
| halftone  | size 10, shape circle, scale 1.0, blur 0                                                                                                                | –                                   |
| blobs     | size 10, blobs.eagerness 0.4, scale 0.5, intensity 0.5, shape circle, preserveColors true, blur 0                                                       | –                                   |
| melt      | size 8, shape rect_v, scale 2.0, blur 0                                                                                                                 | –                                   |
| ascii     | size 12, scale 1.0, blur 0                                                                                                                              | ascii {kind standard, invert false} |
| glass     | size 6, intensity 1.0, scale 1.0, **postProcess.enabled true + chromaticAberration {enabled true, offset 6}**, glass {angle 0, caustic 0.1}, **blur 3** | glass {angle 0, caustic 0.1}        |
| glitch    | size 25, intensity 1, scale 1.0, preserveColors true, blur 0                                                                                            | glitch {kind channelShift, angle 0} |

Sub-kind switches also force-reset the tunables:

| `glassKindResets` | size | intensity | scale | blur |
| ----------------- | ---- | --------- | ----- | ---- |
| fluted            | 20   | 1         | 1     | 5    |
| frostedVoronoi    | 6    | 1         | 1     | 3    |
| flowing           | 40   | 4         | 1.55  | 0    |

| `glitchKindResets` | size | intensity | scale |
| ------------------ | ---- | --------- | ----- |
| channelShift       | 25   | 1         | 1     |
| blockCorrupt       | 8    | 2         | 1     |
| pixelSmear         | 50   | 2         | 1     |
| scanline           | 3    | 1         | 1     |

Changing the dithering algorithm or ASCII charset does **not** reset anything.

### 4.6 Palettes

`ColorPalette = { id?, name, shortName, colors: RGBA[] }` holds 2–16 colors (`MAX_PALETTE_COLORS = 16`).

- **13 built-in presets** (`lib/config/palettes.config.ts`), in this order:
  - Black & White (`#000`, `#fff`; the default)
  - Game Boy (4 greens, `#0f380f` → `#9bbc0f`)
  - Game Boy Pocket (4)
  - Game Boy Light (4)
  - Grayscale 4
  - Grayscale 8
  - Midnight Ablaze (7)
  - Sepia (5)
  - Winter (8)
  - Cyberpunk (6)
  - Sunset (5)
  - CGA (16)
  - Commodore 64 (16)

  Presets are shared by id.

- **Original** (id `original`): 6 colors extracted from the entity's own image by k-means right after it's added. The extraction samples a 100 px downscale over 10 iterations and skips transparent pixels (`lib/palette-extraction/*`, `extractOriginalPalette` in `lib/media-loader.ts`). It applies to images, the first GIF frame and SVGs; videos get none. Each entity has its own Original.
- **Extracted** (`ext_` prefix): "Extract Palette from Image" (inspector) or "Load Palette..." (context menu) opens an image picker and extracts **16** colors in the renderer's color space. The palette is saved as "Extracted N" (short "Extr. N") and applied to the selection as one undo step.
- **Custom** (`cstm_` prefix):
  - Editing a preset's colors (add/remove/change) creates a new custom palette named "Custom N".
  - Editing a user palette updates it in place.
  - User palettes can be renamed (max 64 characters) and deleted. Deleting one moves the selected entities that used it to the first preset.
  - User palettes persist in localStorage (`studio:customPalettes`) and inside `.vdmsh` files.
- **Editor**:
  - Add color: the new color is `[0.5, 0.5, 0.65, 1]`; disabled at 16.
  - Remove color: hidden at 2.
  - Clicking a swatch opens the color picker (§6.5).
- **Preset picker order**: the user's custom palettes, then extracted palettes, then presets, then this entity's Original (`buildPaletteList`).
- **Undo**: all palette operations bundle the palette-store change and the entity changes into one undo step.

### 4.7 Adjustments (applied before the effect)

| Param                    | UI label   | Range / step   | Default                  | Behavior                                                                                      |
| ------------------------ | ---------- | -------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| `adjustments.brightness` | Brightness | 0–1 / 0.01     | 0.5 (neutral)            | additive: `rgb + (b-0.5)*2`                                                                   |
| `adjustments.contrast`   | Contrast   | 0–1 / 0.01     | 0.5                      | `(rgb-0.5)*2c + 0.5`                                                                          |
| `adjustments.saturation` | Saturation | 0–1 / 0.01     | 0.5                      | HSL saturation × 2s                                                                           |
| `adjustments.blur`       | Blur       | **0–60** / 0.1 | 0 (glass presets 3 or 5) | Dual Kawase blur, up to 8 levels, with a crossfade between levels (`blurParamToKawaseParams`) |

### 4.8 Post-processing (applied after the effect)

`postProcess.enabled` is the master switch, default **true**. Sub-effects:

| Param                         | UI label                        | Range / step                                                              | Default                                    |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| `grain.enabled`               | Grain (checkbox)                | bool                                                                      | **true**                                   |
| `grain.size`                  | Grain Size                      | 1–10 / 1                                                                  | 1                                          |
| `grain.intensity`             | Grain Intensity                 | 0–1 / 0.01                                                                | 0.12                                       |
| `bloom.enabled`               | Bloom (checkbox)                | bool                                                                      | **true**                                   |
| `bloom.threshold`             | Threshold                       | 0–1 / 0.01                                                                | 0.5                                        |
| `bloom.intensity`             | Intensity                       | 0–1 / 0.01                                                                | 0.15                                       |
| `bloom.filterRadius`          | Spread                          | 0–100 / 1 (mapped to UV radius 0.001–0.03, `bloomFilterRadiusToRenderer`) | 21                                         |
| `bloom.softness`              | Softness                        | 0–1 / 0.01                                                                | 0.1                                        |
| `chromaticAberration.enabled` | Chromatic Aberration (checkbox) | bool                                                                      | **false** (switching to glass turns it on) |
| `chromaticAberration.offset`  | Offset                          | 0–10 / 1 px                                                               | 2 (glass 6)                                |

Notes:

- The comment in `types/canvas.ts` says offset 0–20, but the UI range is 0–10.
- Spatial params (size, dithering scale, blur, grain size, CA offset) are in **source-pixel units** and rescaled to the preview LOD, so the preview matches the native-resolution export.

### 4.9 Copy / paste effects

- **Copy effects** (⌃⌘C on macOS, Ctrl+Alt+C elsewhere, or the context menu "Copy/Paste as… ▸ Copy Effects"): writes `{__voidmesh: true, version: 1, shaderType, shaderParams, originalPalette}` of the **first** selected entity to the clipboard as JSON text.
- **Paste effects** (⌘V with a selection, or the context menu "Paste Effects"): if the clipboard holds that JSON, it applies `shaderType` and `shaderParams` to every selected entity as one undo step. Non-preset palettes are cloned into a fresh custom palette per target.
- Pasting a Voidmesh URL instead applies its query params (§7.4).
- Toasts: "Effects copied to clipboard", "Applied effects to N entities", "No effects or URL found in clipboard".

### 4.10 Time (animated effects)

- `time` (seconds, float) and `timeAutoPlay` (bool, default **true**) are per entity. Only **Glass → Flowing** reads them; it is the only continuously animated effect.
- While autoplaying, the renderer advances `time` by frame delta (capped at 0.1 s per frame) and the frame loop keeps rendering.
- The UI exposes a **Time** scrubber with play/pause (§6.7). Interacting with it syncs all selected entities to one time and pauses autoplay.
- Time edits are **not undoable**. Time is saved in `.vdmsh` (`shaderTime`, `shaderTimeAutoPlay`).
- In video/GIF export, time advances with the frame timestamp.

### 4.11 Global defaults for a new entity (`config.defaults`)

`shaderType = dithering`, plus:

```
size 1, shape circle, color #2196F3, background #000, preserveColors false,
reversePalette false, showOriginal false, scale 1.0, intensity 1.0,
blobs {eagerness 0.5}, dithering {kind bayer8x8}, ascii {standard, invert false},
glass {kind frostedVoronoi, angle 0, caustic 1.0, frostiness 0.8, highlight 0.1,
       dispersion 0.6, flow 0.5},
glitch {kind channelShift, angle 0},
palette Black & White,
postProcess {enabled, grain {on, size 1, 0.12}, bloom {on, 0.5, 0.15, spread 21, soft 0.1},
             chromaticAberration {off, 2}},
adjustments {brightness 0.5, contrast 0.5, saturation 0.5, blur 0},
time 0, timeAutoPlay true
```

- As noted in §2.3, new media actually inherits the **current URL state**, which mirrors the last-selected entity's effect. A desktop port can reproduce this as "new media gets the last-edited effect settings", or simply use these defaults.
- **Reset** (inspector button or context menu): sets every selected entity back to exactly these defaults, as one undo step.

---

## 5. Video / GIF playback

- State per entity: `PlaybackState {isPlaying, currentTime, loop (default true), playbackRate (1), muted (default true), volume (1)}`.
- Videos **autoplay muted and looped** when added. GIFs default to not playing unless restored as playing (§7).
- Controls:
  - **Space tap**: play/pause the selected media.
  - **Click a selected video/GIF**: toggles play/pause.
  - **M**: mute/unmute (video with an audio track only).
  - **←/→**: seek ±0.1 s, or ±1 s with Shift (only when the selection is a media item).
  - Progress bar scrubbing: pauses while scrubbing and resumes if it was playing (`hooks/use-media-controls.ts`).
- Audio: only videos. Preview audio comes from the `HTMLVideoElement`, muted by default. Audio is **passed through on export** (AAC demuxed with mediabunny, `lib/audio-demux.ts`).
- Playback rate and volume UI: not exposed (fields exist).
- Engine:
  - GIFs advance by frame delays on each RAF. Off-screen GIFs advance time but skip frame updates.
  - Videos use `requestVideoFrameCallback` to mark the texture dirty only when a new frame is decoded (`engine/frame-loop.ts`).
  - The **effect shader re-runs per new video/GIF frame**.
- The media controls UI (play button, mute button, canvas-drawn progress bar with time labels) appears for a selected video/GIF. Details are in §6.

---

## 6. UI panels and layout (desktop)

Mobile-only layouts exist and are out of scope: `components/mobile-layout.tsx`, `mobile-bottom/`, `mobile-controls.tsx`, `knobs/*`, `action-layer/` (a long-press radial menu), and `delete-drop-zone/`. `app.tsx` picks the mobile layout for narrow or touch viewports (width ≤ 1100 px without touch, or touch at ≥ 830 px) and the desktop layout otherwise.

### 6.1 Layout (`components/desktop-layout.tsx`, `styles/app.css`, `styles/sidebar.css`)

Three horizontal, resizable panels. The layout persists in localStorage as `studio-panels`.

| Panel                     | Width                   | Collapsible                        | Contents                                                                                                                                                                                                                                    |
| ------------------------- | ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Left sidebar              | 200–300 px              | yes (collapsed size 8 px hides it) | Static: heading "Voidmesh", blurb "Edit the look of your images and videos with different effects. All local, nothing gets uploaded.", and at the bottom a "Made by Daniel Wargh" link. **No layers list.** (`components/sidebar-left.tsx`) |
| Canvas                    | the rest                | no                                 | Rounded content card: 16 px radius, 1 px border, 8 px vertical margin, background `#fafafa` light / `#060608` dark. Holds the WebGPU canvas and floating chrome.                                                                            |
| Right sidebar (inspector) | 280–320 px, default 320 | yes                                | Upload, workspace actions, effect controls, export (§6.2)                                                                                                                                                                                   |

- **Resize handles** are invisible 1 px strips. A 4 px rounded bar appears on hover or drag.
- **"Fullscreen"** (`\` key, or the top-right button) collapses both sidebars, or restores them if either is collapsed. It is not browser fullscreen.
- **There is no top toolbar or menu bar.** Canvas chrome floats over the canvas (`components/infinite-canvas/canvas-overlay.tsx`):

| Position      | Controls                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| Top-left      | Settings button (vertical-dots icon) → Settings modal                                                                 |
| Top-right     | Fullscreen toggle (Enlarge/Reduce icon; tooltip "Fullscreen" / "Exit fullscreen")                                     |
| Bottom-left   | `?` About/help button, Undo, Redo (disabled with no history). "Skip onboarding" appears below them during onboarding. |
| Bottom-right  | "Center selection in view" (disabled with no selection); zoom readout `NN%` (click → animate to 100%)                 |
| Bottom-center | Media controls pill (§6.7), only for a selected video/GIF                                                             |

- **Error states:**
  - WebGPU missing: the text "WebGPU is not supported in your browser." plus the error message.
  - Canvas crash: the error boundary "Something blew up." with a "Reload" button.

### 6.2 Right sidebar / inspector (`components/sidebar-right-controls.tsx`)

Top to bottom. The middle area scrolls with a fade mask; the footer is pinned.

1. **"Add" button** (primary, image-plus icon): a multi-file picker for images and videos. Files are placed at the viewport center, selected and fitted. A divider follows.

**With no selection:**

2. A muted, centered message: "Drop or paste images, videos and links for editing" when the canvas is empty, otherwise "Select an image or video on the canvas to edit it".
3. **Workspace actions** (`components/workspace-actions/`): a split button.
   - Primary: "Open workspace".
   - A dropdown with:
     - the current file name as a label
     - "Save workspace" (⌘S; disabled when empty or busy)
     - "Clear workspace" (destructive; shows the toast "Workspace cleared / All resources were removed")

**With a selection:**

2. **Header**:
   - "Style" select (the 7 effects; shows "Mixed" if they differ).
   - Below it, an "Original" toggle (eye icon, key O) and a "Reset" button.
3. **▸ Adjustments** (collapsed by default): sliders for Brightness, Contrast, Saturation, Blur (§4.7).
4. **▾ Style Parameters** (open by default). Each control appears only if every selected entity supports it. In order:
   - Blobs: "Eagerness" slider
   - Glass: "Glass Type" select, then the kind's sliders (Angle, Caustic / Frostiness, Highlight / Flow) and "Dispersion"
   - Glitch: "Glitch Type" select, plus "Angle" for Channel Shift and Pixel Smear
   - Dithering: "Algorithm" select
   - ASCII: "Character Set" select plus an icon toggle "Invert brightness"
   - "Scale" slider
   - "Effect Strength" slider ("Refraction" for Glass)
   - **Palette editor** (§6.5), or the text "Mixed palettes", plus a quiet button "Extract Palette from Image"
   - "Palette Presets" select
   - Toggles: "Preserve" and "Reverse"
   - "Size" slider
   - "Shape" select (halftone, melt, blobs)
5. **▸/▾ Post Processing** (open when enabled). The header has a master checkbox (tri-state for mixed selections). Nested collapsibles, each with its own enable checkbox: **Grain** (Grain Size, Grain Intensity), **Bloom** (Threshold, Intensity, Spread, Softness), **Chromatic Aberration** (Offset) (§4.8).
6. **▸ Export** (collapsed by default; §9 and §6.8).

**Pinned footer:**

- the **Time** slider (only for Glass → Flowing; §6.7)
- the **Export Queue** panel (when jobs exist)

**Multi-selection display:**

- Labels gain " (Mixed)" and the numeric readout is hidden.
- Selects show "Mixed".
- Mixed toggles and checkboxes render as indeterminate; clicking sets all to true.
- A slider drag is one undo transaction across all selected entities.
- Param reads go through `hooks/use-param-value.ts`, returning `{value, isMixed, isSupported}`.

**Not present:** per-slider reset, double-click-to-reset, randomize, effect thumbnails or a gallery.

### 6.3 Widgets

- **Inspector slider** (`components/ui/slider/`):
  - A 2 rem tall rounded track with a fill bar. The label is drawn inside the track on the left and the value on the right (tabular, 5ch). A thin thumb line becomes opaque while dragging.
  - Click or drag anywhere on the track to set the value. Arrow keys step, Home/End jump to the bounds.
  - No fine-drag modifier, no wheel input.
  - The value readout is an **editable text field**: focus selects it and starts an undo transaction. Valid text applies live. Enter, blur or Escape commits, clamped to range. Up/Down arrows step.
  - Decimal places follow the step precision.
- **Select**: a base-ui dropdown with "Mixed" placeholder support.
- **Toggle**: a pill toggle button with an icon and label.
- **Checkbox**: tri-state.
- **Collapsible**: a section header with a chevron, optionally with a header checkbox.
- **InfiniteSlider** (`components/ui/infinite-slider/`), used only for Time on desktop:
  - A canvas-drawn tick ruler (ticks 2 px wide, 5 px apart, every 10th tick major) with a fixed center pointer. Dragging scrolls the ruler.
  - Rubber band at the bounds, fling momentum, snapping to ticks.
  - Wheel, arrow and PageUp/PageDown support. The commit fires 150 ms after it settles.

### 6.4 Context menu (`components/infinite-canvas/canvas-context-menu.tsx`)

Right-click; desktop only. Shortcut chips come from the keybind registry.

**On empty canvas:**

1. Paste (⌘V). Pastes clipboard media or a link at the click point.
2. Save/Open workspace… ▸
   - Save (⌘S) and Save as... (⇧⌘S), only if the canvas is non-empty
   - Open (⌘O)
3. ☐ Snap to Grid (G)

**On an entity** (it gets selected if it wasn't already):

1. "{n} items selected" label, for multi-selection only.
2. **Style ▸**: radio list of the 7 effects. When mixed, a disabled "Selection styles" list of current values comes first.
3. Type submenus, shown when supported: **Shape ▸**, **Algorithm ▸**, **Character Set ▸** with ☐ Invert Brightness, **Glass Type ▸**, **Glitch Type ▸**. Each shows current values when mixed.
4. **Palette Preset ▸** (custom, preset and original palettes) and **Load Palette...** (extract a palette from an image).
5. Checkboxes: ☐ Show Original (O), ☐ Preserve Colors (P), ☐ Reverse Palette (R). Mixed shows a minus icon and " (Mixed)".
6. **Copy Image** (⌘C), or **Copy Frame** for video/GIF. Single selection only.
7. **Save as… ▸**
   - Static entities: PNG, JPEG.
   - Animated entities: "Save Frame (PNG)", "Save Frame (JPEG)", or "Save {n} Frames (…)"; "Export" / "Export {n}" (adds to the export queue).
   - Mixed static and animated selection: also "Save All".
8. **Copy/Paste as… ▸**: Copy Effects (single selection only), Paste Effects (⌘V).
9. **Duplicate** / "Duplicate ({n})" (⌘D).
10. **Reset** / "Reset ({n})".
11. **Delete** / "Delete ({n})" (⌫ on macOS, Delete elsewhere), destructive style.

### 6.5 Palette editor and color picker

- **Palette editor** (`components/ui/color-palette/color-palette.tsx`):
  - Name: editable for user palettes; Enter commits, Escape reverts, an empty name reverts.
  - Count "n/16".
  - A horizontally scrolling row of swatches, shown in reversed order when Reverse is on.
  - "+" button: adds `[0.5, 0.5, 0.65, 1]`; disabled at 16.
  - Trash: deletes the palette; user palettes only.
  - Minimum 2 colors.
- **Palette Presets select** (`components/palette-preset/`): each item shows its name plus an inline swatch strip. Groups: "Custom Palettes", then "Palettes" (extracted, Original, built-ins).
- **Color picker** (`components/ui/color-picker/`), a popover anchored to the swatch:
  - A GPU-rendered **OKLCH** area: x = chroma 0–0.37, y = lightness. Arrows step 0.01, Shift steps 0.05.
  - A **Hue** slider (0–360) and an **Alpha** slider.
  - A format select, **P3** (`color(display-p3 r g b / a)`, the default when the display supports P3) or **Hex**, with an editable value field. Paste auto-detects the format.
  - An **eyedropper** (system EyeDropper API; hidden if unavailable).
  - A **Remove** button (only when the palette has more than 2 colors).
  - Updates are live, throttled to one per frame. One popover session = one undo step.

### 6.6 Dialogs, onboarding, toasts

- **Settings modal** (top-left button; `#settings`; `components/settings/settings.desktop*.tsx`, `settings.shared.tsx`):
  - **Canvas lensing**: radio cards Off / Subtle / Extreme, with preview sprites.
  - **Snap to Grid** switch.
  - **Fancy deletions** switch (the dust-disintegration effect).
  - **"Voidmesh" section**: Share (Web Share, or copy link) and Send feedback (mailto).
  - **"Onboarding" section**: "Redo onboarding" clears the canvas and restarts the intro.
- **About dialog** (`?` key or button; `#about`, `#shortcuts`, `#updates`; `components/about/desktop-about*.tsx`). A 3-page carousel with dots:
  1. **About**:
     - logo, "Voidmesh" and a tagline
     - an ASCII-rendered illustration
     - an "Effects" list (Dithering, Halftone, ASCII, Glass, Blobs, Melt, Glitch, each with a short description)
     - a "Features" list (Any media, Color palettes, Post-processing, Export PNG/JPG/MP4/MOV/GIF, Save & resume)
     - credits
  2. **Keyboard shortcuts**: grouped Global / Canvas / Selection / Video Playback, with `kbd` chips (`components/keyboard-shortcuts/`). The rows are generated from the keybind registry (§10).
  3. **Updates**: a changelog (`components/about/updates.tsx`).
- **Empty state / onboarding** (`hooks/use-onboarding.ts`, `lib/onboarding/*`):
  - On first run with an empty canvas, a **starter image** (`/favicon.webp`) is placed at the viewport center. This is not added to undo.
  - Desktop shows two **canvas callouts** anchored above it, rendered on the GPU (`renderer/canvas-callout-pass.ts`):
    1. "Select this image to edit its effects"
    2. "Delete by pressing backspace"
  - Each step completes when the user does it. "Skip onboarding" ends it.
  - Progress is stored in localStorage (version 1).
  - Otherwise, the empty state is just the sidebar message (§6.2) on the dot grid.
- **Toasts** (`components/ui/toast/`): top-center, 5 s default timeout, with title, description, optional action and close. They report every async outcome (copy, paste, import progress with Cancel, save, export failure, render failure).
- **Hints** (`application/hints.ts`) and the **PWA** update toast are web-specific; skip them.

### 6.7 Media controls and Time slider

- **Media controls** (`components/media-controls/*`):
  - A floating pill at the bottom-center of the canvas: 300–480 px wide, 60 px tall, 16 px radius, translucent background with a 12 px backdrop blur and a shadow.
  - Shown only when the selection is a single video/GIF. It animates in.
  - Three columns:
    - **Play/Pause**: icon cross-fade.
    - **Progress bar**: canvas-drawn. Current time on the left, duration on the right, formatted `S:cc` or `M:SS:cc` (centiseconds in a dimmer span; `lib/time-format.ts`). Drag to scrub; the track grows 50% taller while scrubbing. When focused: Space plays/pauses; `,` / `.` step one frame; arrows seek 1 s (Shift 10 s); PageUp/PageDown 10 s; Home/End.
    - **Mute**: only if the media has audio.
- **Time slider** (`components/desktop-time-slider/*`, `hooks/use-time-control.ts`):
  - In the inspector footer, only for Glass → Flowing.
  - Label "Time", a play/pause button (toggles `timeAutoPlay`), and an InfiniteSlider (step 0.005) that tracks `time` live while playing.

### 6.8 Export panel (inside the "Export" collapsible; `components/export-knobs/export-knobs.desktop.tsx`, `export-knobs.lib.ts`)

- **Video/GIF settings** (only if the selection contains a video or GIF):
  - "Format": MP4 (h.264) / MOV (h.264) / GIF.
  - "Quality": High / Medium / Low; not shown for GIF.
  - ▸ Advanced:
    - "Include Audio" toggle (MP4/MOV, when the source has audio)
    - "Frame Rate (FPS)" slider: 1–60, or 1–30 for GIF; defaults to the source fps or 30
    - "Resolution": Original / 1080p / 720p / 480p; not shown for GIF
    - GIF only: "Max Width" 100–1920, step 10, UI default 250; "Dither": Floyd-Steinberg / None
  - Button: "Export Video", "Export GIF", or "Export {n} Videos/GIFs".
- **Still settings**:
  - "Format": PNG / JPEG. Labelled "Format (frame export)" when the selection is animated.
  - Buttons: "Copy" / "Copy Frame" (single selection only) and "Save" / "Save Frame".
- **Export Queue** (`components/export-queue-panel.tsx`, pinned at the bottom of the inspector):
  - Title "Export Queue (n)", newest job first.
  - Each job shows its name, a progress bar, status text ("Queued", "Rendering f/total", "Encoding...", "Creating file...", "Extracting audio...", "Adding audio...", "Downloaded", "Failed", "Cancelled"), and × to cancel.
  - A "Clear" button removes failed and cancelled jobs.

### 6.9 Visual identity (`styles/variables.css`, `styles/globals.css`, `index.html`)

- **Theme**: follows the OS light/dark preference (`color-scheme: light dark`, `light-dark()`). There is no manual toggle.
- **Brand blue** `--primary`: `oklch(61% 0.23 253.3)` light / `oklch(62% 0.23 252.87)` dark (≈ `#0080FF`; Display P3 ≈ `0.098 0.486 0.996`). Primary buttons, the selection rect and borders use blue. The selection border is `rgb(59,130,246)`.
- **Destructive**: `oklch(0.65 0.3 29)`.
- **Neutrals**:
  - `--background`: white / `oklch(2%)`. Text: `oklch(2%)` / `oklch(98%)`.
  - Gray ramp `--gray-75` … `--gray-1600`.
  - Surface: `gray-100` / `gray-50`. The canvas card is `#fafafa` / `#060608`. The dot grid is described in §1.4.
- **Floating chrome**: the surface color at 90% opacity, `backdrop-filter: blur(12px)`, shadow `0 8px 20px` (0.12 alpha light, 0.5 dark).
- **Radii**: 2, 4, 6, 8, 12, 16, 32 px. Buttons are pills (999 px).
- **Spacing**: 4 px base. On screens of 200 dpi or more, spacing scales by 1.25.
- **Type**:
  - UI font is the system **rounded sans** stack (`ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, …`).
  - Scale: 0.625 / 0.75 / 0.875 / 1 / 1.25 / 1.75 / 2.25 rem.
  - Monospace only in the perf overlay.
  - **This code version (base `42dd043`) ships no pixel font.**
- **Icons**: Iconoir, stroke width 1.5.
- **Motion**: short (75–150 ms) cross-fades and view transitions; all respect reduced motion.
- **Loader**:
  - In this worktree: a blurred, rotating favicon in a 120 px circle, with "Loading..." below, shown for at least 800 ms.
  - **Brand direction (project memory, loader PR #125, merged after this base):** a brand-blue screen with a drifting white **8×8 Bayer dither** cloud, a **5×7 pixel-font** caption ("voidmesh", then esoteric lines such as "summoning shaders" and "dithering the void"), and a dithered circular reveal into the app. Identity should come from the effects themselves (dither, halftone, ASCII in brand blue), not generic UI. The OG image (blue with white dither) is the reference.

---

## 7. Persistence and projects

### 7.1 What persists automatically

- **There is no autosave of the canvas.** No IndexedDB/OPFS use for workspaces. Reloading the page loses the canvas unless the user saved a `.vdmsh`.
- **localStorage** (prefix `studio:`, via `unstorage`) holds preferences only (`lib/preferences.ts`):
  - `snapToGrid` (false)
  - `fancyEffects` (`all` unless prefers-reduced-motion, which gives `none`; values `none|all|deletions|prismWake`)
  - `haptics` (true, mobile)
  - `canvasLensing` (`off`)
  - `customPalettes` (user-created/extracted palettes, as an array of `ColorPalette`)
  - onboarding progress
  - hint dismissal (`lib/hint-storage.ts`)
- **URL query string** (nuqs) mirrors the selected entity's effect params (§7.4).

### 7.2 Workspace files (`.vdmsh`)

- **Save** ⌘/Ctrl+S:
  - If a file handle exists (opened or previously saved via the File System Access API), it overwrites that file.
  - Otherwise it shows a save picker with a random fun name, `adjective-noun-verb.vdmsh` (`lib/files/random-filename.ts`).
  - Without File System Access (Safari/Firefox), it downloads the file.
- **Save as** ⇧⌘/Ctrl+S: always shows the picker.
- **Open** ⌘/Ctrl+O: file picker accepting `.vdmsh, .studio, .zip`. Dropping a `.vdmsh` also opens it, and on Chromium captures the handle so a later Save overwrites it.
- Import shows a progress toast (reading, unzipping, parsing, "Importing item i of n", restoring) with **Cancel**. It is atomic: the old workspace is replaced only after everything decodes. Partial failure reports "Failed to import k of n files". Undo history is cleared on import.
- Code: `hooks/use-studio-file.ts`, `lib/download.ts`, `application/canvas/serialize-workspace.ts`, `lib/serialization/*`.

### 7.3 Archive format (`lib/serialization/README.md`, `types.ts`, `CURRENT_VERSION = 6`)

A zip archive. PNG encoding and zip compression run in a worker (`serialize-worker.ts`):

```
manifest.json
media/assets/<asset-id>-<revision>.png   # one PNG per shared image asset
media/<entity-id>.mp4|.webm|...          # video original bytes
media/<entity-id>.gif                    # GIF original bytes
media/<entity-id>.svg                    # SVG original text
```

`manifest.json` = `StudioManifest`:

- `{ type: "studio-canvas", version: 6, createdAt, viewport {offset, zoom}, entities[] (sorted by zIndex) }`
- v6 dedup tables: `shaderParamsTable[]`, `mediaFiles[]`, `originalPalettes[]`
- `palettes[]`: custom/extracted palettes referenced by entities

Each entity: `{id, name, position, size, originalSize, zIndex, rotation, locked, edited, shaderType, shaderParamsRef | shaderParams, shaderTime, shaderTimeAutoPlay, originalPaletteRef | originalPalette, mediaFileRef | mediaFile, mediaType}`.

- Video entities add `duration, fps, hasAudio, playback {currentTime, loop, playbackRate, muted, volume, isPlaying}`.
- GIF entities add `duration, fps, playback`.

Migrations step N→N+1 (`migrations.ts`). On load, entities that were playing resume, missing original palettes are re-extracted, and id/zIndex counters resume after the max.

A Rust port does **not** need format compatibility for a first version. It is still a good, simple design to copy: a zip containing a JSON manifest and the original media bytes.

### 7.4 Shareable URL state

The URL query mirrors the **selected** entity's params: `shader, size, shape, preserveColors, reversePalette, showOriginal, eagerness, scale, intensity, ditheringKind, preset, pp*` (grain/bloom/chromatic), `asciiKind, asciiInvert, glassKind, angle, caustic, frostiness, highlight, dispersion, flow, glitchKind, glitchAngle` (`context/canvas-context.tsx` `shaderUrlParams`).

- Pasting such a URL with entities selected applies those params to them.
- New media takes the current URL params (§2.3).
- After about 100 param edits, a hint suggests copying the link.
- Not relevant for a desktop port, except for the "new media inherits the last effect" behavior.

---

## 8. Undo / redo (`lib/undo.ts`, used throughout `context/canvas-context.tsx`)

- Command pattern `{execute, undo, onEvict, description}`. Undo and redo stacks are capped at **100** each. Transactions group several commands into one step. Evicted commands release media ownership (`onEvict`).
- Shortcuts: **⌘/Ctrl+Z** undo. Redo is **⇧⌘Z** on macOS and **Ctrl+Y** elsewhere. The UI also has undo/redo buttons (`components/infinite-canvas/undo-redo.tsx`).
- **Undoable**:
  - add entity (each add, including each pasted/dropped file)
  - delete (single or batch = one step)
  - duplicate (one step)
  - change shader type (single/batch)
  - every param change via the knobs (slider commits; multi-select = one step)
  - change palette, create/rename/delete custom palette, extract palette from image (palette store changes are bundled with the entity changes in one transaction)
  - paste effects / paste URL params (one transaction)
  - reset to defaults
  - `moveEntity` command
- **Not undoable**:
  - pointer **drag moves**
  - selection changes
  - viewport changes
  - playback/mute/seek
  - shader time autoplay/sync toggles
  - preferences
  - **clear workspace** and **workspace import** (both clear the history)

---

## 9. Export

All export is **per entity at native media resolution** (`originalSize`). Preview LOD is never used for export. There is **no export of the full canvas, a region, or a composite of several entities**. Multi-selection exports each entity separately.

### 9.1 Image export (`renderer/export-formats.ts`, `renderer/export-service.ts`, `context/canvas-context.tsx#saveSelectedEntityToFile`)

- Formats: **PNG** (quality 1, "Larger, lossless") and **JPEG** (quality 0.92, "Smaller, lossy"; extension `.jpg`). There is no scale option.
- **Save**: renders each selected entity through its full effect pipeline into an offscreen texture of native size, reads it back, and downloads it as `<base36 timestamp>-<name-without-ext>.<ext>`. Video uses the current frame, GIF the current frame.
- **Copy image (⌘/Ctrl+C)**: single selection only. Copies the rendered PNG to the clipboard and shows the toast "Image copied to clipboard".
- **Copy effects (⌃⌘C on macOS / Ctrl+Alt+C elsewhere)**: copies `{__voidmesh:true, version:1, shaderType, shaderParams, originalPalette}` as JSON text.
- Wide gamut: when the device supports Display P3, intermediate textures are `rgba16float` and exports carry P3 color (`renderer/gpu-color-space.ts`).

### 9.2 Video export (video and GIF entities only) (`renderer/video-exporter.ts`, `video-export.worker.ts`, `video-encode-core.ts`, `context/export-queue-context.tsx`)

- Formats: **MP4** (H.264), **MOV** (H.264, same muxer), **GIF**. There is no WebM.
- Options (`VideoExportOptions`, UI ranges in `config.videoExporting.ui`):
  - `fps`: default 30, range 1–60 (GIF 1–30, capped at 30)
  - `quality`: `high` (bitrate ×1.5, default) / `medium` ×1.0 / `low` ×0.6
  - `includeAudio`: default true for MP4/MOV
  - `advanced.bitrate`: kbps, 1,000–50,000
  - `advanced.resolution`: `original | 1080p | 720p | 480p`, aspect preserved, never upscaled, even dimensions
  - `advanced.gifDither`: `floyd_steinberg | none`
  - `advanced.gifMaxWidth`: 100–1920, default 256 in config
- Bitrate auto = `25 Mbps × (w·h / 1920·1080) × qualityFactor`. The codec level is picked by macroblock rate (`avc1.640029` L4.1 … `avc1.640034` L5.2). Keyframe every 2 s, constant bitrate, prefer-hardware, latency mode "quality", MP4 timescale 90 kHz (`config.videoExporting`, `getH264Codec`).
- Pipeline:
  1. Decode source frames with WebCodecs (mediabunny demux, `lib/video-demux.ts`) at the target fps.
  2. Render each frame through the entity's effect pipeline. A headless worker renderer is tried first, falling back to the main renderer.
  3. Encode H.264 in a worker and mux with mediabunny.
  4. Copy audio AAC packets through.
  - Animated shader time (`timeAutoPlay`) advances by frame timestamp, so animated effects animate in the export.
- GIF pipeline (`renderer/gif-export.ts`, gifenc):
  1. Render all frames.
  2. Downscale to max width.
  3. Build a global palette (128 colors) from sampled frames.
  4. Floyd–Steinberg dither, then encode (`lib/gif-encoder*.ts`).
- **Export queue**: jobs run **sequentially**. States are queued, processing, completed, failed, cancelled. Progress stages: extracting, encoding, muxing, extracting-audio, adding-audio, done. Jobs are cancelable. The result auto-downloads (`components/export-queue-panel.tsx`).
- Static images with an animated effect (Flowing glass) **cannot** be exported to video. They export as a still image of the current frame.

---

## 10. Keyboard shortcuts (complete)

Source: `hooks/use-infinite-canvas-keybinds.ts`, `hooks/use-canvas-surface-events.ts`, `components/about/desktop-about.tsx`, `context/keybind-context.ts`.

Contexts are hierarchical: `global ⊂ canvas ⊂ selection`. Canvas and selection shortcuts need the canvas to have focus. The active context is `selection` whenever something is selected. "Mod" = ⌘ on macOS, Ctrl elsewhere. Single-letter binds are case-insensitive.

| Keys                               | Context           | Action                                                                 |
| ---------------------------------- | ----------------- | ---------------------------------------------------------------------- |
| Mod+S                              | global            | Save workspace (overwrites the current file handle if any)             |
| Shift+Mod+S                        | global            | Save workspace as…                                                     |
| Mod+O                              | global            | Open workspace                                                         |
| `\`                                | global            | Toggle fullscreen (hides chrome/sidebars)                              |
| Mod+Z                              | global            | Undo                                                                   |
| Shift+⌘+Z (macOS) / Ctrl+Y (other) | global            | Redo                                                                   |
| D                                  | global (debug)    | Toggle debug mode (perf overlay/graph)                                 |
| ?                                  | global            | Open the About/help dialog (includes the shortcut list)                |
| Space (hold) + drag                | canvas            | Pan                                                                    |
| Space (tap)                        | canvas/selection  | Play/pause selected media                                              |
| H                                  | canvas            | "Center canvas" (fits the selection, 10% padding)                      |
| G                                  | canvas            | Toggle snap to grid                                                    |
| Mod+0                              | canvas            | Zoom to 100% (animated, around the center)                             |
| Mod+V                              | canvas            | Paste image/video/link to media (or effects/params onto the selection) |
| Mod+A                              | canvas/selection  | Select all                                                             |
| ↑ / ↓                              | canvas            | Select next / previous entity (insertion order) and fit it             |
| Escape                             | canvas/selection  | Clear selection                                                        |
| O                                  | selection         | Toggle "show original" (bypass effects)                                |
| P                                  | selection         | Toggle "preserve colors"                                               |
| R                                  | selection         | Toggle "reverse palette"                                               |
| F                                  | selection         | Fit selected to view                                                   |
| ← / →                              | selection (media) | Scrub −/+0.1 s, Shift = ±1 s                                           |
| M                                  | selection (media) | Mute/unmute                                                            |
| Backspace (macOS) / Delete (other) | selection         | Delete selected                                                        |
| Mod+C                              | selection         | Copy selected image (PNG, single selection)                            |
| ⌃⌘C (macOS) / Ctrl+Alt+C (other)   | selection         | Copy effects as JSON                                                   |
| Mod+D                              | selection         | Duplicate selected                                                     |

Mouse: Wheel = pan. Ctrl/⌘+wheel or trackpad pinch = zoom at cursor. Right-click = context menu. Shift+click = toggle selection. Shift+marquee = add or subtract.

---

## 11. Other notable behavior (performance, settings, polish)

- **Render on demand** (`engine/frame-loop.ts`). The RAF loop always ticks, but it **renders only if** something holds:
  - it is the first frame
  - the store has dirty flags (viewport, entities, geometry, selection, container size, callouts)
  - a GIF frame changed or a new video frame arrived
  - any entity has a continuous (time-animated) shader
  - a scheduler animation is active
  - a pointer drag or marquee is active
  - the renderer reports pending work (LOD transitions)

  Dirty flags are cleared after each frame.

- **Processed-texture caching**: an entity's effect output is cached and re-run only when `textureDirty` is set (param change, new media frame, LOD change). Pan and zoom only update uniforms; the scene is not rebuilt (`renderer/AGENTS.md`).
- **Shared GPU work by identity**: source/processed textures are keyed by asset + effect identity, so duplicates of the same image with the same params share the processing.
- **Preview LOD** (`config.rendering`):
  - Static images are processed at a quantized screen-space resolution tier: **64, 128, 256, 512, 1024, 2048, 4096** px max dimension, with 1.25× overscan.
  - LOD changes wait 2 settled frames. Each frame admits at most 4 transitions and 2 MP of work.
  - Spatial effect params are rescaled with render size, so the look is LOD-invariant.
- **Culling**: off-screen entities (10% buffer margin, `cullingBufferFraction`) are skipped. A spatial index (`lib/entity-spatial-index.ts`) serves hit tests, marquee and visibility.
- **GPU memory budgets**: entity textures 512 MiB (visible ones pinned), texture pool 64 MiB, blur/bloom scratch 128 MiB. All byte-bounded LRU.
- **Batching**: static images share instanced composition draws where z-order allows.
- **Settings panel** (§6): snap to grid, fancy effects (deletion dust, prism wake), canvas lensing (off/subtle/extreme), haptics (mobile).
- **Theme**: follows the OS light/dark preference (grid colors, selection fills, UI tokens). There is no manual toggle.
- **Errors**: WebGPU unsupported → a message on the canvas. Render errors → a destructive toast. Device-loss hooks exist.
- **Analytics** (PostHog), **PWA** update prompt, and **onboarding** (select the starter item, then delete it; §6) are web-specific.
- **Debug**: the `D` key toggles a perf overlay with a GPU frame graph (`engine/perf-overlay.ts`, `renderer/perf-graph-renderer.ts`). The `?debug=` URL param enables alpha/spatial debug views.

---

## 12. Suggested core scope for a first desktop port

Goal: capture the essence (an infinite canvas of media, each item live-processed by a palette-driven GPU effect) with the smallest surface. **P0 = must have for "it's Voidmesh"**; P1 = the expected next layer; P2/deferred = polish or web-specific.

### P0: core (in priority order)

1. **Canvas viewport and grid**
   - World/screen transform with dpr (§1.1).
   - Wheel pans; Ctrl/⌘+wheel and trackpad pinch zoom at the cursor (×0.955/×1.045 per event); zoom range 0.01–10.
   - Space+drag pan.
   - Two-level fading dot grid; light/dark colors (§1.2–1.4).
2. **Image entities**
   - Load PNG/JPEG/WebP via file open and **drag-drop** at the drop point. Native pixel size; multi-file shelf layout (4 columns, gap 125).
   - Entity model: id, name, position, size, originalSize, zIndex, shaderType, shaderParams, originalPalette.
   - Z-order by creation order.
3. **Per-entity effect pipeline on the GPU**
   - Blur, then adjustments, then **one effect**, then post-processing, then the alpha mask.
   - Effect output cached per entity and recomputed only when params change.
   - Start with **Dithering** (Bayer 2/4/8, white noise, blue noise; palette, preserveColors, reversePalette, size, scale, intensity), **Halftone** (circle/square/rect_v) and **ASCII** (MSDF atlas). These three carry the brand.
4. **Palettes**
   - The 13 presets; the "first color = background, rest sorted by luma" semantics.
   - Reverse and Preserve.
   - Per-entity **Original** palette via k-means (6 colors).
5. **Selection and move**
   - Top-most hit test (alpha-aware is nice to have; rectangle-only is acceptable at first).
   - Click, Shift+click, marquee (replace/add/subtract), Esc, ⌘A.
   - Drag selected entities, with the selection outline and multi-selection bounding box.
6. **Inspector panel** (right sidebar)
   - Style select; the type-specific selects; sliders with editable value fields; palette preset select; toggles; Adjustments and Post Processing collapsibles; Reset.
   - Mixed-value display for multi-selection.
   - The type-switch defaults (`resetParams`/`mergeParams`, §4.5).
7. **Undo/redo** for add, delete, duplicate, param edits (one step per slider drag), type change and palette change; 100 steps (§8).
8. **Delete, duplicate (+30,+30), keyboard shortcuts**: the §10 table minus the web-specific rows (O/P/R/F/G/H, ⌘0, ↑/↓ cycling).
9. **Image export**: the selected entity at native resolution through the full pipeline, to PNG or JPEG (§9.1). Copy to clipboard if the framework supports it.
10. **Render on demand**: redraw only on dirty state or active animation (§11).

### P1: next

1. The remaining effects: **Blobs, Melt, Glitch** (4 kinds), and **Glass** (fluted, frosted, flowing), including `time`/`timeAutoPlay` and the Time slider.
2. Post-processing details: bloom mip chain, grain, chromatic aberration.
3. **Workspace save/open**: a zip with a JSON manifest and original media bytes (§7.3); ⌘S, ⇧⌘S, ⌘O; dirty-file tracking. Format compatibility with `.vdmsh` is optional.
4. **Custom palettes**: palette editor (add/remove/edit/rename/delete), color picker (OKLCH area, hue, alpha, hex; P3 if available), extract a 16-color palette from an image, persist user palettes.
5. **Context menu** mirroring the inspector (§6.4).
6. **Copy/paste effects** between entities (§4.9). Paste images from the clipboard.
7. **SVG** (rasterized at 1024 px) and **animated GIF** (CPU frame timing, re-run the effect per frame).
8. Fit-to-selection (F), zoom-to-100% (⌘0), zoom readout, fullscreen (hide panels), snap-to-grid (125 units), arrow-key entity cycling.
9. Preview LOD tiers and culling, for performance with many or large images (§11).

### P2 / deferred

- **Video** playback and **video/GIF export**: decoding, audio, H.264 muxing, export queue. This is the largest subsystem; defer it unless the framework has media primitives.
- Fancy effects: disintegration dust on delete, prism-wake crossing, drag scale spring, canvas lensing, the WLUR progressive blur.
- Onboarding callouts, About carousel/changelog, Settings modal (add a minimal one when lensing or snap preferences are ported).
- URL state sharing, PWA, analytics, toasts beyond basic notifications, mobile layouts, the touch/action layer, haptics.
- Error-diffusion dithering kinds (hidden in the web UI anyway).

### Not in Voidmesh (don't add for parity)

Resize/rotate handles, layers panel, grouping, alignment/distribution, z-order commands, lock/hide UI, text/shape tools, effect stacking, effect presets, randomize, canvas or region export, autosave. Any of these would be new features, not port work.

---

## 13. Rune port status (`apps/desktop`)

The desktop port treats the canvas as the app: no sidebars. Chrome floats at the corners, and the
selection's controls ride along with it (a label bar, the inspector beside it, playback on the
clip). Settings are a view of their own inside the window (⌘,), never a separate window.

**Ported**

- Canvas: wheel pan, ⌘-wheel and pinch zoom about the pointer, Space-drag and middle-drag pan,
  fit (F/H), 100% (⌘0), two-level dot grid, snap to grid (G), hide the chrome (`\`). A window
  resize keeps the view's centre.
- Media: images (PNG/JPEG/WebP/BMP), animated GIF, SVG, and video (MP4/MOV/M4V, decoded with
  AVFoundation on macOS; autoplays muted and looped). File picker (⌘O) and drop (lands at the
  drop point, laid out as a batch: largest first, 4 per row, 125 gap). Paste (⌘V) of images,
  files and media paths.
- Selection: click, shift-click toggle, marquee (replace/add/subtract), group drag, ⌘A, Esc, ↑/↓
  cycling, a click on a selected GIF or video toggles playback. Picking is top-most first and
  alpha-aware (`hit.rs`, the web's 16 px cells): clicks on transparent regions of images, SVGs,
  GIF frames and video frames fall through.
- Commands: delete, duplicate (+30,+30, unique names), undo/redo (⌘Z, ⇧⌘Z, ⌘Y), reset; `?`
  opens the keyboard shortcuts (in Settings).
- Inspector: a multi-selection shows only the controls every selected effect has, with
  "(Mixed)" labels, Mixed selects and checkboxes, and mixed toggles that turn on for all. Slider
  readouts take typed values (live, clamped; ↑/↓ step; one undo step).
- All seven effects and their sub-kinds, palettes (13 presets, Original via k-means, user
  palettes; new media given Original takes its own), preserve/reverse/original (P/R/O), adjustments with the 0–60 Kawase blur mapping,
  grain, bloom, chromatic aberration, flowing-glass time with the tick-slider Time control.
- Palette editor and colour picker: rename, add, remove, delete, edit (a preset or Original forks
  into "Custom N"; one picker session is one undo step), OKLCH area, hue, alpha and hex; Load
  Palette… extracts 16 colours from an image. User palettes persist.
- Playback: Space, ←/→ seek, an inline scrubber on the clip with `S:cc` times, M and a mute
  button for videos with sound (sound plays through Rune's audio player and leads the clock).
  The focused scrubber takes Space, `,`/`.` frame steps, arrows, Page Up/Down, Home and End.
- Workspaces (`store.rs`): kept in the app's data folder and saved a moment after each change, and
  before switching away or quitting. Tabs in the titlebar (⌘T new, ⌘W close, ⌘1–9, ⌃Tab;
  double-click or right-click to rename), each with its own history; open tabs come back on
  launch. The library (⇧⌘O) lists, opens and deletes every workspace. Media is copied into a
  shared content-addressed blob folder on import.
- `.vdmsh`: opening one (⌘O, drop, launch arguments) imports it as a new workspace, reading
  every web manifest version (v1–v7) with progress and Cancel (Esc); ⇧⌘S exports v7.
- Clipboard: copy image (⌘C), copy effects (⌃⌘C), paste effects onto the selection (⌘V; user
  palettes come along as custom palettes).
- Context menu on entities and empty canvas, as §6.4 (native menus).
- Export: the selected entity at native resolution to PNG or JPEG (⌘E). Videos and GIFs export
  to MP4/MOV (H.264, audio passed through) or GIF through their effect, with fps, quality,
  resolution, bitrate and GIF options, in a sequential, cancelable queue (macOS).
- Preferences persist (snap, lensing, user palettes) in the app's config folder.
- Canvas lensing (off/subtle/extreme, L), drawn as a backdrop pass under the chrome.
- Light and dark from the system; the web app's tokens and primitives.

**Deliberate differences**

- Drag moves are undoable (one step per drag); the web app leaves them out.
- GIFs autoplay when added, like videos do on the web.
- Selects and the context menu open native macOS menus.
- No save step: workspaces autosave, ⌘S saves at once, and `.vdmsh` is an import/export format.
- ⌘O opens media as well as `.vdmsh` files.
- Error-diffusion dithering kinds (hidden in the web UI) load, save and round-trip, but draw as
  Bayer 8×8.
- Media renders at its native resolution up to the GPU's texture limit (16384 px a side);
  only larger media is downscaled to fit. SVG rasterizes at 2048 px (the web uses 1024).
- Show Original bypasses the whole pipeline, adjustments and blur included.

**Not yet**

- Exporting several clips at once ("Export n").
- Delete dust, prism wake, progressive blur under the chrome, onboarding.
- Video on platforms other than macOS.
- Opening `.vdmsh` from Finder (double-click, Open With): Rune has no document-open hook or
  bundle document types yet.
