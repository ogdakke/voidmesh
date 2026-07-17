# Types

Canonical domain types at the bottom of the dependency graph.

## Authoritative Areas

- `canvas.ts` — Entities, shader params, viewport, palettes, type guards, and parameter paths.
- `index.ts` — `createEnum()` and shared type utilities.
- `*.d.ts` — Missing browser/package declarations.

## Invariants

- Use `createEnum()` for discriminants, producing both the value object and its `.infer` type.
- `ShaderCanvasEntity` is discriminated by media source; consumers use the provided type guards.
- Static image entities reference shared immutable media assets while transform and shader state remain per entity.

## Boundaries

- Do not import from other subsystems.
- Runtime logic beyond type guards and `createEnum()` belongs in `lib/`.
