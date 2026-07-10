# Engine

Canvas state management and input processing. This is the "model + controller" layer — no rendering, no React.

## Key Files

- `canvas-store.ts` — Central canvas state: viewport, entities, selection, version counters. Singleton.
- `frame-loop.ts` — RAF orchestration. Tracks small active sets for playing media/continuous shaders and defers render-state allocation until a frame is required.
- `game-loop.ts` (~86KB) — Main input/animation loop. Handles pointer, touch, pinch, drag, pan. Ticks per-frame controllers.
- `action-layer-controller.ts` — Mobile action layer physics and phase state machine. Singleton.
- `momentum-controller.ts` — Pan/zoom fling physics (exponential deceleration, elastic spring-back at zoom bounds). Injected deps for testability.
- `disintegration-controller.ts` — Timing + spatial data for entity delete animations. GPU resources live in renderer. Singleton.
- `viewport-animation.ts` — Eased viewport transitions (zoom-to-fit, pan-to-entity).
- `entity-drag-visual.ts` — Canvas2D overlays for entity drag feedback.
- `perf-overlay.ts` — FPS/frame-time metrics overlay.
- `index.ts` — Barrel export. This is the ONLY barrel file consumers should use (`#engine`).

## State Architecture

- `CanvasState` uses version counters (`version`, `entityVersion`, `viewportVersion`, `selectionVersion`, `playbackVersion`, `dragVersion`) for selective cache invalidation and React subscriptions.
- Snapshot types (`ViewportSnapshot`, `SelectionSnapshot`, `PlaybackSnapshot`, `DragSnapshot`, `ActionLayerSnapshot`) isolate subscription scopes — sidebar components don't re-render on viewport pan.
- Dirty flags (`viewportDirty`, `entitiesDirty`, `selectionDirty`) tell the renderer what needs redrawing.
- `RenderState` is a stable mutable frame view consumed synchronously by `InfiniteCanvasRenderer.render()`; its sorted entity array is rebuilt only when `entityVersion` changes, never for selection-only changes.
- `CanvasStore` owns the incremental `EntitySpatialIndex` shared by renderer visibility, point hit testing, and drag selection. Every geometry mutation must upsert or remove its entity from the index.
- `CanvasStore.hasRenderChanges()` checks dirty state without materializing or mutating render state.

## Patterns

- State mutated imperatively through `CanvasStore` methods, then `notify()` triggers React re-renders via the appropriate version counter.
- Use `CanvasStore.addEntities()` for bulk insertion so large imports/duplicates produce one version update and subscriber notification.
- Use `CanvasStore.restoreWorkspace()` after a complete workspace decode. It replaces entities, viewport, and spatial state with one notification and one scene-level dirty flag; do not populate `entitiesDirty` with every restored ID.
- Use `CanvasStore.updateEntities()` for multi-selection mutations. It applies every replacement/dirty ID before one version bump, subscriber notification, and aggregate debug log.
- Use `CanvasStore.removeEntities()` for bulk deletion. It deletes maps/index entries, compacts the ordered ID array once, rebuilds selection once, and emits one notification; never loop over `removeEntity()` for a selection.
- Non-spatial entity replacements update the spatial index's entity reference without removing/reinserting its cell; only position, size, rotation, and z-index changes reindex geometry.
- Use `CanvasStore.queryEntitiesInBounds()` for broad-phase canvas queries; results are exact, duplicate-free, and z-ordered. Do not restore full-map viewport or hit-test scans.
- Use `CanvasStore.queryEntitiesInBoundsUnordered()` for membership-only work such as drag selection; do not pay to sort results that are consumed as a set.
- Drag selection coalesces pointer moves in `processInput()`, swaps reusable selection sets into the store without notifying React mid-gesture, and publishes one final notification on pointer-up or cancellation.
- `GameLoop` uses dependency injection (`GameLoopDeps`) for testability. Default deps created via `createDefaultDeps()`. Receives renderer via `setRenderer()`.
- `MomentumController` also uses DI (`MomentumDeps`) — inject viewport/pan callbacks for unit testing without a real canvas.
- Touch handling uses a state machine: `TouchGestureState` tracks active touches, pinch distance, long-press timers.
- Space+drag panning uses `SpacePanMode` enum (`idle` → `ready` → `panning` → `panned`).
- Per-frame controllers (disintegration, drag visuals, action layer) are ticked each frame; return `true` while animations are active to keep the render loop running.
- The frame loop rebuilds animated-media and continuous-shader active sets only when `entityVersion` changes; selection-only changes must not trigger all-entity scans.
- Playing media advances playback time every RAF, but only visible animated entities mark textures dirty and force render; passive playback notifications are limited to the selected entity.
- Renderer-reported pending work keeps RAF alive for settled, budgeted LOD transitions after viewport input stops; it must not be implemented by pausing video playback.
- Action-layer, drag-visual, and disintegration controllers reuse their render-state wrappers; mutate stable scratch state instead of allocating objects, sets, or overlay arrays every frame.
- The FPS overlay reads direct renderer timing. Do not add `performance.mark()`/`measure()` calls to debug-mode render loops; Performance Timeline entry churn materially distorts the frames being measured.
- `notifyViewportChange()` increments only `viewportVersion`. `notifySelectionChange()` increments `selectionVersion` + `version` + `playbackVersion`.
- Entity membership, reference, effect, or playback-classification changes must increment `entityVersion`; selection and UI-only changes must not.
- Hot-path selection logs contain counts plus bounded first/last IDs. Never join or serialize an unbounded selection into a log message.

## Anti-Patterns

- Do not put rendering logic here. Engine is GPU-agnostic.
- Do not add React imports. Engine is framework-independent.
- Do not mutate entities directly — go through `CanvasStore` methods to maintain dirty flags and version counters.

## Dependencies

Imports from `#lib/canvas-math.ts`, `#config`, `#types/canvas.ts`, `#lib/touch-scroll/`, `#lib/gif-decoder.ts`, `#lib/animation-scheduler.ts`. Does NOT import from `renderer/` except for the `InfiniteCanvasRenderer` type (game-loop needs the reference).
