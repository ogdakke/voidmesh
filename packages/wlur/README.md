# wlur

`wlur` is an internal WebGPU package for progressive directional blur.

It is inspired by [Glur](https://github.com/joogps/Glur), but adapted to Voidmesh’s render pipeline and WebGPU constraints:

- works on arbitrary `GPUTexture` inputs and outputs
- keeps the core effect generic instead of canvas-specific
- supports optional noise after blur
- supports quality tuning through kernel size and render scale
- caches scratch textures internally so fullscreen usage is practical

`wlur` is intentionally organized like a package inside `packages/`, but it is not a separate Bun workspace or published package.

## What It Does

`wlur` applies a blur whose strength varies across the image.

Typical examples:

- strongest at the bottom, fading out upward
- strongest at the left, fading out to the right
- fullscreen overlay blur on a composed scene
- per-entity blur pass on an intermediate texture

The core abstraction is `WlurPass`, which encodes a multi-pass effect into an existing `GPUCommandEncoder`.

Pipeline shape:

1. optional downscaled input copy
2. horizontal blur
3. vertical blur
4. composite blurred result back over the original based on a directional falloff
5. optional noise overlay

## Public API

```ts
type WlurDirection = "down" | "up" | "right" | "left";

interface WlurParams {
  radius: number;
  curve?: readonly [number, number, number, number];
  offset: number;
  interpolation: number;
  direction: WlurDirection;
  noise: number;
  tint?: {
    color: readonly [number, number, number];
    amount: number;
    curve?: readonly [number, number, number, number];
  };
}

interface WlurQuality {
  kernelSize: number;
  resolutionScale: number;
}

interface WlurPassConfig {
  quality?: Partial<WlurQuality>;
}

class WlurPass {
  constructor(options: {
    device: GPUDevice;
    format: GPUTextureFormat;
    quality?: Partial<WlurQuality>;
    label?: string;
  });

  initialize(): void;
  updateConfig(config?: WlurPassConfig): void;
  encode(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    outputTexture: GPUTexture,
    width: number,
    height: number,
    params: WlurParams,
  ): void;
  destroy(): void;
}
```

Exports live in [index.ts](/Users/danielwargh/.codex/worktrees/5e09/voidmesh/packages/wlur/index.ts).

## Parameter Semantics

`WlurParams` follows the same mental model as Glur:

- `radius`: maximum blur radius when the effect is fully active
- `curve`: CSS-compatible cubic-bezier shaping applied to the wlur ramp
- `offset`: normalized point where the effect starts
- `interpolation`: normalized distance over which blur ramps from 0 to full strength
- `direction`: which edge or side the blur grows from
- `noise`: optional post-blur noise strength
- `tint`: optional blur-region tint color, amount, and curve override

Examples:

- bottom overlay blur: `{ direction: "down", offset: 0.75, interpolation: 0.25 }`
- right-edge blur: `{ direction: "right", offset: 0.8, interpolation: 0.2 }`
- frosted white bottom blur: `{ direction: "down", offset: 0.75, interpolation: 0.25, tint: { color: [1, 1, 1], amount: 0.18 } }`
- quicker bottom-edge fade: `{ curve: [0.55, 0, 1, 0.45] }`
- stronger tint edge with a different falloff: `{ tint: { color: [1, 1, 1], amount: 1, curve: [0.28, 0.78, 0.5, 1] } }`

Notes:

- `offset` and `interpolation` are normalized to `[0, 1]`
- `radius` and `noise` are clamped to `>= 0`
- tint colors are clamped into `[0, 1]` and tint amount is clamped to `>= 0`
- curves use CSS-compatible control points `[x1, y1, x2, y2]`, so values from common online easing generators can be pasted directly as numbers
- when both `radius` and `noise` are effectively zero, `wlur` becomes a copy pass

## Curve Presets

`wlur` exports CSS-style presets through `WLUR_CURVES`:

- `linear`
- `ease`
- `easeIn`
- `easeOut`
- `easeInOut`
- `overlayQuickFade`
- `overlayEdgeHold`

The overlay presets are tuned for fullscreen bottom overlays:

- `overlayQuickFade` concentrates more strength near the edge and fades faster through the ramp
- `overlayEdgeHold` keeps the strong edge around longer before fading

Example:

```ts
import { WLUR_CURVES } from "#wlur";

const params = {
  radius: 20,
  curve: WLUR_CURVES.overlayQuickFade,
  offset: 0.75,
  interpolation: 0.25,
  direction: "down",
  noise: 0,
  tint: {
    color: [1, 1, 1],
    amount: 1,
    curve: WLUR_CURVES.overlayEdgeHold,
  },
};
```

## Quality Controls

`WlurQuality` exposes implementation-oriented tuning:

- `kernelSize`: odd Gaussian kernel size, clamped to `3..127`
- `resolutionScale`: internal working resolution, clamped to `0.1..1`

Guidelines:

- use `kernelSize: 63` for a strong default
- reduce `resolutionScale` for large fullscreen passes
- keep `resolutionScale: 1` for smaller or detail-sensitive entity passes

The pass caches scratch textures by input size and effective scaled size.

## Basic Usage

```ts
import { WlurPass, DEFAULT_WLUR_PARAMS } from "#wlur";

const wlur = new WlurPass({
  device,
  format: "rgba16float",
  quality: {
    kernelSize: 63,
    resolutionScale: 0.75,
  },
});

wlur.initialize();

const encoder = device.createCommandEncoder();

wlur.encode(encoder, inputTexture, outputTexture, width, height, {
  ...DEFAULT_WLUR_PARAMS,
  radius: 14,
  curve: [0.55, 0, 1, 0.45],
  offset: 0.75,
  interpolation: 0.25,
  direction: "down",
  noise: 0.08,
  tint: {
    color: [1, 1, 1],
    amount: 0.18,
    curve: [0.28, 0.78, 0.5, 1],
  },
});

device.queue.submit([encoder.finish()]);
```

## Reconfiguring a Long-Lived Pass

`WlurPass` is designed to be created once and reused.

```ts
wlur.updateConfig({
  quality: {
    kernelSize: 95,
    resolutionScale: 0.5,
  },
});
```

Behavior:

- changing `kernelSize` rebuilds the blur pipelines
- changing `resolutionScale` invalidates cached scratch textures

## Current Voidmesh Integration

The current app-level overlay resolver lives in [wlur-overlay.ts](/Users/danielwargh/.codex/worktrees/5e09/voidmesh/renderer/wlur-overlay.ts).

That file is intentionally outside the package because it contains app-specific decisions:

- mobile vs desktop defaults
- visible viewport handling
- bottom inset handling for mobile UI chrome
- cache policy defaults for the fullscreen overlay

Current defaults:

- mobile: `offset=0.75`, `interpolation=0.25`, `resolutionScale=0.5`
- desktop: `offset=0.90`, `interpolation=0.10`, `resolutionScale=0.75`
- tint is app-owned; Voidmesh currently passes white for light mode and black for dark mode

These are scaled against the visible viewport height rather than the raw canvas height.

## Using It For Fullscreen Overlay

The current renderer integration uses this pattern:

1. render the scene into the canvas
2. copy the current result into an intermediate texture
3. run `wlur.encode(...)`
4. blit the `wlur` output back to the presentation target
5. continue rendering sharp overlays above it

This is the right shape when `wlur` should affect the composed scene but not UI-like overlays rendered afterward.

## Using It On Entities

`wlur` is not coupled to `ShaderType` or entity-specific types.

That means entity integration should be straightforward:

1. produce or reuse an entity-sized source texture
2. allocate an entity-sized output texture
3. call `wlur.encode(...)`
4. continue through the rest of the entity pipeline

In practice, the likely insertion point is alongside other texture-stage operations in [canvas-renderer.ts](/Users/danielwargh/.codex/worktrees/5e09/voidmesh/renderer/canvas-renderer.ts), before the final composition step.

## Helper Exports

`wlur` also exports helper utilities used by tests and adapters:

- `clampWlurParams()`
- `clampWlurQuality()`
- `normalizeWlurKernelSize()`
- `mapWlurFactorAtPoint()`
- `getWlurWorkingDimensions()`
- `getWlurScratchKey()`
- `wlurDirectionToIndex()`

These are useful for:

- config sanitization
- viewport-level preset resolution
- testing falloff behavior without running WebGPU

## Lifecycle

- call `initialize()` once before first use, or let `encode()` initialize lazily
- reuse a single `WlurPass` instance where possible
- call `destroy()` when the owning renderer or subsystem is torn down

## Caveats

- `wlur` assumes float-sampleable textures compatible with the chosen target format
- the current implementation uses render passes, not compute passes
- noise is composited after blur, not baked into the blur weights
- this is an internal package and the API may still evolve as entity integration lands
