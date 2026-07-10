# Renderer

WebGPU rendering and export pipelines. Turns engine state into pixels.

## Key Files

- `canvas-renderer.ts` (~69KB) — Main renderer. WebGPU setup, entity textures, shader dispatch, composition, overlays.
- `processing-pipeline.ts` (~49KB) — Per-entity pre/post-processing: adjustments, blur, bloom, grain, chromatic aberration. Also provides action layer blur.
- `entity-render-size.ts` — Selects quantized screen-space render tiers from projected physical pixels; exports bypass this path and retain native dimensions.
- `gpu-color-space.ts` — `detectGpuColorConfig()`. Probes Display P3 support at init, returns frozen `GpuColorConfig` (supportsP3, canvasFormat, canvasColorSpace, intermediateFormat, textureColorSpace).
- `copy-pass.ts` + `copy-pass.wgsl` — `CopyPass`. Full-screen format conversion (rgba16float ↔ rgba8unorm) for export readback and showOriginal passthrough.
- `texture-pool.ts` — GPU texture recycling with exact idle-byte accounting and a global 64 MiB LRU budget. Parameterized by `GPUTextureFormat` (receives `intermediateFormat` from renderer).
- `byte-budget-cache.ts` — Frame-pinned byte-budget tracker for persistent renderer caches. Eviction callbacks own resource destruction and cache invalidation.
- `export-service.ts` — `ExportService`. Renders native media sources for entity export, reads GPU textures back to CPU for PNG/JPEG, and uses `CopyPass` for rgba16float→rgba8unorm conversion.
- `video-exporter.ts` (~19KB) — WebCodecs H.264 encoding + mediabunny muxing via Web Worker.
- `video-export.worker.ts` (~10KB) — Worker receiving encoded `VideoFrame` chunks, muxes into MP4/MOV.
- `gif-export.ts` — GIF export orchestration. Palette sampling, Floyd-Steinberg dithering, frame encoding (actual work in `lib/gif-encoder-worker.ts`).
- `frame-encoder.ts` — Shared core for encoding ImageBitmap sequences into video blobs via Web Worker. Used by both video export and upscale pipelines. Handles WebCodecs init, mediabunny muxing, progress async generator, cancel, audio passthrough.
- `progress-channel.ts` — Push-to-pull async generator bridge for progress reporting. Used by frame-encoder and video-exporter.
- `export-formats.ts` — Format/quality/resolution type definitions.

### Upscale (`upscale/`)

WebGPU compute-based 2x image upscaling using Anime4K CNN models (ported from WebSR). No ML runtime — pure WGSL compute shaders.

- `upscale-service.ts` (~12KB) — `UpscaleService`. Orchestrates upscaling: loads weights, builds GPU network, processes images/GIFs/videos. Caches networks by model+dimensions. Uses `FrameEncoder` for video re-encoding.
- `upscale-network.ts` (~13KB) — `UpscaleNetwork`. Builds compute pipeline graph from weight layers. Creates GPU buffers, bind groups, compute passes. Single `commandEncoder.finish()` submission per frame.
- `upscale-compute-layer.ts` — Individual compute dispatch layer (conv3x4, conv8x4, etc.).
- `upscale-display-layer.ts` — Final render pass: sub-pixel shuffle + bicubic residual to produce 2x output.
- `upscale-wgsl.ts` (~10KB) — WGSL shader templates for each layer type. Generated at build time per-layer config.
- `upscale-types.ts` — Types: `ModelSize` (s/m/l), `ContentVariant` (rl/an/3d), layer configs.
- `upscale-weights.ts` — Lazy weight loader from `weights/*.json` via `#weights/*` alias.

- `disintegration-particles.ts` — `DisintegrationParticleSystem`. GPU compute particle system for entity delete animations. Compute shaders spawn + update particles; instanced rendering draws them. Manages per-overlay GPU buffers (particle storage, uniforms, bind groups).

### WGSL Shaders (in this directory)

~25 `.wgsl` files for effects, post-processing, composition, and overlays. Imported via `?raw`; minified in production.

## Color Space

At init, `detectGpuColorConfig()` probes Display P3 support. The result configures the entire pipeline:

- **P3-capable**: canvas = `rgba16float` + `display-p3`, intermediates = `rgba16float`
- **sRGB fallback**: canvas = preferred format + `srgb`, intermediates = `rgba16float`
- Luminance calculations use `is_p3` uniform flag to select correct coefficients (P3 `0.2290/0.6917/0.0793` vs BT.709 `0.2126/0.7152/0.0722`)

## Rendering Pipeline (per frame)

1. `GameLoop` calls `renderer.render(state)` each frame
2. For each visible entity: resolve its shared source texture (uploading absent or changed sources), apply shader via `ShaderRegistry.applyShader()`, apply pre/post processing via `ProcessingPipeline`
3. Composite all processed entities onto canvas with viewport transform
4. If action layer active: blur+dim canvas, re-render targeted entities sharp on top
5. Render grid overlay, selection rectangles, drag visuals
6. Render disintegration particle overlays for any active "fancy delete" animations

## GPU Resource Management

- Persistent source + processed entity textures have exact byte accounting and share a configurable LRU budget. Current-frame textures are pinned; offscreen entries are eviction candidates.
- `InfiniteCanvasRenderer.getResourceStats()` exposes residency plus cumulative allocation, upload, and eviction counters for performance benchmarks.
- Dimension-keyed blur mip, bloom mip, and blur blend textures share a 128 MiB budget; current-frame dimensions stay pinned and older dimensions are evicted LRU.
- Source textures cached by media identity/revision; static image entities sharing one asset also share one GPU texture until the final entity owner is removed
- Stable processed image outputs are keyed by asset revision, dimensions, shader type, and full shader parameters. Identical instances share one texture; animated effects and non-image media remain entity-scoped.
- Canvas media uses 64/128/256/... screen-space LOD tiers with overscan. Promotions wait for camera settle and real texture work remains transition-budgeted. Shared static-image demotions may run during camera motion; after one shared tier exists, every identical instance rebinds immediately without consuming per-entity transition slots.
- Recently released source and processed image tiers remain reusable inside the existing byte-budgeted LRU; reverse zooms should not synchronously rebuild a tier that is still resident.
- Same-size processed image shader-param changes recycle the entity's unique output texture instead of allocating a replacement; shared outputs allocate a new texture to avoid clobbering siblings.
- Original videos stay on direct external-texture composition so playback and media controls remain continuous. Processed videos use screen-space output LOD, and small outputs shorten the bloom mip chain rather than pausing media.
- Entity image export renders from native media sources at `originalSize`; it must not read back the current preview LOD texture.
- Composition cache (`#entityCompositionCache`) reuses uniform buffers, bind groups, and stable draw-item wrappers; entity uniform buffers upload only when entity-local visual state changes, while pan/zoom updates the shared viewport buffer.
- Entity draw preparation reuses result arrays, composition-option scratch, and bounds scratch. Do not restore per-entity object construction to the pan/zoom path.
- `TexturePool` retains at most 64 MiB of idle transient textures across dimensions/usages. Release scratch after its final encoded use for ordered reuse, but apply destruction limits only in `commitSubmitted()` after `queue.submit()`.
- Image source changes require a new asset revision. Entity removal releases its source-cache ownership without destroying textures still used by sibling instances.

## Shader Uniform Layout

All shaders share a 336-byte uniform buffer. First 64 bytes are common (size, intensity, scale, shape, palette flag). Offset 7 (byte 28) is the shader-variant field. Palette data at offset 64 (float index 16+). See `shaders/shader-pass.ts` for exact layout.

## Anti-Patterns

- Do not create GPU resources outside of renderer/pipeline classes. Use `TexturePool` for transients.
- Persistent renderer caches must report byte cost and participate in a budget; do not add unbounded per-entity or per-dimension GPU maps.
- Do not call `device.queue.submit()` outside of shader pass `execute()` methods except in the compositor.
- WGSL files must use `?raw` import suffix for Vite. Minified in production builds via `miniray` (WGSL minifier).
- Export: GPU device cannot be transferred to workers. Main thread renders frames; worker encodes/muxes.
- Do not create new upscale model layer types without updating both `upscale-wgsl.ts` templates and `ComputeLayerConfig.type` union.

## Dependencies

Reads `RenderState` from engine. Imports types from `#types/canvas.ts`. Uses config from `#config`.
