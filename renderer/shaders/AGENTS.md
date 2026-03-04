# Shaders

Per-effect shader passes. Each shader type gets a class extending `ShaderPass`.

## Key Files

- `shader-pass.ts` — Abstract base class. Defines `ShaderContext` (device, uniform buffer, sampler, palette cache, texture pool, `intermediateFormat`, `supportsP3`). Provides `writeUniforms()` (common 336-byte layout including `is_p3` flag at u[18]), `createPipeline()`, `execute()` (render pass submission). Subclasses implement `getShaderSource()` and `writeVariantUniforms()`.
- `shader-registry.ts` — `ShaderRegistry`. Maps `ShaderType` -> `ShaderPass` instances. `applyShader()` dispatches. `applyShaderChain()` runs multiple passes with ping-pong textures.
- `dithering-shader.ts` — Most complex. Has BOTH a fragment pipeline (ordered dithering: Bayer, noise) and a compute pipeline (error diffusion: Floyd-Steinberg, Atkinson, etc.). Error buffers cached per entity dimensions.
- `ascii-shader.ts` — Uses MSDF font atlas (extra texture binding). Async init for atlas loading.
- `glass-shader.ts` — Three variants (fluted, frosted Voronoi, flowing). Uses `GlassKind` to select WGSL source.
- `blobs-shader.ts`, `halftone-shader.ts`, `melt-shader.ts` — Simple passes. Override `getShaderSource()` and `writeVariantUniforms()` only.

## Adding a New Shader

1. Create `.wgsl` file in parent `renderer/` directory (NOT here in `shaders/`)
2. Create `<name>-shader.ts` here extending `ShaderPass`
3. Implement `getShaderSource()` (return imported WGSL) and `writeVariantUniforms()` (write at uniform offset 7)
4. Register in `canvas-renderer.ts` `#initShaders()` method
5. Add `ShaderType` variant to `types/canvas.ts` and `ShaderFeature` entry to `lib/config/index.ts`

## Patterns

- Simple shaders: ~20 lines. Extend `ShaderPass`, import WGSL, write variant uniform at `uintView[7]` / `floatView[7]`.
- Complex shaders (dithering, ascii) override `initialize()`, `createBindGroupLayout()`, `createBindGroup()`, and/or `execute()`.
- All shaders share the same 336-byte uniform layout. Common uniforms (size, intensity, scale, shape, colors, palette, `is_p3`) written by base class `writeUniforms()`.
- Render pipeline targets use `ctx.intermediateFormat` (not hardcoded `rgba8unorm`).
- Luminance: use `select()` between BT.709 and P3 coefficients based on `uniforms.is_p3`.

## Anti-Patterns

- Do not put WGSL files here. They live in parent `renderer/` directory. Only TypeScript manager classes go in this folder.
- Do not create per-frame GPU resources. Cache bind groups and uniform buffers. Use `TexturePool` for intermediates.
