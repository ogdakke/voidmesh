# Engine

Canvas state management and input processing. This is the "model + controller" layer — no rendering, no React.

## Key Files

- `canvas-store.ts` — `CanvasStore extends Store<CanvasState>`. Viewport, entity map, selection state, dirty flags, version counters. Singleton: `canvasStore`. Exported via `#engine`.
- `game-loop.ts` (~86KB) — `GameLoop` class. `requestAnimationFrame` loop, pointer/touch events, entity hit detection, drag-select, multi-touch pinch/pan, long-press entity drag, space+drag canvas panning. Ticks per-frame controllers (disintegration, drag visuals, action layer).
- `action-layer-controller.ts` — `ActionLayerController`. Mobile radial context menu physics: entity rubber-banding (damped harmonic oscillator), blur intensity animation, dismiss spring-back. Phase state machine (`idle → active → transitioning_to_drag | dismissing → idle`). Singleton: `actionLayerController`.
- `disintegration-controller.ts` — `DisintegrationController`. Timing + spatial data for entity disintegration animations on deletion. Manages staggered overlay lifecycle; GPU resources live in renderer. Singleton: `disintegrationController`.
- `viewport-animation.ts` — Eased viewport transitions (zoom-to-fit, pan-to-entity).
- `entity-drag-visual.ts` — Canvas2D overlays for entity drag feedback.
- `entity-label.ts` — Canvas2D text labels for entities.
- `perf-overlay.ts` — FPS/frame-time metrics overlay.
- `index.ts` — Barrel export. This is the ONLY barrel file consumers should use (`#engine`).

## State Architecture

- `CanvasState` uses version counters (`version`, `viewportVersion`, `selectionVersion`, `playbackVersion`, `dragVersion`) for selective React subscriptions.
- Snapshot types (`ViewportSnapshot`, `SelectionSnapshot`, `PlaybackSnapshot`, `DragSnapshot`, `ActionLayerSnapshot`) isolate subscription scopes — sidebar components don't re-render on viewport pan.
- Dirty flags (`viewportDirty`, `entitiesDirty`, `selectionDirty`) tell the renderer what needs redrawing.
- `RenderState` is a per-frame snapshot consumed by `InfiniteCanvasRenderer.render()`.

## Patterns

- State mutated imperatively through `CanvasStore` methods, then `notify()` triggers React re-renders via the appropriate version counter.
- `GameLoop` holds references to both `canvasStore` and `InfiniteCanvasRenderer` but does NOT own them. Receives renderer via `setRenderer()`.
- Touch handling uses a state machine: `TouchGestureState` tracks active touches, pinch distance, long-press timers.
- Space+drag panning uses `SpacePanMode` enum (`idle` → `ready` → `panning` → `panned`).
- Per-frame controllers (disintegration, drag visuals, action layer) are ticked each frame; return `true` while animations are active to keep the render loop running.
- `notifyViewportChange()` increments only `viewportVersion`. `notifySelectionChange()` increments `selectionVersion` + `version` + `playbackVersion`.

## Anti-Patterns

- Do not put rendering logic here. Engine is GPU-agnostic.
- Do not add React imports. Engine is framework-independent.
- Do not mutate entities directly — go through `CanvasStore` methods to maintain dirty flags and version counters.

## Dependencies

Imports from `#lib/canvas-math.ts`, `#config`, `#types/canvas.ts`, `#lib/touch-scroll/`, `#lib/gif-decoder.ts`. Does NOT import from `renderer/` except for the `InfiniteCanvasRenderer` type (game-loop needs the reference).
