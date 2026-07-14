# Application

Plain TypeScript use cases forming deep module interfaces between React/DOM adapters and the engine.

## Key Files

- `canvas/canvas-interaction.ts` — `CanvasInteractionService`. Hides `CanvasStore`, `GameLoop`, viewport animation, selection bounds, and viewport calculations behind input and viewport actions.
- `canvas/canvas-media.ts` — `CanvasMediaService`. Hides entity lookup, playback dispatch, seeking, mute, and playback notifications behind an injected store port.
- `canvas/entity-placement.ts` and `canvas/entity-cycling.ts` — Canvas workflows that coordinate media loading, selection, layout, and viewport animation.
- `canvas/serialize-workspace.ts` — Captures live canvas state and delegates archive encoding to the serialization worker.
- `canvas/palettes.ts` — Palette lookup, classification, naming, and list construction shared by context and UI.
- `notifications.ts` and `hints.ts` — Shared presentation services used by hooks, contexts, and components without importing component internals upward.
- `canvas/debug-canvas.ts` — Development-only debug entity use case, dynamically loaded for `?debug=load`.

## Patterns

- Export narrow capability interfaces plus dependency-injected factories.
- Accept data such as surface metrics and points instead of React refs or events.
- Coordinate engine objects here when a use case spans store, input, animation, or selection behavior.
- Keep application actions synchronous unless the underlying use case is inherently asynchronous.

## Anti-Patterns

- Canvas use-case modules do not import React, JSX, components, hooks, context, or concrete renderer implementations. Shared presentation services may adapt a UI library, but must not import component implementations.
- Do not export engine stores, loops, controllers, or generic service-locator accessors.
- Do not turn one service into a catch-all API; split it when consumers no longer share one cohesive capability.
