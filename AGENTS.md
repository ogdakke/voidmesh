# Voidmesh

Infinite canvas app with real-time WebGPU shader effects. Users drop images/videos/GIFs onto a canvas, apply shader effects (dithering, halftone, ascii, glass, blobs, melt, glitch), and export results.

## Domain Glossary

- **Entity** — A media item on the canvas (image, video, GIF, SVG). Has position, size, rotation, z-index in world coordinates. Each entity has one active shader effect and its own params. Type: `ShaderCanvasEntity`.
- **Media Asset** — Shared immutable image payload (bitmap, encoded Blob, alpha grid, revision). Multiple image entities can reference one asset; ownership is reference-counted so duplicates do not decode or retain separate pixels.
- **Shader / Effect** — WebGPU rendering algorithm that stylizes an entity. 7 types: dithering, halftone, ascii, glass, blobs, melt, glitch. Each is a `ShaderPass` subclass in `renderer/shaders/`.
- **Kind** — Sub-variant within a shader type. E.g. dithering has 12 kinds (bayer4x4, floydSteinberg…), glass has 3, glitch has 4, ascii has 4.
- **Knobs** — UI panels for editing shader parameters. Each shader type has its own `*-knobs.tsx`. Read/write params via `useParamValue()` hook.
- **Palette** — 2–16 colors for quantization. Types: preset (built-in), custom (`cstm_` prefix), extracted (`ext_` prefix), original (auto-extracted 6-color per entity).
- **Preserve Colors** — Boolean. True: per-channel RGB processing. False: monochrome. All shaders except glass.
- **Adjustments** — Pre-processing effects applied before shader: brightness, contrast, saturation, blur.
- **Post-processing** — Effects applied after shader: grain, bloom, chromatic aberration.
- **Viewport** — Camera state: offset (world-space position) + zoom. Defines visible portion of the infinite canvas.
- **World Space / Screen Space** — World coordinates = infinite canvas system. Screen coordinates = CSS pixels. Viewport maps world → screen.
- **Action Layer** — Mobile-only overlay triggered by long-press. Shows action buttons; rest of canvas blurred.
- **Disintegration** — Particle break-apart animation on entity deletion. Toggled by "fancy delete" setting.
- **Bulk deletion** — Selection deletion is one store mutation and one undo command. Fancy-delete snapshots are bounded to 32 entities so large selections cannot allocate thousands of GPU overlays.
- **Workspace** — Full saved canvas state (entities, viewport, palettes). Persisted as `.vdmsh` zip files.

## Architecture

- `engine/` — Canvas state (`CanvasStore`) and input handling (`GameLoop`). GPU-agnostic, framework-independent.
- `renderer/` — WebGPU rendering pipeline, shader registry, effect composition, export (MP4/MOV/GIF/PNG/JPEG). `renderer/shaders/` has per-effect `ShaderPass` subclasses.
- `lib/` — Pure utilities. Math, config, media loading, serialization (`.vdmsh`), undo (command pattern), palette extraction, physics scroll. No React, no GPU.
- `types/` — Domain types (`ShaderCanvasEntity`, `ShaderParams`, `Viewport`, all enums). Bottom of dependency graph.
- `context/` — React context providers wiring engine + renderer + URL state. `canvas-context.tsx` is the main orchestrator.
- `hooks/` — React hooks bridging engine state to components. `use-param-value.ts` is the standard param accessor.
- `components/` — React UI. `*-knobs.tsx` panels, canvas viewport, mobile/desktop layouts. `components/ui/` has domain-free primitives.

## Stack

React 19 + Compiler, rolldown-vite 8, WebGPU, TypeScript (strict), Bun, oxlint.

## Path Aliases (package.json `imports`)

`#engine` -> `engine/index.ts`, `#config` -> `lib/config/index.ts`, `#lib/*`, `#types/*`, `#renderer/*`, `#hooks/*`, `#components/*`, `#context/*`, `#ui/*` -> `components/ui/*`, `#media/*` -> `media/*`, `#weights/*` -> `weights/*`.

## Lint & Typecheck

```bash
bun run lint:all    # oxlint with type-checking. Always run after changes.
```

## Testing

```bash
# Never use `bun test` in this repo. Use Vitest via the project scripts.
# Prefer running whole test suite
bun run test
# if working on specific area, run a set of tests as follows
bun run test -- __tests__/engine/action-layer-controller.spec.ts
# Add `-t "test name"` to target a single test, or use `bun run test:watch -- <path>` while iterating.
```

The opt-in real Chrome/WebGPU many-entity suite lives in `bench/`. Run it with `bun run bench:render:record -- --suite many-entity`; results include frame timings, rendered counts, decoded estimates, texture residency, allocations, uploads, and evictions. `many-131072-shared-processed-overview-pan` guards the 50k+ visible low-zoom path. The `zoom-61-unique-mixed-round-trip` and processed variant reproduce the detailed-target → full-overview → target mixed image/video gesture with true RAF pacing.

## Key Patterns

1. **Enum pattern**: Use `createEnum()` from `types/index.ts`, not TypeScript `enum`. Produces both value object and type via `.infer`. Example: `ShaderType.dithering` (value), `ShaderType` (type).
2. **Store pattern**: Extend `Store<T>` from `lib/store.ts` for reactive state. Use `createSnapshot(versionKey, create)` for `useSyncExternalStore`, `getComputed(key, versionKey, compute)` for derived values with structural sharing.
3. **Private fields**: Use `#` private class fields, not `private` keyword.
4. **No barrel exports**: Only `engine/index.ts` and `types/index.ts` have barrels. Import directly from files elsewhere.
5. **GPU resources**: Always clean up buffers/textures. Use `TexturePool` for intermediates. Key shareable source/processed textures by immutable asset and effect identity; entity IDs track ownership, not duplicate resources.
6. **Undo pattern**: Wrap state mutations in `Command.create({ execute, undo, onEvict })`, push to `undo` singleton from `lib/undo.ts`.

## Anti-Patterns

- IMPORTANT: Do not add fallback behavior unless it is absolutely necessary and you explain the exact reason why fallback behavior is mandatory!
- Do not use TypeScript `enum` keyword. Use `createEnum()`.
- Do not use `typeof import("...").Type` anywhere. Ever. Use a regular type import, a namespace type import, or an explicit local type alias instead.
- Do not add `"use client"` / `"use server"` — this is a SPA, not Next.js.
- Do not import from `node_modules` internals. Use opensrc cli for source reading.
- Do not create new context providers without discussion.

## Export Pipeline

Video: WebCodecs H.264 + mediabunny muxer in Web Worker (MP4/MOV only). GIF: gifenc in Web Worker (`lib/gif-encoder-worker.ts`). No WebM. Audio: demuxed via mediabunny, passed as raw AAC packets.

## Upscale Pipeline

WebGPU compute-based 2x upscaling via Anime4K CNN models. `renderer/upscale/` contains the GPU network, `context/upscale-queue-context.tsx` manages job queue. Supports image, GIF, and video entities. Model weights in `weights/` (JSON), loaded at runtime. 3 sizes (S/M/L) × 3 content variants (rl/an/3d).

## Provider Composition (app.tsx)

`NuqsAdapter > KeybindProvider > IconoirProvider > ToastProvider > CanvasProvider > VideoExportProvider > ExportQueueProvider > UpscaleQueueProvider > LayoutProvider`

## Vite Plugins (plugins/)

- `vite-plugin-image.ts` — `?img` import suffix. Generates responsive `<picture>` data: multi-width srcsets in avif/webp, thumbhash blur-up placeholders. Uses `sharp` for resizing.
- `vite-plugin-wgsl-minify.ts` — Minifies `.wgsl?raw` imports in production builds using `miniray`.

## Media Assets

Static media images live in `media/` (not `public/media/`). Import via `#media/*` alias with `?img` suffix for responsive image data.

## Serialization

`.vdmsh` zip files (`application/vdmsh` MIME type) via fflate. Media encoding and compression runs in a Web Worker (`lib/serialization/serialize-worker.ts`). Supports file handle saving (File System Access API) for in-place overwrites. See `lib/serialization/` for format docs.

Repeated image entities share one archive media path per asset revision; deserialization decodes that path once, restores duplicate entities synchronously in 512-entity cooperative chunks, and atomically replaces store/index state without retaining a dirty-ID set for every entity.

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is cached at `~/.opensrc/`.

Use `opensrc path` inside other commands to read source:

```bash
rg "pattern" $(opensrc path <package>)
cat $(opensrc path <package>)/path/to/file
```

<!-- opensrc:end -->
