# Context

React composition and orchestration connecting application services, engine state, renderer lifecycle, queues, URL state, and UI consumers.

## Authoritative Areas

- `canvas-context.tsx` — Canvas composition root, commands, undo ownership, import/export, and renderer registration.
- `use-canvas.ts` — Narrow selectors, commands, and capability contexts.
- `keybind-context.ts`, `keybind-provider.tsx` — Hierarchical keyboard shortcuts.
- `export-queue-context.tsx`, `video-export-context.tsx` — Export state and sequential jobs.
- `upscale-queue-context.tsx` — Sequential upscale jobs and ownership.

## Invariants

- `CanvasProvider` is the composition root for concrete engine and renderer implementations.
- Expose narrow, stable selector and command surfaces; do not expose stores, loops, or a broad `useCanvas()` object.
- Keep provider values and renderer registration callbacks stable across unrelated React renders.
- React-facing multi-entity operations use one bulk store mutation and one undo command in each direction.
- Undo snapshots retain media ownership until eviction; image cleanup releases the shared asset reference.
- Imports stage decoded resources, atomically restore the workspace, then release the old state.
- Async work validates stable media identity before applying results to entities.
- Queue providers serialize GPU-heavy work and isolate export/upscale media from live preview playback.

## Boundaries

- Context coordinates; it does not implement rendering or GPU work.
- Canvas state mutations exposed to React originate here or in application services.
- Discuss new top-level providers before adding them; prefer a narrow capability inside the existing composition.
