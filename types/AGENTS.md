# Types

Canonical domain type definitions. Shared across all subsystems. Bottom of the dependency graph — imports from nothing else.

## Key Files

- `canvas.ts` (~17KB) — Core domain model. Entity types, shader params, viewport, palettes, all `createEnum()` discriminants, type guards, and utility types like `ParamPaths`.
- `index.ts` — `createEnum()` factory function and utility types (`Thunk`, `ThunkSync`, `EnumOf`).
- `gifenc.d.ts` — Type declarations for the untyped `gifenc` npm package.
- `eyedropper.d.ts` — Type declarations for the browser EyeDropper API

## Enum Convention

```typescript
// createEnum() produces both a value object and a type:
const ShaderType = createEnum({ halftone: "halftone", dithering: "dithering", ... });
type ShaderType = typeof ShaderType.infer;

// Usage: ShaderType.dithering (value), ShaderType (type)
```

## Entity Model

`ShaderCanvasEntity` is a discriminated union on `mediaSource.type` (`image`, `video`, `gif`, `svg`). Use type guards `isVideoEntity()`, `isGifEntity()`, `isAnimatedEntity()`, `isSvgEntity()` — do not check `.mediaSource.type` directly in consuming code.

Static image entities reference a shared `MediaImageAsset` through `mediaSource.asset`. Entity transforms and shader state remain per-instance; decoded pixels, encoded source data, alpha capability, identity, and revision live on the asset.

Every entity may retain a `MediaPreview` (`thumbhash-v1`) for workspace persistence and provisional collaboration rendering. The preview represents the image or first decoded frame; it is metadata, not the authoritative media source.

## Anti-Patterns

- Do not put runtime logic here beyond type guards and `createEnum()`. Utility functions go in `lib/`.
- Do not import from any other subsystem.
