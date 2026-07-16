# Lib

Pure utilities and low-level infrastructure: configuration, stores, math, media loading/ownership, serialization, undo, palette extraction, and animation helpers.

## Authoritative Areas

- `config/` — Frozen application and effect configuration.
- `store.ts` — External-store base with versioned snapshots and computed values.
- `entity-spatial-index.ts` — Incremental canvas broad-phase queries.
- `media-assets.ts`, `media-resources.ts`, `media-loader.ts` — Media identity and lifetime.
- `serialization/` — `.vdmsh` archive encoding, decoding, validation, and migrations.
- `undo.ts` — Command history and eviction lifecycle.
- `canvas-math.ts`, `color-utils.ts` — Pure coordinate and color operations.

## Invariants

- Prefer pure functions and caller-owned scratch outputs in hot paths.
- Config is immutable at runtime.
- Spatial queries reuse result arrays and preserve ordering only when the caller needs it.
- Shared image assets use explicit retain/release ownership. Never close a shared bitmap directly.
- Async resource batches await all siblings before unwinding and dispose every fulfilled resource on failure.
- Serialization validates and stages complete ownership before atomically replacing live state.
- Current-format data should reuse parsed immutable structures; clone/merge defaults only for compatibility migrations.
- Undo commands own cleanup through `onEvict`; clearing history must also clear active transactions.

## Boundaries

- No React or GPU-specific code.
- Do not import from engine, renderer, context, hooks, or components.
- Runtime utilities beyond type guards do not belong in `types/`.
