# Lib

Pure utility layer. No React, no GPU, no engine state. Sits at the bottom of the dependency graph (alongside `types/`).

## Key Files

- `config/index.ts` (~25KB) — Central config. `ShaderFeature` definitions (which params each shader supports), `shaderDefaults` (reset/merge on shader switch), `paramVisibilityRules` (conditional param visibility), rendering constants, export settings. Imported as `#config`.
- `canvas-math.ts` (~15KB) — Coordinate transforms (`screenToWorld`, `worldToScreen`, `zoomToPoint`), bounds intersection, viewport matrix, grid level calculation, snap-to-grid. Pure functions on `Point`/`Viewport`/`Bounds`.
- `store.ts` — `Store<T>` base class for `useSyncExternalStore`. Provides `createSnapshot(versionKey, create)` and `getComputed(key, versionKey, compute)` with structural sharing via `shallowEqual`.
- `undo.ts` — Command pattern. `Command.create({ execute, undo, onEvict })`. `Undo` class with size limits and transaction grouping. Singleton: `undo`.
- `media-loader.ts` — Loads images (`File -> ImageBitmap`), videos (`File -> HTMLVideoElement + frame`), GIFs (`File -> decoded frames`), SVGs (`File -> rasterized ImageBitmap`). SVGs are rasterized to 1024px on longest axis via `rasterizeSvg()`. Palette extraction, frame rate detection.
- `app-loader.ts` — Controls the HTML loading screen. `setText()` updates status text, `dismiss()` hides with min-display guarantee.
- `serialization/` — `.vdmsh` zip format (fflate). Versioned manifest with migrations.
- `palette-extraction/` — K-means clustering for color palettes.
- `palette-store.ts` — User palette CRUD (persisted via unstorage).
- `touch-scroll/` — Physics-based momentum scrolling. `VelocityTracker`, `Scroller`, `SpringBack`.
- `client.logger.ts` — Logger with levels. `console.log`/`debug` stripped in production via Vite/oxc config.
- `color-utils.ts` — OKLCH color model (`OklchColor`, conversion pipeline OKLCH↔OKLab↔LMS↔Linear P3/sRGB), gamut clamping (`clampChromaToP3`), CSS parsing/formatting (`cssToOklch`, `oklchToCss`, `oklchToP3Css`), hex shorthand support, color-space-aware luminance and palette sorting (accept `ColorSpace` enum param).
- `entity-placement.ts` — Drop position calculation for new entities.
- `deep-merge.ts` — Deep object merge for `PartialDeep<ShaderParams>`.
- `shader-defaults.ts` — Applies `shaderDefaults` from config on shader type switch.
- `gif-decoder.ts` — Binary search frame lookup by timestamp.
- `storage.ts` — Browser storage abstraction (unstorage). `preferences` object for persisted user settings (snapToGrid, fancyDelete, custom palettes).

## Patterns

- Pure functions where possible. No side effects, no singletons (except `undo`, `logger`, `paletteStore`).
- Config is a frozen object. Do not mutate at runtime.

## Anti-Patterns

- Do not import React here. `store.ts` provides hooks integration but has no React import itself.
- Do not add GPU-specific code. Rendering utilities belong in `renderer/`. Color-space-dependent functions accept a `ColorSpace` enum parameter instead of reading GPU state.
- Do not import from `engine/`, `renderer/`, `context/`, `components/`, or `hooks/`.
