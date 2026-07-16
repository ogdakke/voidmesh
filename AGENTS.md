# Voidmesh

Infinite-canvas React application with real-time WebGPU effects for images, videos, GIFs, and SVGs.

## Architecture

- `types/` — Domain types and enums; bottom of the dependency graph.
- `lib/` — Pure utilities, media ownership, serialization, undo, math, and stores.
- `engine/` — GPU-agnostic canvas state, input, animation, and frame scheduling.
- `renderer/` — WebGPU rendering, shaders, resource caches, export, and upscale.
- `application/` — Framework-free use cases and narrow subsystem interfaces.
- `context/` — React composition root connecting application, engine, and renderer.
- `hooks/` — React adapters for context/application capabilities and DOM events.
- `components/` — Feature UI; `components/ui/` contains domain-free primitives.

Read the nearest subsystem `AGENTS.md` before editing that area.

## Stack and Imports

React 19 with Compiler, Vite 8, WebGPU, strict TypeScript, Bun, oxlint.

Cross-module imports use the `#...` aliases in `package.json#imports`. Do not bypass module boundaries with relative cross-subsystem imports. Only `engine/index.ts` and `types/index.ts` are barrel exports.

## Required Conventions

- Use `createEnum()` from `types/index.ts`; never use TypeScript `enum`.
- Use native `#` private fields, not the `private` keyword.
- Never use `typeof import("...").Type`; write a normal type import or local type alias.
- Do not add `"use client"` or `"use server"`; this is a SPA.
- Do not import package internals. Use the public API and `opensrc path <package>` when source inspection is needed.
- Do not add fallback behavior unless it is necessary and the reason is documented.
- UI reads canvas state through narrow selectors and writes through commands/application services. Components and hooks do not import engine singletons.
- GPU resources require explicit cleanup. Share immutable media/GPU work by asset/effect identity; entity IDs represent ownership, not resource identity.
- Multi-entity actions use bulk store mutations and one undo command.

## Validation

During iteration, run the narrowest affected tests. At final handoff, run once:

```bash
bun run lint:all
bun run test
```

Never use `bun test`; use the project Vitest scripts.

For performance work:

- Define the exact interaction, workload, browser/device, and primary metric.
- Inspect raw traces with bounded, targeted queries; aggregate summaries are orientation, not diagnosis.
- Capture a baseline before editing and test one falsifiable hypothesis at a time.
- Run the smallest matching benchmark during iteration.
- Before handoff, guard the reported stress case with a realistic mixed-media scenario and compare semantic counters as well as timings.

Use `bun run bench:render:ab -- --base main --scenario <id> --metric <metric>` for same-machine base-ref/current-tree comparisons.

## AGENTS.md Policy

AGENTS files are routing and durable invariants, not architecture diaries.

- Update them only when a public boundary, ownership rule, authoritative entry point, or project-wide invariant changes.
- Do not record bug history, benchmark results, tuning thresholds, temporary workarounds, current file sizes, or detailed implementation mechanics.
- Replace stale guidance instead of appending another bullet.
- Keep subsystem files under roughly 600 words. If an addition would exceed that, consolidate or move detailed explanation to dedicated documentation.

## Source References

Dependency source is cached under `~/.opensrc/`:

```bash
rg "pattern" $(opensrc path <package>)
```
