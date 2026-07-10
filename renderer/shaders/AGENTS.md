# Shaders

Per-effect shader passes. Each shader type gets a class extending `ShaderPass`.

## Key Files

- `shader-pass.ts` — Abstract base class. Defines `ShaderContext` (device, uniform buffer, sampler, palette cache, texture pool, `intermediateFormat`, `supportsP3`). Provides `writeUniforms()` (common 336-byte layout including `is_p3` flag at u[18]), `createPipeline()`, `execute()` (render pass submission). Subclasses implement `getShaderSource()` and `writeVariantUniforms()`.
- `shader-registry.ts` — `ShaderRegistry`. Maps `ShaderType` -> `ShaderPass` instances. `applyShader()` dispatches. `applyShaderChain()` runs multiple passes with ping-pong textures.
- `dithering-shader.ts` — Most complex. Fragment pipeline (ordered) and compute pipeline (error diffusion). Error buffers cached per entity.
- `ascii-shader.ts` — Uses MSDF font atlas. Async atlas init.
- `glass-shader.ts` — Three variants selected via `GlassKind`.
- `glitch-shader.ts` — Simple pass. Maps `GlitchKind` to uniform index.
- `blobs-shader.ts`, `halftone-shader.ts`, `melt-shader.ts` — Simple passes.

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
- `ShaderPass.removeEntity()` owns base uniform-buffer cleanup. Overrides must release their specialized state and call `super.removeEntity()`.
- Scratch textures may return to `TexturePool` after their final encoded read/copy; command-buffer ordering permits reuse by later passes. They remain protected from destruction until the post-submit `commitSubmitted()` boundary.
- Render pipeline targets use `ctx.intermediateFormat` (not hardcoded `rgba8unorm`).
- Luminance: use `select()` between BT.709 and P3 coefficients based on `uniforms.is_p3`.

## WGSL: Uniform Control Flow (CRITICAL)

`textureSample()` MUST only be called from **uniform control flow** — meaning every thread in a 2x2 pixel quad must reach the same `textureSample` call site. GPUs compute screen-space derivatives across quads for mipmap selection; if threads diverge, derivatives are undefined.

**What violates uniform control flow:**

- `if (hash(pixelCoord) > threshold) { textureSample(...) }` — hash varies per pixel
- `if (luminance(textureSample(...)) < x) { return; }` then `textureSample(...)` later — early return based on sampled data means later samples are in non-uniform flow
- Any `textureSample` inside a branch conditioned on per-pixel data (texture values, pixel position hashes, fragment coordinates)

**What IS uniform control flow:**

- Branching on uniform values (`uniforms.kind`, `uniforms.intensity`) — all threads see the same value
- `textureSample` with data-dependent UV coordinates (the coordinates can vary, just the call site must be uniform)

**Design rules for WGSL fragment shaders:**

1. **Sample first, branch later.** Do all `textureSample` calls unconditionally at the top, then use the results in conditional logic.
2. **Use `textureLoad()` in non-uniform branches.** `textureLoad` (integer coords, explicit mip level) has no derivative requirement and is safe anywhere. Use the `loadAtUV` helper pattern: `let coord = vec2i(clamp(uv * dims, vec2f(0.0), dims - 1.0)); textureLoad(tex, coord, 0)`.
3. **Replace `if/else` with branchless math.** Use `select()`, `mix()`, `step()`, `smoothstep()` to avoid branches entirely. Example: `let displacement = step(threshold, h) * amount;` instead of `if (h > threshold) { displacement = amount; }`.
4. **Never early-return based on texture data.** Instead, compute both paths and blend: `let result = mix(original, modified, blend);`.

## Anti-Patterns

- Do not put WGSL files here. They live in parent `renderer/` directory. Only TypeScript manager classes go in this folder.
- Do not create per-frame GPU resources. Cache bind groups and uniform buffers. Use `TexturePool` for intermediates.
- Do not retain shader resources after entity removal or shader migration. Route cleanup through `ShaderRegistry.removeEntity()`.
- Do not call `textureSample` inside per-pixel branches. See "Uniform Control Flow" section above.
