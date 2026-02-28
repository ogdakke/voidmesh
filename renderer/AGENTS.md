# Renderer

WebGPU rendering and export pipelines. Turns engine state into pixels.

## Key Files

- `canvas-renderer.ts` (~55KB) — `InfiniteCanvasRenderer`. WebGPU adapter/device/context init, entity source textures, shader dispatch via `ShaderRegistry`, composition pipeline (viewport transform + entity layering), grid, selection rects, disintegration overlays. Entry point: `render(state: RenderState)`. Also exposes `startDisintegration()` / `cancelDisintegration()` for the fancy delete feature.
- `processing-pipeline.ts` (~47KB) — `ProcessingPipeline`. Pre-processing (adjustments: brightness/contrast/saturation, Dual Kawase blur) and post-processing (grain, vignette, bloom via multi-pass downsample/upsample, chromatic aberration). Operates per-entity before composition.
- `texture-pool.ts` — GPU texture recycling to avoid allocation churn during shader ping-pong.
- `export-service.ts` — `ExportService`. Reads GPU textures back to CPU for image export (PNG/JPEG). Uses staging buffers with 256-byte row alignment.
- `video-exporter.ts` (~19KB) — WebCodecs H.264 encoding + mediabunny muxing via Web Worker.
- `video-export.worker.ts` (~10KB) — Worker receiving encoded `VideoFrame` chunks, muxes into MP4/MOV.
- `gif-export.ts` — GIF export via gifenc on main thread. Palette sampling, Floyd-Steinberg dithering, frame encoding.
- `export-formats.ts` — Format/quality/resolution type definitions.

- `disintegration-particles.ts` — `DisintegrationParticleSystem`. GPU compute particle system for entity delete animations. Compute shaders spawn + update particles; instanced rendering draws them. Manages per-overlay GPU buffers (particle storage, uniforms, bind groups).

### WGSL Shaders (in this directory)

23 `.wgsl` files. Effect shaders: `dithering.wgsl`, `dithering-compute.wgsl`, `ascii.wgsl`, `halftone.wgsl`, `melt.wgsl`, `blobs.wgsl`, `glass-fluted.wgsl`, `glass-frosted.wgsl`, `glass-flowing.wgsl`. Post-processing: `bloom-downsample.wgsl`, `bloom-upsample.wgsl`, `kawase-downsample.wgsl`, `kawase-upsample.wgsl`, `adjustments.wgsl`, `post-process.wgsl`. Composition: `composition.wgsl`, `dot-grid.wgsl`, `selection-rect.wgsl`, `texture-mix.wgsl`. Disintegration: `disintegration-spawn.wgsl`, `disintegration-update.wgsl`, `disintegration-render.wgsl`. Imported via `?raw` Vite suffix (minified in production by `vite-plugin-wgsl-minify`).

## Rendering Pipeline (per frame)

1. `GameLoop` calls `renderer.render(state)` each frame
2. For each visible entity: upload source texture if dirty, apply shader via `ShaderRegistry.applyShader()`, apply pre/post processing via `ProcessingPipeline`
3. Composite all processed entities onto canvas with viewport transform
4. Render grid overlay, selection rectangles, drag visuals
5. Render disintegration particle overlays for any active "fancy delete" animations

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
