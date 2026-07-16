# Renderer

WebGPU rendering and export pipelines. Turns engine state into pixels.

## Key Files

- `canvas-renderer.ts` (~69KB) — Main renderer. WebGPU setup, entity textures, shader dispatch, composition, overlays.
- `composition-pass.ts` + `composition-instanced.wgsl` — Final canvas composition. Adjacent regular-texture entities sharing the same texture use instanced draws; sufficiently visible static-image scenes persist homogeneous or bounded mixed-texture instance plans.
- `entity-draw-item-preparer.ts` — Visibility/LOD preparation plus conservative admission of versioned static-image composition plans.
- `processing-pipeline.ts` (~49KB) — Per-entity pre/post-processing: adjustments, blur, bloom, grain, chromatic aberration. Also provides action layer blur.
- `entity-render-size.ts` — Selects quantized screen-space render tiers from projected physical pixels and derives the render-to-authored pixel scale; exports bypass preview LOD and retain scale 1.
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
- `InfiniteCanvasRenderer.getResourceStats()` exposes residency plus cumulative texture allocation/upload/eviction and composition batch rebuild/upload counters for performance benchmarks.
- Dimension-keyed blur mip, bloom mip, and blur blend textures share a 128 MiB budget; current-frame dimensions stay pinned and older dimensions are evicted LRU.
- Source textures cached by media identity/revision; static image entities sharing one asset also share one GPU texture until the final entity owner is removed
- Stable processed image outputs are keyed by asset revision, dimensions, shader type, and full shader parameters. Identical instances share one texture; animated effects and non-image media remain entity-scoped.
- Build static processed-texture signatures only when resolving dirty/new/LOD work. Do not retain one serialized signature per shader-params object: imported workspaces may have hundreds of thousands of distinct wrappers around only a few structural values.
- Per-entity source/processed ownership maps point directly to their cached texture entries; retain the cache key on the shared entry for release/eviction instead of restoring a second map lookup to every visible-entity frame path.
- Canvas media uses 64/128/256/... screen-space LOD tiers with overscan. Zoom changes leave an explicit settle-frame countdown reported as pending render work, so promotions converge after zoom animations without another interaction; pan-only motion must not restart it because offset does not affect projected texture size. Real texture work remains transition-budgeted; shared static-image demotions may run during camera motion, and an existing shared tier rebinds every identical instance immediately.
- Pixel-space shader parameters are authored against native media resolution and multiplied by `EffectRenderEntity.pixelScale` only when an LOD texture is rendered. This covers common cell size, dithering pattern period, blur strength, grain size, and chromatic offset; dimensionless controls and UV-space bloom radius stay unchanged. Populate the reusable effect view after cached-texture early returns so this normalization adds no steady-state entity work or parameter clones.
- LOD tier changes switch directly to the new resident texture. Do not retain or sample the previous tier for cosmetic crossfades: dual-tier residency and replacement/intermediate allocations can exceed mobile WebGPU memory limits. External video textures remain on their dedicated path.
- Viewport preparation queries `RenderState.entitySpatialIndex`; when its bounds cover the whole scene, reuse the already z-ordered render array instead. Adjacent equal projected sizes reuse one LOD-size calculation, and unchanged static images at the desired resident tier bypass full LOD/texture resolution.
- Recently released source and processed image tiers remain reusable inside the existing byte-budgeted LRU; reverse zooms should not synchronously rebuild a tier that is still resident.
- Persistent full-scene texture runs pin their exact cached textures each frame. Validate those texture identities directly; unrelated cache allocations or evictions must not invalidate an otherwise-resident composition plan.
- Same-size processed image shader-param changes recycle the entity's unique output texture instead of allocating a replacement; shared outputs allocate a new texture to avoid clobbering siblings.
- Original videos stay on direct external-texture composition so playback and media controls remain continuous. Processed videos use screen-space output LOD, and small outputs shorten the bloom mip chain rather than pausing media.
- Entity image export renders from native media sources at `originalSize`; it must not read back the current preview LOD texture.
- Regular-texture composition packs entity transforms and visual flags into one reusable storage buffer. Each instance is 24 bytes: full-precision position/size plus one `u32` containing 16-bit periodic rotation, 10-bit drag scale, and selected/debug/locked flags. Scale `1` has a reserved exact encoding; other drag scales stay within the controller's 0.8–1.05 bound. Batch only adjacent entities with the exact same `GPUTexture` so draw order remains unchanged; shader params need not match independently because processing is already baked into that texture.
- A persistent static-image composition plan has no entity-count or texture-run-count floor/ceiling, but requires at least 25% of the scene visible so full-scene instance submission remains bounded relative to normal visible work. Mixed admission compares full-scene and visible texture-run density: equal or higher offscreen entropy retains spatial culling, while low-entropy plans may include additional offscreen runs. Retain rejected resolved plans across viewport-only retries instead of rebuilding their entity textures. Identical effect/source scenes use the representative fast path. Mixed assets/effects retain exact z-ordered texture runs and write the 24-byte instance payload directly from entities; do not materialize or cache one regular composition draw wrapper per scene entity. Continuous shaders and external media stay on normal preparation. Membership/reordering and incompatible selection/debug changes invalidate the retained structure; tracked texture or instance patches advance its versions in place. Texture loss or normal composition writes invalidate only the active batch while preserving its immutable instance payload. Zoom motion reuses the current batch because projection is uniform-driven; after motion stops, refresh one representative per stable texture/size run and restore the retained payload instead of scanning or serializing every entity again.
- Existing image entities may patch a persistent static plan without a fixed dirty-count cutoff. Resolve only dirty IDs, sort their instance indices, rebuild affected texture runs in one linear merge, and coalesce adjacent 24-byte records into contiguous GPU uploads. Assets may differ. Do not rescan structural shader equality or rebuild/upload the full scene merely because an arbitrary entity count was crossed; membership, reordering, incompatible media, or texture eviction falls back to conservative full admission.
- Cache homogeneous/heterogeneous scene classification independently of full-scene admission. Small dirty-ID updates compare only changed entities even when batching is unavailable; do not repeat structural parameter comparison across the scene on each control event.
- Selection and debug flags are stored in the versioned full-scene instance payload, so committed selection/debug viewport frames remain CPU-constant. During drag selection, the immutable gesture-start flags combine with replace/add/subtract uniforms and rotated entity AABBs in the instanced vertex shader; locked entities retain CPU selection semantics. Selection drags of every size, including a singleton, retain one world offset; persistent plans apply it as a uniform, while normal preparation applies it to selected draw records. On release, patch and coalesce only the moved 24-byte instance records and update the retained payload instead of rebuilding the scene. A single selected label is encoded in a dedicated scene-overlay pass after base and action-layer entity composition, consumes the same transient world offset as its entity, and ignores entity z-order without splitting instanced draws; canvas-wide lensing and progressive blur still apply afterward. Multi-selection rectangles remain shader-rendered. Action-layer fade/blur, partial-target drag visuals, callouts, continuous shaders, and heterogeneous media must use normal preparation. The batch may submit offscreen instances after admission; hardware clipping keeps the pan path CPU-constant.
- Full-scene fancy-delete snapshots borrow the representative texture. Defer removal of that texture owner until the next render so bulk deletion can snapshot non-representative entities safely.
- External video textures retain per-entity uniforms and bind groups so direct `GPUExternalTexture` playback never copies into regular textures. Disintegration also retains its non-instanced composition path.
- Grow the composition instance buffer geometrically and append disjoint ranges for each render phase in a frame. Do not restore per-entity GPU uniform buffers, bind groups, or temporary instance objects for regular textures.
- Shader, adjustments, post-process, blur, and bloom uniform resources are pooled by peak same-frame use. Reset pool cursors at frame start; do not retain base processing buffers or bind groups by entity ID.
- `HeadlessExportRenderer` calls `EntityShaderRuntime` directly, so every exported frame must be wrapped in `beginFrame()`/`endFrame()` even when submission or readback fails.
- Entity draw preparation reuses result arrays and composition-option scratch. Normal visible/external composition wrappers are weakly keyed by entity identity; persistent full-scene paths bypass them. Do not restore per-frame object construction or string-keyed lookups to the pan/zoom path.
- When every entity is selected, draw preparation treats visible entities as selected without hashing every ID; selection cardinality is sufficient because store selections contain only existing IDs.
- `TexturePool` retains at most 64 MiB of idle transient textures across dimensions/usages. Release scratch after its final encoded use for ordered reuse, but apply destruction limits only in `commitSubmitted()` after `queue.submit()`.
- Error-diffusion kinds remain UI-disabled. Before re-enabling them, follow `dithering-compute.wgsl`'s bandwidth plan: specialize monochrome/RGB error storage and write directly to storage-capable processed outputs instead of copying a full intermediate texture.
- Image source changes require a new asset revision. Entity removal releases its source-cache ownership without destroying textures still used by sibling instances.
- Composition keeps the former hover uniform slot reserved for layout stability, but no hover state/effect is prepared. Do not add passive alpha hit testing to feed it.

## Shader Uniform Layout

Palette effect shaders use a 304-byte uniform buffer: 32 bytes of common/variant fields, 16 bytes of palette metadata, and 256 bytes of colors. Palette-free glass variants upload 48 bytes. See `shaders/shader-pass.ts` for sizing and layout.

## Anti-Patterns

- Do not create GPU resources outside of renderer/pipeline classes. Use `TexturePool` for transients.
- Persistent renderer caches must report byte cost and participate in a budget; do not add unbounded per-entity or per-dimension GPU maps.
- Do not call `device.queue.submit()` outside of shader pass `execute()` methods except in the compositor.
- WGSL files must use `?raw` import suffix for Vite. Minified in production builds via `miniray` (WGSL minifier).
- Export: GPU device cannot be transferred to workers. Main thread renders frames; worker encodes/muxes.
- Do not create new upscale model layer types without updating both `upscale-wgsl.ts` templates and `ComputeLayerConfig.type` union.

## Dependencies

Reads `RenderState` from engine. Imports types from `#types/canvas.ts`. Uses config from `#config`.
