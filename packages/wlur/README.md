# wlur

`wlur` is an internal WebGPU pass for directional progressive blur.

It works on arbitrary `GPUTexture` inputs and outputs, and is designed to be reused across frames.

## What It Supports

- directional blur from any edge: `down`, `up`, `right`, `left`
- CSS-style cubic-bezier curves for blur falloff, compositing, and tint
- optional tint over the blurred region
- optional post-blur noise
- two algorithms: a separable variable Gaussian, or a hybrid dual Kawase pyramid
- quality tuning with kernel size and internal render scale (Gaussian)

## Main API

```ts
import { DEFAULT_WLUR_PARAMS, WLUR_CURVES, WlurPass } from "#wlur";
```

`WlurPass` is the main entry point:

- `initialize()` creates pipelines and shared GPU resources
- `updateConfig({ quality })` updates kernel size, render scale or algorithm
- `encode(...)` appends the effect to an existing `GPUCommandEncoder`
- `destroy()` releases GPU resources

`encode(...)` takes:

- `inputTexture`
- `outputTexture`
- `width` / `height`
- `params`

Blur taps past the texture edge mirror back into the image, so content at the edge keeps its
normal weight instead of the outermost row being repeated.

The `gaussian` pass shape is:

1. horizontal blur (sampling the full-size source at working-resolution steps)
2. vertical blur
3. composite back over the original, with optional grain

The `kawase` pass shape is:

1. 13-tap anti-aliased downsamples to `ceil(levels)` pyramid levels
2. upsamples back to half resolution, each blending toward its level's downsample by the
   ramp's target depth `log2(1 + f × (2^levels − 1))`, so the radius grows linearly along the ramp
3. a full-resolution variable Gaussian over the band of the ramp shallower than `fineDepth + 1`
   (crossfading shallow pyramid levels turns fine patterns into alternating haze)
4. composite: fine layer below `fineDepth`, pyramid one level past it, with optional grain

The Kawase mode does not support partial refresh; a refresh rebuilds the pyramid.

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
- `levels` (Kawase): pyramid depth at full ramp, `0..8`, fractional values blend levels
- `spread` (Kawase): extra upsample tap offset, `0..4`
- `fineDepth` (Kawase): depth covered by the full-resolution Gaussian, `0..4`; `0` disables it
- `fade` (Kawase): share of the mix curve over which the original crossfades into the blur,
  `0.001..1`; small values switch abruptly and leave a hard edge on fine patterns

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

- `algorithm`: `gaussian` (default) or `kawase`
- `kernelSize` (Gaussian): odd integer in `3..127`
- `resolutionScale` (Gaussian): `0.1..1`

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

When the blur (`radius` for Gaussian, `levels` for Kawase) and `noise` are both effectively zero,
`wlur` degenerates to a copy pass.

## Helpers

The package also exports small utilities for validation and curve handling:

- `clampWlurParams`
- `clampWlurQuality`
- `getWlurWorkingDimensions`
- `getWlurSourceDependencyRegion`, `getWlurKawaseReachPx`, `getWlurFineBand`
- `mapWlurFactorAtPoint`
- `resolveWlurCurve`
- `sampleWlurCurve`
- `createWlurCurveLut`
