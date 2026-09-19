# Renderer

WebGPU rendering, shader execution, composition, resource caching, and export.

## Authoritative Areas

- `canvas-renderer.ts` — Frame orchestration and renderer-owned resources.
- `entity-draw-item-preparer.ts` — Visibility, LOD, texture resolution, and composition admission.
- `composition-pass.ts` — Z-ordered entity composition and instanced draws.
- `processing-pipeline.ts` — Adjustments, shader processing, and post-processing.
- `texture-pool.ts`, `byte-budget-cache.ts` — Bounded temporary and persistent GPU ownership.
- `export-service.ts`, `frame-encoder.ts`, `gif-export.ts` — Native-resolution export paths.
- `shaders/` — Effect passes; see its child `AGENTS.md`.

## Rendering Invariants

- Assemble shared WGSL with `// @include "..."` through `plugins/vite-plugin-wgsl-minify.ts` in development, tests, and builds. Minify complete modules; never concatenate independently minified shader fragments.

- Preserve exact entity z-order. Batch only when draw ordering and texture identity remain correct.
- Static-image composition plans may persist across viewport-only frames. Membership, ordering, incompatible media, dirty textures, or lost resources must invalidate or patch the plan correctly.
- Pan and zoom should update uniforms rather than rebuild scene data when entity/effect identity is unchanged.
- Selection/debug flags may live in persistent instance data; transient drag state should use uniforms or bounded patches.
- Continuous shaders, playing/external media, action-layer effects, callouts, and other dynamic overlays use the normal dynamic path.
- Original video playback stays zero-copy on external textures. Re-import HTML video sources and create a fresh external composition binding for every rendered frame; never retain or reuse `GPUExternalTexture` identities across imports, and do not copy video frames into renderer-owned RGBA textures.
- Preview LOD is screen-space and quantized. Export always uses native media dimensions and must not read a preview-LOD texture.
- Source and processed textures are keyed by immutable asset/effect identity. Entity IDs track retain/release ownership.
- Renderer caches and pooled textures are byte-bounded. Eviction and shutdown destroy resources and invalidate dependent bindings.
- Reuse buffers, typed arrays, bind groups, views, and scratch records in frame loops.

## Color and Layering

- GPU color configuration is detected once and passed explicitly to dependent systems.
- Preserve source alpha across shader output.
- Active action-layer material never enters scene blur. Reconstruct lower crossing slices after blur using sharp active material, blurred backdrop color, and original cover alpha; preserve animated depth and draw each active slice once.
- Composition owns crossing layer targets and texture-identity opacity proofs. Prime proofs only from immutable image uploads, keep current-frame resources alive through submission, and destroy them on eviction or shutdown.
- Keep base entities, selection/labels, action-layer content, disintegration, lensing, and progressive blur in their intended layer order.

## Boundaries

- Renderer consumes engine render state but does not mutate canvas state.
- Do not add React imports.
- Avoid hidden fallback paths. Unsupported GPU behavior must be explicit and justified.
