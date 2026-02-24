# Hooks

Custom React hooks bridging engine/renderer state to components.

## Key Files

- `use-canvas-actions.ts` (~20KB) — Selection state computation (`SelectionState`), shader type switching with defaults, palette operations (extract, add/remove/rename, user palette CRUD), multi-select param intersection logic.
- `use-canvas-renderer.ts` — `InfiniteCanvasRenderer` lifecycle (init, cleanup, error handling). Polls for canvas element changes.
- `use-entity-cycling.ts` — Arrow-key entity cycling and focus management.
- `use-media-controls.ts` (~11KB) — Video/GIF playback controls (play/pause, seek, loop, rate).
- `use-image-input.ts` — File input for image/video/GIF upload. Validates types, loads media, creates entities.
- `use-param-value.ts` — `useParamValue<T>(path, default)`. Reads shader param for selected entities. Returns `{ value, isSupported, isMixed, update }`. Used by all knob components.
- `use-clipboard-paste.ts` — Ctrl+V paste handling.
- `use-canvas-container-resize.ts` — ResizeObserver for canvas container.
- `use-is-mobile.ts` — Touch/mobile detection (`useIsMobile()`, `useIsTouch()`).
- `use-media-query.ts` — CSS media query hook.
- `use-carousel-dots.ts` — Carousel navigation for mobile knob panels.
- `use-studio-file.ts` — `.vdmsh` file open/save via serialization module.

## Patterns

- Hooks needing canvas state use `useCanvas()` from context.
- Hooks needing high-frequency engine state (viewport, playback) use `useSyncExternalStore(canvasStore.subscribe, canvasStore.getXxxSnapshot)` directly for performance.
- `useParamValue()` is the standard way for knob components to access entity parameters. Handles multi-select uniformity.

## Anti-Patterns

- Do not put component JSX in hooks. Hooks return data and callbacks, not elements.
- Do not duplicate `useCanvas()` functionality. Check context first.
- Do not subscribe to `canvasStore.subscribe` at full `version` granularity from sidebar components. Use selective snapshots (`viewportVersion`, `selectionVersion`, `playbackVersion`).
