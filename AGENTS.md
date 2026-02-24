# Voidmesh

Infinite canvas app with real-time WebGPU shader effects. Users drop images/videos/GIFs onto a canvas, apply shader effects (dithering, halftone, ascii, glass, blobs, melt), and export results.

## Architecture

- `engine/` — Canvas state (`CanvasStore`) and input handling (`GameLoop`). GPU-agnostic, framework-independent.
- `renderer/` — WebGPU rendering pipeline, shader registry, effect composition, export (MP4/MOV/GIF/PNG/JPEG). `renderer/shaders/` has per-effect `ShaderPass` subclasses.
- `lib/` — Pure utilities. Math, config, media loading, serialization (`.vdmsh`), undo (command pattern), palette extraction, physics scroll. No React, no GPU.
- `types/` — Domain types (`ShaderCanvasEntity`, `ShaderParams`, `Viewport`, all enums). Bottom of dependency graph.
- `context/` — React context providers wiring engine + renderer + URL state. `canvas-context.tsx` is the main orchestrator.
- `hooks/` — React hooks bridging engine state to components. `use-param-value.ts` is the standard param accessor.
- `components/` — React UI. `*-knobs.tsx` panels, canvas viewport, mobile/desktop layouts. `components/ui/` has domain-free primitives.

## Stack

React 19 + Compiler, Vite 7, WebGPU, TypeScript (strict), Bun, oxlint + tsgo.

## Path Aliases (package.json `imports`)

`#engine` -> `engine/index.ts`, `#config` -> `lib/config/index.ts`, `#lib/*`, `#types/*`, `#renderer/*`, `#hooks/*`, `#components/*`, `#context/*`, `#ui/*` -> `components/ui/*`.

## Lint & Typecheck

```bash
bun run lint:all    # oxlint + tsgo in parallel. Always run after changes.
```

## Key Patterns

1. **Enum pattern**: Use `createEnum()` from `types/index.ts`, not TypeScript `enum`. Produces both value object and type via `.infer`. Example: `ShaderType.dithering` (value), `ShaderType` (type).
2. **Store pattern**: Extend `Store<T>` from `lib/store.ts` for reactive state. Use `createSnapshot(versionKey, create)` for `useSyncExternalStore`, `getComputed(key, versionKey, compute)` for derived values with structural sharing.
3. **Private fields**: Use `#` private class fields, not `private` keyword.
4. **No barrel exports**: Only `engine/index.ts` and `types/index.ts` have barrels. Import directly from files elsewhere.
5. **GPU resources**: Always clean up buffers/textures. Use `TexturePool` for intermediates. Track entity textures in Maps keyed by entity ID.
6. **Undo pattern**: Wrap state mutations in `Command.create({ execute, undo, onEvict })`, push to `undo` singleton from `lib/undo.ts`.

## Anti-Patterns

- Do not use TypeScript `enum` keyword. Use `createEnum()`.
- Do not add `"use client"` / `"use server"` — this is a SPA, not Next.js.
- Do not import from `node_modules` internals. Use `opensrc/` for source reading.
- Do not create new context providers without discussion.

## Export Pipeline

Video: WebCodecs H.264 + mediabunny muxer in Web Worker (MP4/MOV only). GIF: gifenc on main thread. No WebM. Audio: demuxed via mediabunny, passed as raw AAC packets.

## Provider Composition (app.tsx)

`NuqsAdapter > KeybindProvider > IconoirProvider > ToastProvider > CanvasProvider > VideoExportProvider > ExportQueueProvider > LayoutProvider`

## Serialization

`.vdmsh` zip files via fflate. See `lib/serialization/` for format docs.

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is available in `opensrc/` for deeper understanding of implementation details.

See `opensrc/sources.json` for the list of available packages and their versions.

Use this source code when you need to understand how a package works internally, not just its types/interface.

### Fetching Additional Source Code

To fetch source code for a package or repository you need to understand, run:

```bash
npx opensrc <package>           # npm package (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python package (e.g., npx opensrc pypi:requests)
npx opensrc crates:<package>    # Rust crate (e.g., npx opensrc crates:serde)
npx opensrc <owner>/<repo>      # GitHub repo (e.g., npx opensrc vercel/ai)
```

<!-- opensrc:end -->
