# wlur

`wlur` is an internal WebGPU pass for directional progressive blur.

It works on arbitrary `GPUTexture` inputs and outputs, and is designed to be reused across frames.

## What It Supports

- directional blur from any edge: `down`, `up`, `right`, `left`
- CSS-style cubic-bezier curves for blur falloff, compositing, and tint
- optional tint over the blurred region
- optional post-blur noise
- quality tuning with kernel size and internal render scale

## Main API

```ts
import { DEFAULT_WLUR_PARAMS, WLUR_CURVES, WlurPass } from "#wlur";
```

`WlurPass` is the main entry point:

- `initialize()` creates pipelines and shared GPU resources
- `updateConfig({ quality })` updates kernel size or render scale
- `encode(...)` appends the effect to an existing `GPUCommandEncoder`
- `destroy()` releases GPU resources

`encode(...)` takes:

- `inputTexture`
- `outputTexture`
- `width` / `height`
- `params`

The pass shape is:

1. optional downscale copy
2. horizontal blur
3. vertical blur
4. composite back over the original
5. optional noise pass

## Params

`WlurParams` controls the effect:

- `radius`: max blur radius, clamped to `>= 0`
- `curve`: blur falloff curve
- `mixCurve`: final composite curve; defaults to `curve`
- `offset`: normalized start point in `0..1`
- `interpolation`: normalized ramp distance in `0..1`
- `direction`: `down | up | right | left`
- `noise`: post-blur noise strength, clamped to `>= 0`
- `tint`: optional `{ color, amount, curve }`

Curves use raw CSS-style control points: `[x1, y1, x2, y2]`.

Built-in presets are exported as `WLUR_CURVES`:

- `linear`
- `ease`
- `easeIn`
- `easeOut`
- `easeInOut`
- `overlayQuickFade`
- `overlayEdgeHold`
- `overlaySoftMix`

`WlurQuality` controls cost:

- `kernelSize`: odd integer in `3..127`
- `resolutionScale`: `0.1..1`

## Example

```ts
import { DEFAULT_WLUR_PARAMS, WLUR_CURVES, WlurPass } from "#wlur";

const wlur = new WlurPass({
  device,
  format: "rgba16float",
  quality: {
    kernelSize: 45,
    resolutionScale: 0.5,
  },
});

wlur.initialize();

const encoder = device.createCommandEncoder();

wlur.encode(encoder, inputTexture, outputTexture, width, height, {
  ...DEFAULT_WLUR_PARAMS,
  direction: "down",
  radius: 20,
  offset: 0.75,
  interpolation: 0.25,
  noise: 0,
  curve: WLUR_CURVES.overlayQuickFade,
  mixCurve: WLUR_CURVES.overlaySoftMix,
  tint: {
    color: [1, 1, 1],
    amount: 0.2,
  },
});

device.queue.submit([encoder.finish()]);
```

When `radius` and `noise` are both effectively zero, `wlur` degenerates to a copy pass.

## Helpers

The package also exports small utilities for validation and curve handling:

- `clampWlurParams`
- `clampWlurQuality`
- `getWlurWorkingDimensions`
- `mapWlurFactorAtPoint`
- `resolveWlurCurve`
- `sampleWlurCurve`
- `createWlurCurveLut`
