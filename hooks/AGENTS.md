# Hooks

Custom React hooks bridging engine/renderer state to components.

## Key Files

- `use-canvas-actions.ts` (~20KB) — Selection state, shader switching, palette operations, multi-select param merging.
- `use-canvas-renderer.ts` — `InfiniteCanvasRenderer` lifecycle (init, cleanup, error handling). Polls for canvas element changes.
- `use-entity-cycling.ts` — Arrow-key entity cycling and focus management.
- `use-media-controls.ts` (~11KB) — Video/GIF playback controls.
- `use-image-input.ts` — File input for image/video/GIF upload. Validates types, loads media, creates entities.
- `use-param-value.ts` — `useParamValue<T>(path, default)`. Reads shader param for selected entities. Returns `{ value, isSupported, isMixed, update }`. Used by all knob components.
- `use-clipboard-paste.ts` — Ctrl+V paste handling.
- Also: `use-canvas-container-resize.ts`, `use-action-layer.ts`, `use-is-mobile.ts`, `use-media-query.ts`, `use-carousel-dots.ts`.
- `use-studio-file.ts` — `.vdmsh` file open/save via serialization module. Supports file handle saving (save to same file without re-picking on Chromium).

## Patterns

- Hooks needing canvas state use `useCanvas()` from context.
- Hooks needing high-frequency engine state (viewport, playback) use `useSyncExternalStore(canvasStore.subscribe, canvasStore.getXxxSnapshot)` directly for performance.
- `useParamValue()` is the standard way for knob components to access entity parameters. Handles multi-select uniformity.

## Anti-Patterns

- Do not put component JSX in hooks. Hooks return data and callbacks, not elements.
- Do not duplicate `useCanvas()` functionality. Check context first.
- Do not subscribe to `canvasStore.subscribe` at full `version` granularity from sidebar components. Use selective snapshots (`viewportVersion`, `selectionVersion`, `playbackVersion`).
