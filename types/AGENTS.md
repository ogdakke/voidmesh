# Types

Canonical domain type definitions. Shared across all subsystems. Bottom of the dependency graph — imports from nothing else.

## Key Files

- `canvas.ts` (~16KB) — Core domain model: `Point`, `Size`, `Bounds`, `Viewport`, `ShaderCanvasEntity`, `ShaderParams`, `PostProcessParams`, `AdjustmentsParams`, `PlaybackState`, `ColorPalette`, `RGBA`. All enum-like discriminants: `ShaderType`, `DitheringKind`, `AsciiKind`, `GlassKind`, `Shape`, `MediaType`, `DragTargetType`. Type guards: `isVideoEntity()`, `isGifEntity()`, `isAnimatedEntity()`. Utility types: `ParamPaths`, `GetParamByPath<P>`.
- `index.ts` — `createEnum()` factory function and utility types (`Thunk`, `ThunkSync`, `EnumOf`).
- `gifenc.d.ts` — Type declarations for the untyped `gifenc` npm package.

## Enum Convention

```typescript
// createEnum() produces both a value object and a type:
const ShaderType = createEnum({ halftone: "halftone", dithering: "dithering", ... });
type ShaderType = typeof ShaderType.infer;

// Usage: ShaderType.dithering (value), ShaderType (type)
```

## Entity Model

`ShaderCanvasEntity` is a discriminated union on `mediaSource.type` (`image`, `video`, `gif`). Use type guards `isVideoEntity()`, `isGifEntity()`, `isAnimatedEntity()` — do not check `.mediaSource.type` directly in consuming code.

## Anti-Patterns

- Do not put runtime logic here beyond type guards and `createEnum()`. Utility functions go in `lib/`.
- Do not import from any other subsystem.
