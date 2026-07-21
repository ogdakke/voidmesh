# Application

Framework-free use cases and narrow interfaces between React/DOM adapters and engine behavior.

## Authoritative Areas

- `canvas/canvas-interaction.ts` — Input and viewport actions hiding store and loop implementations.
- `canvas/canvas-media.ts` — Playback, seeking, mute, and media notifications.
- `canvas/entity-placement.ts`, `canvas/entity-cycling.ts` — Multi-step canvas workflows.
- `canvas/serialize-workspace.ts` — Live-state capture and archive encoding.
- `canvas/hosted-canvas-sync.ts` — Typed hosted commands around the local canvas scene.
- `canvas/hosted-canvas-projection.ts` — Progressive hosted asset hydration and narrow remote projection.
- `canvas/palettes.ts` — Palette classification and lookup shared by UI surfaces.

## Invariants

- Export cohesive capability interfaces and dependency-injected factories.
- Accept data such as points and surface metrics, not React refs or DOM events.
- Coordinate workflows here when they span store, input, animation, media, or selection behavior.
- Keep synchronous actions synchronous unless the underlying operation is inherently asynchronous.
- Hosted mode retains one resource-owning canvas scene. Collaboration state contains serializable
  scene records and playback anchors, never decoded media or renderer resources.

## Boundaries

- Canvas use cases do not import React, JSX, components, hooks, context, or concrete renderer implementations.
- Do not expose engine stores, loops, controllers, or generic service locators.
- Split a service when its consumers no longer share one cohesive capability.
