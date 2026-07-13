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

- `CanvasState` uses version counters (`version`, `entityVersion`, `geometryVersion`, `viewportVersion`, `selectionVersion`, `playbackVersion`, `dragVersion`, `presenceVersion`, `presenceSelectionVersion`) for selective cache invalidation and React subscriptions. Imperative moves and ephemeral presence stay off React notifications.
- Snapshot types (`ViewportSnapshot`, `SelectionSnapshot`, `PlaybackSnapshot`, `DragSnapshot`, `ActionLayerSnapshot`) isolate subscription scopes — sidebar components don't re-render on viewport pan.
- Dirty flags (`viewportDirty`, `entitiesDirty`, `selectionDirty`, `presenceDirty`) tell the renderer what needs redrawing.
- `RenderState` is a stable mutable frame view consumed synchronously by `InfiniteCanvasRenderer.render()`; it exposes `entityVersion`/`geometryVersion` for renderer caches, and its sorted entity array is rebuilt only when `entityVersion` changes.
- `CanvasStore` owns the incremental `EntitySpatialIndex` shared by renderer visibility, point hit testing, and drag selection. Every geometry mutation must upsert or remove its entity from the index.
- `CanvasStore.hasRenderChanges()` checks dirty state without materializing or mutating render state.
- Entity mutations publish a typed change feed for non-React integrations such as collaboration; remote projections must suppress echo at their orchestrator boundary.

## Patterns

- State mutated imperatively through `CanvasStore` methods, then `notify()` triggers React re-renders via the appropriate version counter.
- Use `CanvasStore.addEntities()` for bulk insertion so large imports/duplicates produce one version update and subscriber notification.
- Use `CanvasStore.restoreWorkspace()` after a complete workspace decode. It builds and validates the next entity map/spatial index before swapping them, rejects duplicate IDs, then publishes one notification and one scene-level dirty flag; do not populate `entitiesDirty` with every restored ID.
- Use `CanvasStore.updateEntities()` for multi-selection mutations. It applies every replacement/dirty ID before one version bump, subscriber notification, and aggregate debug log.
- Use `CanvasStore.removeEntities()` for bulk deletion. It deletes maps/index entries, compacts the ordered ID array once, rebuilds selection once, and emits one notification; never loop over `removeEntity()` for a selection.
- Use `CanvasStore.selectAll()` for whole-canvas selection; it builds the selected-ID set directly from the ordered IDs without an intermediate array or redundant membership checks.
- Non-spatial entity replacements update the spatial index's entity reference without removing/reinserting its cell; only position, size, rotation, and z-index changes reindex geometry.
- Use `CanvasStore.queryEntitiesInBounds()` for broad-phase canvas queries; results are exact, duplicate-free, and z-ordered. Do not restore full-map viewport or hit-test scans.
- Use `CanvasStore.queryEntitiesInBoundsUnordered()` for membership-only work such as drag selection; do not pay to sort results that are consumed as a set.
- Drag selection coalesces pointer moves in `processInput()`, swaps reusable selection sets into the store without notifying React mid-gesture, and publishes one final notification on pointer-up or cancellation.
- Selection-derived entity arrays are materialized at most once per `selectionVersion`. Multi-selection world bounds are cached across viewport-only frames and invalidated by selected-set identity, `entityVersion`, or `geometryVersion`.
- Object-valued multi-selection params deduplicate structurally equal clones; do not retain one object per selected entity in `ParamResult.values` or stringify equal objects on every comparison.
- `GameLoop` uses dependency injection (`GameLoopDeps`) for testability. Default deps created via `createDefaultDeps()`. Receives renderer via `setRenderer()`.
- `MomentumController` also uses DI (`MomentumDeps`) — inject viewport/pan callbacks for unit testing without a real canvas.
- Touch handling uses a state machine: `TouchGestureState` tracks active touches, pinch distance, long-press timers.
- Space+drag panning uses `SpacePanMode` enum (`idle` → `ready` → `panning` → `panned`).
- Per-frame controllers (disintegration, drag visuals, action layer) are ticked each frame; return `true` while animations are active to keep the render loop running.
- The frame loop rebuilds animated-media and continuous-shader active sets only when `entityVersion` changes; selection-only changes must not trigger all-entity scans.
- Playing media advances playback time every RAF, but only visible animated entities mark textures dirty and force render; passive playback notifications are limited to the selected entity and never publish entity-mutation intent. Play/pause/seek/settings mutations represent discrete control anchors; publish play intent before awaiting `HTMLMediaElement.play()` and publish a paused rollback if the promise rejects.
- Renderer-reported pending work keeps RAF alive for settled, budgeted LOD transitions after viewport input stops; it must not be implemented by pausing video playback.
- When a hidden page becomes visible or is restored from page cache, invalidate the presented frame: browsers may discard a WebGPU canvas backing surface while retaining GPU textures.
- Action-layer, drag-visual, and disintegration controllers reuse their render-state wrappers; mutate stable scratch state instead of allocating objects, sets, or overlay arrays every frame.
- The FPS overlay reads direct renderer timing. Do not add `performance.mark()`/`measure()` calls to debug-mode render loops; Performance Timeline entry churn materially distorts the frames being measured.
- `notifyViewportChange()` increments only `viewportVersion`. `notifySelectionChange()` increments `selectionVersion` + `version` + `playbackVersion`.
- Entity membership, reference, effect, or playback-classification changes must increment `entityVersion`; selection and UI-only changes must not.
- Hot-path selection logs contain counts plus bounded first/last IDs. Never join or serialize an unbounded selection into a log message.
- Passive pointer movement does not perform entity or alpha hit testing. Keep hit testing tied to explicit click/touch/drag interactions until a bounded hover effect exists.
- Local cursor world coordinates publish from RAF-coalesced input; remote peer cursors/selections live in transient store state with independent cursor/selection versions. Never dirty entity textures or notify React for presence motion.

## Anti-Patterns

- Do not put rendering logic here. Engine is GPU-agnostic.
- Do not add React imports. Engine is framework-independent.
- Do not mutate entities directly — go through `CanvasStore` methods to maintain dirty flags and version counters.

## Dependencies

Imports from `#lib/canvas-math.ts`, `#config`, `#types/canvas.ts`, `#lib/touch-scroll/`, `#lib/gif-decoder.ts`, `#lib/animation-scheduler.ts`. Does NOT import from `renderer/` except for the `InfiniteCanvasRenderer` type (game-loop needs the reference).
