# Engine

GPU-agnostic canvas state, input, animation, spatial queries, and RAF scheduling. No React or rendering code.

## Authoritative Areas

- `canvas-store.ts` — Entities, viewport, selection, spatial index, versions, and dirty state.
- `game-loop.ts` — Pointer, touch, pinch, drag, and pan processing.
- `frame-loop.ts` — RAF lifecycle and active animated-work tracking.
- `entity-drag-controller.ts`, `momentum-controller.ts`, `action-layer-controller.ts` — Interaction state machines.
- `index.ts` — The public `#engine` surface.

## State Invariants

- Version counters and focused snapshots isolate subscribers. Viewport-only work must not notify unrelated React consumers.
- `RenderState` is a stable synchronous view for the renderer. Dirty flags describe the smallest changed domain.
- `CanvasStore` owns the spatial index. Every insertion, removal, and geometry change must keep it synchronized.
- Use bulk APIs for multi-entity work: `addEntities`, `updateEntities`, `removeEntities`, `moveEntities`, `selectAll`, and `restoreWorkspace`.
- Membership or z-order changes may rebuild ordered state; non-ordering replacements should patch it.
- Use ordered spatial queries for rendering/hit testing and unordered queries for membership-only operations.
- Selection dragging uses transient offsets during the gesture and commits geometry once on release.
- Cache selection-derived arrays, bounds, and parameter aggregation by the narrow version that invalidates them.
- Remote cursor and selection presence is ephemeral render state with independent cursor and selection versions; presence updates must not notify React or dirty entity textures.

## Runtime Invariants

- Frame scheduling tracks active media, continuous shaders, controllers, and renderer-reported pending work without scanning the whole scene every RAF.
- Per-frame controllers and render-state wrappers reuse storage; avoid hot-path object, array, set, and log allocation.
- Passive pointer movement does not perform unbounded entity or alpha hit testing.
- `GameLoop` and physics controllers use dependency injection for tests.
- Read-only input still permits viewport navigation and selection, but must not commit entity or
  playback mutations; an access downgrade cancels any transient drag instead of committing it.

## Boundaries

- Mutate canvas state only through `CanvasStore` methods.
- Do not add GPU concepts or React imports.
- External consumers import from `#engine`, not engine implementation files.
