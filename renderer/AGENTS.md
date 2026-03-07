# Renderer

WebGPU rendering and export pipelines. Turns engine state into pixels.

## Key Files

- `canvas-renderer.ts` (~69KB) — `InfiniteCanvasRenderer`. WebGPU adapter/device/context init, entity source textures, shader dispatch via `ShaderRegistry`, composition pipeline (viewport transform + entity layering), grid, selection rects, disintegration overlays, action layer blur overlay. Entry point: `render(state: RenderState)`.
- `processing-pipeline.ts` (~49KB) — `ProcessingPipeline`. Pre-processing (adjustments: brightness/contrast/saturation, Dual Kawase blur) and post-processing (grain, vignette, bloom via multi-pass downsample/upsample, chromatic aberration). Operates per-entity before composition. Also exposes `encodeFullScreenBlur()` for the action layer blur overlay.
- `gpu-color-space.ts` — `detectGpuColorConfig()`. Probes Display P3 support at init, returns frozen `GpuColorConfig` (supportsP3, canvasFormat, canvasColorSpace, intermediateFormat, textureColorSpace).
- `copy-pass.ts` + `copy-pass.wgsl` — `CopyPass`. Full-screen format conversion (rgba16float ↔ rgba8unorm) for export readback and showOriginal passthrough.
- `texture-pool.ts` — GPU texture recycling. Parameterized by `GPUTextureFormat` (receives `intermediateFormat` from renderer).
- `export-service.ts` — `ExportService`. Reads GPU textures back to CPU for image export (PNG/JPEG). Uses `CopyPass` for rgba16float→rgba8unorm conversion, color-space-aware texture operations.
- `video-exporter.ts` (~19KB) — WebCodecs H.264 encoding + mediabunny muxing via Web Worker.
- `video-export.worker.ts` (~10KB) — Worker receiving encoded `VideoFrame` chunks, muxes into MP4/MOV.
- `gif-export.ts` — GIF export via gifenc on main thread. Palette sampling, Floyd-Steinberg dithering, frame encoding.
- `export-formats.ts` — Format/quality/resolution type definitions.

- `disintegration-particles.ts` — `DisintegrationParticleSystem`. GPU compute particle system for entity delete animations. Compute shaders spawn + update particles; instanced rendering draws them. Manages per-overlay GPU buffers (particle storage, uniforms, bind groups).

### WGSL Shaders (in this directory)

26 `.wgsl` files covering effects, post-processing, composition, disintegration, and action layer overlay (`action-layer-blit.wgsl`). Imported via `?raw` Vite suffix (minified in production by `vite-plugin-wgsl-minify`).

## Color Space

At init, `detectGpuColorConfig()` probes Display P3 support. The result configures the entire pipeline:

- **P3-capable**: canvas = `rgba16float` + `display-p3`, intermediates = `rgba16float`
- **sRGB fallback**: canvas = preferred format + `srgb`, intermediates = `rgba16float`
- Luminance calculations use `is_p3` uniform flag to select correct coefficients (P3 `0.2290/0.6917/0.0793` vs BT.709 `0.2126/0.7152/0.0722`)

## Rendering Pipeline (per frame)

1. `GameLoop` calls `renderer.render(state)` each frame
2. For each visible entity: upload source texture if dirty, apply shader via `ShaderRegistry.applyShader()`, apply pre/post processing via `ProcessingPipeline`
3. Composite all processed entities onto canvas with viewport transform
4. If action layer active: blur+dim canvas, re-render targeted entities sharp on top
5. Render grid overlay, selection rectangles, drag visuals
6. Render disintegration particle overlays for any active "fancy delete" animations

## GPU Resource Management

- Entity textures cached in `#entityTextures` Map (keyed by entity ID)
- Source texture cache (`#entitySourceTextures`) avoids re-uploading unchanged bitmaps
- Composition cache (`#entityCompositionCache`) reuses uniform buffers and bind groups
- `TexturePool` for transient intermediate textures
- All caches invalidated when entity source changes; cleaned up on entity removal

## Shader Uniform Layout

All shaders share a 336-byte uniform buffer. First 64 bytes are common (size, intensity, scale, shape, palette flag). Offset 7 (byte 28) is the shader-variant field. Palette data at offset 64 (float index 16+). See `shaders/shader-pass.ts` for exact layout.

## Anti-Patterns

- Do not create GPU resources outside of renderer/pipeline classes. Use `TexturePool` for transients.
- Do not call `device.queue.submit()` outside of shader pass `execute()` methods except in the compositor.
- WGSL files must use `?raw` import suffix for Vite. Minified in production builds via `miniray` (WGSL minifier).
- Export: GPU device cannot be transferred to workers. Main thread renders frames; worker encodes/muxes.

## Dependencies

Reads `RenderState` from engine. Imports types from `#types/canvas.ts`. Uses config from `#config`.
