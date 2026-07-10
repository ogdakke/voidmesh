# Lib

Pure utility layer. No React, no GPU, no engine state. Sits at the bottom of the dependency graph (alongside `types/`).

## Key Files

- `config/index.ts` (~25KB) — Central config: feature definitions, defaults, visibility rules, rendering/export settings. Imported as `#config`.
- `canvas-math.ts` (~15KB) — Coordinate transforms, bounds math, viewport matrices, grid calculations.
- `store.ts` — `Store<T>` base class for `useSyncExternalStore`. Provides `createSnapshot(versionKey, create)` and `getComputed(key, versionKey, compute)` with structural sharing via `shallowEqual`.
- `undo.ts` — Command pattern. `Command.create({ execute, undo, onEvict })`. `Undo` class with size limits and transaction grouping. Singleton: `undo`.
- `media-loader.ts` — Loads/parses images, videos, GIFs, SVGs. Extracts palettes and frame rates.
- `media-assets.ts` — Creates shared image assets and manages decoded-bitmap lifetime with explicit retain/release ownership.
- `app-loader.ts` — Controls the HTML loading screen. `setText()` updates status text, `dismiss()` hides with min-display guarantee.
- `serialization/` — `.vdmsh` zip format with versioning and migrations. Encoding/compression in Web Worker.
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
- Also: `config/action-layer.config.ts`, `entity-placement.ts`, `deep-merge.ts`, `shader-defaults.ts`, `gif-decoder.ts`.

## Patterns

- Pure functions where possible. No side effects, no singletons (except `undo`, `logger`, `paletteStore`, `scheduler`).
- Image duplication shares `MediaImageAsset` objects. Retain before attaching an asset to another entity and release only when that entity's undo-owned resources are evicted.
- Image assets record alpha capability from their encoded format; JPEG assets are known opaque so the renderer can omit alpha-mask intermediates.
- Config is a frozen object. Do not mutate at runtime.

## Anti-Patterns

- Do not import React here. `store.ts` provides hooks integration but has no React import itself.
- Do not add GPU-specific code. Rendering utilities belong in `renderer/`. Color-space-dependent functions accept a `ColorSpace` enum parameter instead of reading GPU state.
- Do not import from `engine/`, `renderer/`, `context/`, `components/`, or `hooks/`.
