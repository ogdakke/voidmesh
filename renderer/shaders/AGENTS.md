# Renderer Shaders

WebGPU effect passes and WGSL for dithering, halftone, ASCII, glass, blobs, melt, and glitch.

## Structure

- Each effect is a `ShaderPass` subclass with a matching WGSL module.
- Shared shader behavior belongs in `shader-pass.ts` or renderer processing utilities, not copied across effects.
- Runtime lookup and lifecycle flow through the shader registry.

## Invariants

- Reuse pipelines, bind-group layouts, uniform buffers, samplers, and stable bind groups.
- Write uniforms into reusable typed arrays with correct WGSL alignment.
- Branch on uniforms inside WGSL rather than creating pipeline variants for ordinary parameter choices.
- Keep texture sampling in uniform control flow. Do not call `textureSample` from per-pixel divergent branches; use unconditional samples, `textureLoad`, or split passes.
- Preserve source alpha and the configured GPU color format.
- LOD changes may alter output size but not authored-space meaning. Scale spatial parameters from render size where required.
- Destroy pass-owned GPU resources during cleanup.

## Boundaries

- Shader passes encode effect work; canvas ordering, visibility, ownership, and export orchestration remain in the parent renderer.
- Do not duplicate processing or post-processing pipelines inside individual effects.
