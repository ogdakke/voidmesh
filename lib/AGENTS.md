# Lib

Pure utility layer. No React, no GPU, no engine state. Sits at the bottom of the dependency graph (alongside `types/`).

## Key Files

- `config/index.ts` (~25KB) — Central config: feature definitions, defaults, visibility rules, rendering/export settings. Imported as `#config`.
- `canvas-math.ts` (~15KB) — Coordinate transforms, bounds math, viewport matrices, grid calculations.
- `entity-spatial-index.ts` — Incremental multi-resolution entity AABB index. Stores each entity in one size-appropriate center bucket, returns exact queries with optional z-order preservation, and reuses the store's ordered array when an ordered query covers the entire index.
- `store.ts` — `Store<T>` base class for `useSyncExternalStore`. Provides `createSnapshot(versionKey, create)` and `getComputed(key, versionKey, compute)` with structural sharing via `shallowEqual`.
- `undo.ts` — Command pattern. `Command.create({ execute, undo, onEvict })`. `Undo` class with size limits and transaction grouping. Singleton: `undo`.
- `media-loader.ts` — Loads/parses images, videos, GIFs, SVGs. Extracts palettes and frame rates.
- `media-assets.ts` — Creates shared image assets and manages decoded-bitmap lifetime with explicit retain/release ownership.
- `media-resources.ts` — Central exception-safe disposal for entity/detached media and video elements.
- `app-loader.ts` — Controls the HTML loading screen. `setText()` updates status text, `dismiss()` hides with min-display guarantee.
- `serialization/` — `.vdmsh` zip format with versioning and migrations. v6 preserves original encoded media bytes with explicit MIME metadata; imports validate manifests/duplicate IDs, stage decoded ownership until adoption, yield in bounded chunks, and decode each repeated image path once.
- `files/file-handle.ts` — File System Access API handle storage for in-place workspace saving (Chromium only).
- `files/random-filename.ts` + `files/filename-words.ts` — Random filename generation for workspace files.
- `palette-extraction/` — K-means clustering for color palettes.
- `palette-store.ts` — User palette CRUD (persisted via unstorage).
- `animation-scheduler.ts` — `AnimationScheduler`. Tick-driven scheduler for tweens, 2D springs, and custom animations. Handles lifecycle (cancel, complete callbacks), tag-based cancellation. Singleton: `scheduler`.
- `touch-scroll/` — Physics-based momentum scrolling with springs and velocity tracking.
- `client.logger.ts` — Logger with levels. `console.log`/`debug` stripped in production via Vite/oxc config.
- `color-utils.ts` — OKLCH color model, gamut clamping, CSS parsing, color-space-aware luminance.
- `gif-encoder.ts` + `gif-encoder-worker.ts` — GIF encoding via gifenc in Web Worker.
- `download.ts` — File downloads and file picker (with iOS compatibility).
- `storage.ts` — Browser storage abstraction (unstorage) for persisted preferences.
- `collaboration/protocol.ts` — Invite fragments, content-addressed asset descriptors, hashing, validation, and selective gzip for compressible text payloads.
- `collaboration/document.ts` — Yjs entity/layer document with grouped identity, geometry, appearance, asset, and playback fields.
- `collaboration/metrics.ts` — Reactive counters and bounded transfer diagnostics for collaboration sessions.
- Also: `config/action-layer.config.ts`, `entity-placement.ts`, `deep-merge.ts`, `shader-defaults.ts`, `gif-decoder.ts`.

## Patterns

- Pure functions where possible. No side effects, no singletons (except `undo`, `logger`, `paletteStore`, `scheduler`).
- Image duplication shares `MediaImageAsset` objects. Retain before attaching an asset to another entity and release only when that entity's undo-owned resources are evicted.
- Image assets record alpha capability from their encoded format; JPEG assets are known opaque so the renderer can omit alpha-mask intermediates.
- Config is a frozen object. Do not mutate at runtime.
- Hot-path bounds helpers accept caller-owned output objects; renderer culling must pass scratch `Bounds` instead of allocating one per entity.
- Spatial queries reuse caller-owned result arrays. Preserve z-order for rendering/hit testing; disable sorting for membership-only consumers. Update the index whenever entity position, size, rotation, z-index, insertion, or removal changes.
- Current-version deserialization reuses the unique objects produced by `JSON.parse`; recursively merge cloned defaults only for schema-mismatched documents that require compatibility filling.
- Serialized MIME describes the exact bytes at `mediaFile`, never the entity display-name extension. Reconstruct every media Blob with that MIME so downstream sharing retains a decodable type.
- Resource-producing async batches must await every sibling before unwinding fulfilled results. Use `disposeMediaSource()`/`disposeEntityMedia()`; do not close a shared image bitmap directly.
- `Undo.clear()` evicts committed stacks and any active transaction. Workspace replacement relies on this to prevent late transaction commits from targeting imported colliding IDs.
- GIF/video decode paths close decoders, frames, snapshots, and blob-backed elements on every exception path.
- Treat already-encoded image/video/GIF payloads as identity transfers; gzip only explicitly compressible formats and only when the result is smaller.

## Anti-Patterns

- Do not import React here. `store.ts` provides hooks integration but has no React import itself.
- Do not add GPU-specific code. Rendering utilities belong in `renderer/`. Color-space-dependent functions accept a `ColorSpace` enum parameter instead of reading GPU state.
- Do not import from `engine/`, `renderer/`, `context/`, `components/`, or `hooks/`.
