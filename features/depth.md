# Depth Estimation Feature

Per-entity depth maps via Transformers.js (Depth Anything V2 Small), used as auxiliary textures in the shader pipeline for depth-aware effects.

## What's implemented

### Core pipeline

- **DepthService** (`renderer/depth/depth-service.ts`) — Lazy-loaded Transformers.js pipeline, `device: 'webgpu'`, `dtype: 'fp16'`. ~50MB model, browser-cached via Cache API. Converts `ImageBitmap → OffscreenCanvas → RawImage.fromCanvas()` for pipeline input.
- **GPU texture storage** — `#entityDepthTextures: Map<string, GPUTexture>` in `canvas-renderer.ts`. `rgba8unorm` format. 1x1 mid-gray fallback texture when no depth exists.
- **Shader integration** — `supportsDepth()` opt-in on `ShaderPass` subclasses. Depth texture bound at group 0, bindings 3-4. `hasDepth` uniform at u[19] packs: bit 0 = enabled, bit 1 = invert, bits 16-31 = influence (uint16 → 0.0-1.0).
- **Depth-aware shaders** — All 7 shaders support depth. Halftone, blobs, melt, glass, glitch, dithering (ordered), ASCII. Depth modulates dot size, blob radius, drip distance, refraction strength, glitch displacement, dithering threshold, character density. Pattern: `mix(0.4, 1.6, depth)` scaled by influence.

### UI

- **Desktop sidebar** — `components/depth-knobs.tsx` in "Depth" collapsible section. Generate/Clear buttons, influence slider, invert toggle, visualize toggle.
- **Desktop context menu** — `DepthMenuItems` submenu in `canvas-context-menu.tsx`. Generate, Clear, Invert checkbox, Visualize checkbox.
- **Keyboard shortcuts** — `Shift+D` generate depth, `Shift+Alt+D` clear depth, `Alt+D` toggle visualization. Registered in selection context in `infinite-canvas.tsx`.

### Depth visualization

- `depth.showDepth` flag in `DepthParams`. When true, renders depth texture directly via `CopyPass`, bypassing shader processing (same pattern as `showOriginal`).

### Types & config

- `DepthParams { influence, invert, showDepth? }` in `types/canvas.ts`
- Defaults: `{ influence: 1.0, invert: false }` in `lib/config/index.ts`
- `"depth"` in all 7 shader feature param lists
- `depthInfluence` slider range config (0-1, step 0.01)

### Static image export

- Works implicitly: `ExportService.#applyShader` calls `#applyShaderToTexture` which looks up entity depth from the map. Static exports respect depth-modulated effects.
- `showDepth` visualization is handled in the `applyShader` callback, rendering depth texture directly via `CopyPass` in export.

### Serialization (.vdmsh)

- On save: `getDepthTextureBitmap(entityId)` reads depth texture back to CPU, encodes as grayscale PNG, stores as `depth/{entityId}.png` in the zip
- On load: depth PNGs decoded to `ImageBitmap`, uploaded to GPU via `uploadDepthBitmap(entityId, bitmap)`
- Backward compatible — old files without depth load fine, no version bump needed

### Undo/redo

- `estimateDepth()` pushes undo command (undo clears texture, redo re-estimates)
- `clearDepthMap()` saves depth bitmap before clearing for undo restoration, `onEvict` closes saved bitmap

### Entity duplication

- `cloneDepthTexture(sourceId, targetId)` performs GPU-side `copyTextureToTexture` so duplicated entities retain their depth maps

### URL state sync

- `depthInfluence` and `depthInvert` synced to URL via `shaderUrlParams`
- Updated in `buildShaderParamsFromUrl`, entity→URL sync, `setRenderStateFromURL`, and multi-select null clearing

### Depth-of-field post-processing

- `DepthOfFieldParams { enabled, focalDepth, focalRange, blurStrength }` in `PostProcessParams` (`types/canvas.ts`)
- Integrated into the existing post-process shader (`renderer/post-process.wgsl`): samples depth texture, computes circle-of-confusion via `smoothstep(0, focalRange, |depth - focalDepth|) * blurStrength`, mixes sharp source with pre-computed Kawase blur
- DoF blur uses 4-level Kawase downsample/upsample with dedicated mip chain cache in `ProcessingPipeline`
- Depth and DoF blur textures bound at post-process bindings 4-5 (with 1x1 fallbacks when disabled)
- `FLAG_DOF = 8u` in `enabled_flags` uniform, DoF params at uniform offsets 40-48
- **Desktop sidebar** — "Depth of Field" collapsible in `post-processing-knobs.tsx` with Focus, Range, Strength sliders
- **Mobile** — 3 DoF params added to `PostProcessParamsInOrder` in `knobs/post-process-knobs.tsx`
- Defaults: `{ enabled: false, focalDepth: 0.5, focalRange: 0.2, blurStrength: 0.5 }`

---

## Missing features

### P1 — Dithering error diffusion depth

Dithering ordered (fragment) shaders support depth, but the compute path (error diffusion: Floyd-Steinberg, Atkinson, etc.) does not yet. Depth would need to be an additional binding (4) in the compute bind group layout and `dithering-compute.wgsl`.

**Files:** `renderer/shaders/dithering-shader.ts` (`#executeCompute`, `#createComputePipeline`), `renderer/dithering-compute.wgsl`

---

### P2 — Video/GIF depth

#### Per-frame depth estimation

Currently only single-image depth. Animated entities need per-frame depth maps.

**Architecture:**

1. Run DA V2 per-frame independently
2. Apply temporal smoothing via WebGPU compute pass (EMA + edge-aware bilateral filter)
3. Store as `#entityDepthFrames: Map<string, GPUTexture[]>`
4. During rendering/export, look up current frame's depth texture

**Temporal smoothing WGSL:**

- Input: current frame depth + previous frame depth
- Output: smoothed depth
- Prevents flickering between frames

**Considerations:**

- GIF frames are typically few (~10-100), manageable total processing time
- Video frames: process on-demand or during export, show progress toast
- Queue management: follow `UpscaleService` pattern (sequential, progress, cancellation)
- Memory: 1 byte/pixel × resolution × frame count. 1080p × 300 frames ≈ 600MB — may need streaming approach for long videos

**Files:** `renderer/depth/depth-service.ts` (add `estimateVideoDepth`), `renderer/depth/temporal-smooth.wgsl` (new), `renderer/canvas-renderer.ts`

#### Video/GIF export with depth

Export pipeline needs to swap depth texture per-frame during `renderFrameWithShader`.

**Files:** `renderer/export-service.ts`, `renderer/video-exporter.ts`, `renderer/gif-export.ts`

---

---

### P4 — UI & UX

#### Mobile depth controls

No depth UI exists on mobile. Options:

1. Add depth button to the action layer radial menu
2. Create a depth drawer (like `upscale-drawer.tsx`)
3. Add depth controls to mobile controls panel

**Files:** `components/action-layer/`, `components/mobile-controls.tsx`

#### Model download progress

First-time depth estimation triggers a ~50MB model download. No progress indication currently — the button just says "Estimating...". Should show a toast with download progress.

**Files:** `renderer/depth/depth-service.ts` (add `progress_callback`), `context/canvas-context.tsx`

---

## Architecture notes

### Bind group layout (current)

**Shader passes:**

| Binding | Halftone/Blobs/Melt/Glass/Glitch/Dithering(ordered) | ASCII             | Dithering (compute) |
| ------- | --------------------------------------------------- | ----------------- | ------------------- |
| 0       | uniform                                             | uniform           | uniform             |
| 1       | source tex                                          | source tex        | source tex          |
| 2       | sampler                                             | sampler           | output tex          |
| 3       | **depth tex**                                       | **depth tex**     | error buffer        |
| 4       | **depth sampler**                                   | **depth sampler** | —                   |
| 5       | —                                                   | atlas tex         | —                   |
| 6       | —                                                   | atlas sampler     | —                   |

**Post-process pass:**

| Binding | Resource         |
| ------- | ---------------- |
| 0       | uniform          |
| 1       | source tex       |
| 2       | sampler          |
| 3       | bloom tex        |
| 4       | **depth tex**    |
| 5       | **DoF blur tex** |

### Uniform packing (u[19])

```
Bits 0:     hasDepth (0 or 1)
Bit  1:     invert (0 or 1)
Bits 16-31: influence as uint16 (0-65535 → 0.0-1.0)
```

WGSL decode:

```wgsl
let depthEnabled = (uniforms.hasDepth & 1u) == 1u;
let depthInvert = (uniforms.hasDepth & 2u) != 0u;
let depthInfluence = f32(uniforms.hasDepth >> 16u) / 65535.0;
let depth = select(rawDepth, 1.0 - rawDepth, depthInvert);
let depthMod = mix(0.4, 1.6, depth);
let depthScale = select(1.0, mix(1.0, depthMod, depthInfluence), depthEnabled);
```

### Model info

- Model: `onnx-community/depth-anything-v2-small` (fp16, ~50MB)
- Runs on separate WebGPU adapter/device (Transformers.js creates its own)
- Result transfers as `ImageBitmap` (GPU→CPU→GPU, one-time per estimation)
- Browser-cached via Cache API after first download
- WASM fallback if WebGPU unavailable (~2-5s per frame vs ~100-500ms)
