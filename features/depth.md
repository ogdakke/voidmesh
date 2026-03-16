# Depth Estimation Feature

Per-entity depth maps via Transformers.js (Depth Anything V2 Small), used as auxiliary textures in the shader pipeline for depth-aware effects.

## What's implemented

### Core pipeline

- **DepthService** (`renderer/depth/depth-service.ts`) — Lazy-loaded Transformers.js pipeline, `device: 'webgpu'`, `dtype: 'fp16'`. ~50MB model, browser-cached via Cache API. Converts `ImageBitmap → OffscreenCanvas → RawImage.fromCanvas()` for pipeline input.
- **GPU texture storage** — `#entityDepthTextures: Map<string, GPUTexture>` in `canvas-renderer.ts`. `rgba8unorm` format. 1x1 mid-gray fallback texture when no depth exists.
- **Shader integration** — `supportsDepth()` opt-in on `ShaderPass` subclasses. Depth texture bound at group 0, bindings 3-4. `hasDepth` uniform at u[19] packs: bit 0 = enabled, bit 1 = invert, bits 16-31 = influence (uint16 → 0.0-1.0).
- **Depth-aware shaders** — Halftone, blobs, melt, glass (frosted/fluted/flowing). Depth modulates dot size, blob radius, drip distance, refraction strength. Pattern: `mix(0.4, 1.6, depth)` scaled by influence.

### UI

- **Desktop sidebar** — `components/depth-knobs.tsx` in "Depth" collapsible section. Generate/Clear buttons, influence slider, invert toggle, visualize toggle.
- **Desktop context menu** — `DepthMenuItems` submenu in `canvas-context-menu.tsx`. Generate, Clear, Invert checkbox, Visualize checkbox.

### Depth visualization

- `depth.showDepth` flag in `DepthParams`. When true, renders depth texture directly via `CopyPass`, bypassing shader processing (same pattern as `showOriginal`).

### Types & config

- `DepthParams { influence, invert, showDepth? }` in `types/canvas.ts`
- Defaults: `{ influence: 1.0, invert: false }` in `lib/config/index.ts`
- `"depth"` in all 7 shader feature param lists
- `depthInfluence` slider range config (0-1, step 0.01)

### Static image export

- Works implicitly: `ExportService.#applyShader` calls `#applyShaderToTexture` which looks up entity depth from the map. Static exports respect depth-modulated effects.

---

## Missing features

### P0 — Core gaps

#### Serialization (.vdmsh)

Depth maps are not saved or loaded. When a project is reopened, all depth maps must be re-generated.

**Implementation:**

- On save: read depth texture back to CPU, encode as grayscale PNG, store as `depth/{entityId}.png` in the zip
- On load: decode PNG, upload to GPU, populate `#entityDepthTextures`
- Depth is optional — old files without depth load fine

**Files:** `lib/serialization/serialize.ts`, `lib/serialization/deserialize.ts`, `renderer/canvas-renderer.ts` (add `getDepthTextureBitmap(entityId)` for readback)

#### Undo/redo

`estimateDepth()` and `clearDepthMap()` are not wrapped in `Command.create()`. Users cannot undo depth generation or clearing.

**Implementation:**

```typescript
// In canvas-context.tsx estimateDepth:
const cmd = Command.create({
  execute: () => {
    /* generate + store texture */
  },
  undo: () => {
    /* clear texture */
  },
  onEvict: () => {
    /* destroy GPU texture if undo stack evicts */
  },
});
undo.push(cmd);
```

**Files:** `context/canvas-context.tsx`

#### Entity duplication

Duplicated entities lose their depth map. Need to clone the GPU texture or re-run estimation.

**Implementation:** In `duplicateEntities()`, copy depth texture data for each duplicated entity. Use `commandEncoder.copyTextureToTexture()` to clone GPU-side.

**Files:** `context/canvas-context.tsx` (`duplicateEntities`)

#### Export — showDepth in export pipeline

`ExportService.#renderSourceToImageBitmap` doesn't check `showDepth`. Static image exports with depth visualization enabled won't render the depth map.

**Implementation:** Add `showDepth` check before `#applyShader` in `ExportService`, similar to the `showOriginal` passthrough.

**Files:** `renderer/export-service.ts`

---

### P1 — Additional shader support

#### Dithering shader depth

`DitheringShader` has two pipelines (fragment for ordered, compute for error diffusion). Neither supports depth. The compute shader path complicates this — depth would need to be an additional binding in both pipelines.

**Consideration:** Dithering is pixel-level — depth modulating the dithering threshold or color count per-pixel would be the natural effect.

**Files:** `renderer/shaders/dithering-shader.ts`, `renderer/dithering-ordered.wgsl`, `renderer/dithering-compute.wgsl`

#### ASCII shader depth

`AsciiShader` uses bindings 3-4 for its MSDF font atlas, which conflicts with depth bindings. Depth support requires shifting atlas to bindings 5-6.

**Files:** `renderer/shaders/ascii-shader.ts`, `renderer/ascii.wgsl`

#### Glitch shader depth

`GlitchShader` doesn't override `supportsDepth()`. Depth could modulate glitch displacement or block corruption intensity.

**Files:** `renderer/shaders/glitch-shader.ts`, `renderer/glitch-*.wgsl`

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

### P3 — Depth-of-field post-processing

A post-processing pass that applies variable blur based on depth distance from a focal plane.

**Params:**

```typescript
interface DepthOfFieldParams {
  enabled: boolean;
  focalDepth: number; // 0-1, depth value in focus
  focalRange: number; // 0-1, width of in-focus band
  blurStrength: number; // 0-1, max blur amount
}
```

**Implementation:** New `renderer/depth-of-field.wgsl` pass in `ProcessingPipeline`, after main shader but before grain/bloom. Uses existing Kawase blur infrastructure with depth-dependent mix weight.

**Files:** `renderer/depth-of-field.wgsl` (new), `renderer/processing-pipeline.ts`, `types/canvas.ts`, `lib/config/index.ts`

---

### P4 — UI & UX

#### Mobile depth controls

No depth UI exists on mobile. Options:

1. Add depth button to the action layer radial menu
2. Create a depth drawer (like `upscale-drawer.tsx`)
3. Add depth controls to mobile controls panel

**Files:** `components/action-layer/`, `components/mobile-controls.tsx`

#### Keyboard shortcuts

No keybinds for depth operations. Suggested:

- Generate depth: e.g. `Shift+D`
- Clear depth: e.g. `Shift+Alt+D`
- Toggle visualization: e.g. `Alt+D`

**Files:** `context/keybind-context.ts`, `context/keybind-provider.tsx`

#### URL state sync

Depth params (`depth.influence`, `depth.invert`) not synced to URL. Shared links don't preserve depth settings. Note: depth textures themselves can't be in URLs — only the params.

**Files:** `context/canvas-context.tsx` (`shaderUrlParams`)

#### Model download progress

First-time depth estimation triggers a ~50MB model download. No progress indication currently — the button just says "Estimating...". Should show a toast with download progress.

**Files:** `renderer/depth/depth-service.ts` (add `progress_callback`), `context/canvas-context.tsx`

---

## Architecture notes

### Bind group layout (current)

| Binding | Halftone/Blobs/Melt/Glass | ASCII         | Dithering (compute) |
| ------- | ------------------------- | ------------- | ------------------- |
| 0       | uniform                   | uniform       | uniform             |
| 1       | source tex                | source tex    | source tex          |
| 2       | sampler                   | sampler       | output tex          |
| 3       | **depth tex**             | atlas tex     | —                   |
| 4       | **depth sampler**         | atlas sampler | —                   |

### ASCII + Depth (future)

| Binding | Purpose       |
| ------- | ------------- |
| 0       | uniform       |
| 1       | source tex    |
| 2       | sampler       |
| 3       | depth tex     |
| 4       | depth sampler |
| 5       | atlas tex     |
| 6       | atlas sampler |

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
