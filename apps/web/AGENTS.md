# Web Application

React 19 SPA with an infinite canvas and real-time WebGPU effects.

## Architecture

- `types/` — client domain types; bottom of the client dependency graph.
- `lib/` — pure utilities, media ownership, serialization, undo, math, and stores.
- `engine/` — GPU-agnostic canvas state, input, animation, and frame scheduling.
- `renderer/` — WebGPU rendering, shaders, resource caches, and export.
- `application/` — framework-free use cases and narrow subsystem interfaces.
- `context/` — React composition root connecting application, engine, and renderer.
- `hooks/` — React adapters for context/application capabilities and DOM events.
- `components/` — feature UI; `components/ui/` contains domain-free primitives.

Read the nearest subsystem `AGENTS.md` before editing that area.

## Imports and State

Cross-module imports use the `#...` aliases in this package's `package.json#imports`. Do not bypass client module boundaries with relative cross-subsystem imports. Only `engine/index.ts` and `types/index.ts` are barrel exports.

- Do not add `"use client"` or `"use server"`; this is a SPA.
- UI reads canvas state through narrow selectors and writes through commands/application services. Components and hooks do not import engine singletons.
- GPU resources require explicit cleanup. Share immutable media/GPU work by asset/effect identity; entity IDs represent ownership, not resource identity.
- Multi-entity actions use bulk store mutations and one undo command.
- Local workspaces must remain fully usable without an account or API availability.
- Hosted synchronization belongs behind application-layer interfaces; the canvas engine and renderer do not call the hosted API directly.
