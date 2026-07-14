# Application

Plain TypeScript use cases forming deep module interfaces between React/DOM adapters and the engine.

## Key Files

- `canvas/canvas-interaction.ts` — `CanvasInteractionService`. Hides `CanvasStore`, `GameLoop`, viewport animation, selection bounds, and viewport calculations behind input and viewport actions.
- `canvas/debug-canvas.ts` — Development-only debug entity use case, dynamically loaded for `?debug=load`.

## Patterns

- Export narrow capability interfaces plus dependency-injected factories.
- Accept data such as surface metrics and points instead of React refs or events.
- Coordinate engine objects here when a use case spans store, input, animation, or selection behavior.
- Keep application actions synchronous unless the underlying use case is inherently asynchronous.

## Anti-Patterns

- Do not import React, JSX, components, hooks, context, or concrete renderer implementations.
- Do not export engine stores, loops, controllers, or generic service-locator accessors.
- Do not turn one service into a catch-all API; split it when consumers no longer share one cohesive capability.
