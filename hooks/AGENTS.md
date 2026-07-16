# Hooks

React adapters between components, context/application capabilities, DOM events, and renderer lifecycle.

## Authoritative Areas

- `use-canvas-renderer.ts`, `use-canvas-renderer-runtime.ts` — Renderer initialization and runtime binding.
- `use-canvas-surface-events.ts` — DOM input translation.
- `use-infinite-canvas-keybinds.ts` — Canvas shortcut registration.
- `use-media-controls.ts` — Video/GIF control behavior.
- `use-param-value.ts` — Standard selected-entity parameter access.
- `use-studio-file.ts` — Workspace open/save.

## Invariants

- Read canvas state through focused selectors from `context/use-canvas.ts`.
- Write through `useCanvasCommands()` or application-owned capabilities.
- Translate DOM events into data before crossing the application boundary.
- High-frequency viewport, playback, drag, and action-layer state uses focused external-store snapshots.
- `useParamValue()` is the standard knob interface and owns multi-selection support/mixed-value semantics.

## Boundaries

- Do not import engine singletons or subscribe to the full canvas version.
- Hooks return state and callbacks, not component JSX.
- Do not recreate a broad `useCanvas()` surface.
