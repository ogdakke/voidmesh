import { WLUR_CURVE_LUT_SIZE } from "./types.ts";

const fullscreenVertex = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  let uv = vec2f(f32((vertex_index << 1u) & 2u), f32(vertex_index & 2u));
  var out: VertexOutput;
  out.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(uv.x, 1.0 - uv.y);
  return out;
}
`;

const curveSampling = (samplerName: string) => `
const CURVE_LUT_SIZE: f32 = ${WLUR_CURVE_LUT_SIZE}.0;
const CURVE_TEXTURE_ROWS: f32 = 3.0;

fn sample_curve(curve_texture: texture_2d<f32>, factor: f32, row: f32) -> f32 {
  let clamped_factor = clamp(factor, 0.0, 1.0);
  let u = ((clamped_factor * (CURVE_LUT_SIZE - 1.0)) + 0.5) / CURVE_LUT_SIZE;
  let v = (row + 0.5) / CURVE_TEXTURE_ROWS;
  return textureSampleLevel(curve_texture, ${samplerName}, vec2f(u, v), 0.0).r;
}
`;

// Kawase radius doubles per level, so a linear depth ramp would grow the radius exponentially.
// Mapping the curve factor through log2 makes the radius grow linearly with it, like the
// Gaussian's radius, with levels setting the depth (and so radius) at full ramp.
const kawaseDepth = `
fn kawase_depth(factor: f32, levels: f32) -> f32 {
  return log2(1.0 + factor * (exp2(levels) - 1.0));
}
`;

const mapFactor = `
fn map_factor(uv: vec2f, offset: f32, interpolation: f32, direction: f32) -> f32 {
  if (interpolation <= 0.000001) {
    if (direction == 0.0) {
      return select(0.0, 1.0, uv.y >= offset);
    }
    if (direction == 1.0) {
      return select(0.0, 1.0, uv.y <= offset);
    }
    if (direction == 2.0) {
      return select(0.0, 1.0, uv.x >= offset);
    }
    return select(0.0, 1.0, uv.x <= offset);
  }

  var mapped = 0.0;

  if (direction == 0.0) {
    mapped = max((uv.y - offset) / interpolation, 0.0);
  } else if (direction == 1.0) {
    mapped = max(0.5 - (uv.y - offset) / interpolation, 0.0);
  } else if (direction == 2.0) {
    mapped = max((uv.x - offset) / interpolation, 0.0);
  } else {
    mapped = max(0.5 - (uv.x - offset) / interpolation, 0.0);
  }

  return min(mapped, 1.0);
}
`;

export function createWlurCopyShaderSource(): string {
  return `
@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;

${fullscreenVertex}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  return textureSample(input_texture, input_sampler, in.uv);
}
`;
}

// Blur taps are not clamped: the sampler mirrors past the texture edge, so taps beyond the
// viewport read content reflected inward instead of piling weight onto the outermost row.
export function createWlurBlurShaderSource(axis: "x" | "y", kernelSize: number): string {
  const halfKernel = (kernelSize - 1) / 2;
  const pairCount = Math.floor(halfKernel / 2);
  const hasUnpairedTap = halfKernel % 2 === 1;
  const texelOffset =
    axis === "x"
      ? "vec2f(sample_offset / params.output_resolution.z, 0.0)"
      : "vec2f(0.0, sample_offset / params.output_resolution.w)";
  const samplingBody =
    axis === "x"
      ? `
  // The horizontal source may be higher-resolution than this render target.
  // Preserve its exact sample positions; bilinear tap pairing is only exact
  // when adjacent kernel taps are also adjacent source texels.
  var accum = vec4f(0.0);
  var weight_sum = 0.0;
  for (var i: u32 = 0u; i < KERNEL_SIZE; i = i + 1u) {
    let sample_offset = f32(i) - HALF_KERNEL;
    let weight = exp(-(sample_offset * sample_offset) / (2.0 * sigma * sigma));
    let sample_uv = in.uv + ${texelOffset};
    accum = accum + textureSampleLevel(input_texture, input_sampler, sample_uv, 0.0) * weight;
    weight_sum = weight_sum + weight;
  }
`
      : `
  // Pair adjacent Gaussian taps into one bilinear lookup. The vertical source
  // and target share a texel grid, so the weighted fractional lookup exactly
  // reconstructs both samples while halving texture fetches.
  var accum = original;
  var weight_sum = 1.0;
  for (var pair: u32 = 0u; pair < PAIR_COUNT; pair = pair + 1u) {
    let first_offset = 1.0 + f32(pair * 2u);
    let second_offset = first_offset + 1.0;
    let first_weight = exp(-(first_offset * first_offset) / (2.0 * sigma * sigma));
    let second_weight = exp(-(second_offset * second_offset) / (2.0 * sigma * sigma));
    let pair_weight = first_weight + second_weight;
    let sample_offset = first_offset + second_weight / max(pair_weight, 1e-20);
    let positive_uv = in.uv + ${texelOffset};
    let negative_uv = in.uv - ${texelOffset};
    accum = accum + (
      textureSampleLevel(input_texture, input_sampler, positive_uv, 0.0) +
      textureSampleLevel(input_texture, input_sampler, negative_uv, 0.0)
    ) * pair_weight;
    weight_sum = weight_sum + 2.0 * pair_weight;
  }
  if (HAS_UNPAIRED_TAP) {
    let sample_offset = HALF_KERNEL;
    let weight = exp(-(sample_offset * sample_offset) / (2.0 * sigma * sigma));
    let positive_uv = in.uv + ${texelOffset};
    let negative_uv = in.uv - ${texelOffset};
    accum = accum + (
      textureSampleLevel(input_texture, input_sampler, positive_uv, 0.0) +
      textureSampleLevel(input_texture, input_sampler, negative_uv, 0.0)
    ) * weight;
    weight_sum = weight_sum + 2.0 * weight;
  }
`;

  return `
struct BlurParams {
  output_resolution: vec4f,
  effect: vec4f,
  config: vec4f,
}

@group(0) @binding(0) var<uniform> params: BlurParams;
@group(0) @binding(1) var input_texture: texture_2d<f32>;
@group(0) @binding(2) var input_sampler: sampler;
@group(0) @binding(3) var curve_texture: texture_2d<f32>;

${fullscreenVertex}
${mapFactor}
${curveSampling("input_sampler")}

const KERNEL_SIZE: u32 = ${kernelSize}u;
const HALF_KERNEL: f32 = ${halfKernel}.0;
const PAIR_COUNT: u32 = ${pairCount}u;
const HAS_UNPAIRED_TAP: bool = ${hasUnpairedTap};

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let raw_factor = map_factor(in.uv, params.effect.y, params.effect.z, params.effect.w);
  let original = textureSampleLevel(input_texture, input_sampler, in.uv, 0.0);

  if (raw_factor <= 0.000001 || params.effect.x <= 0.001 || params.config.x <= 0.001) {
    return original;
  }

  let factor = sample_curve(curve_texture, raw_factor, 0.0);
  let radius = factor * params.effect.x * params.config.x;
  if (radius <= 0.001) {
    return original;
  }

  let sigma = max(radius, 0.001);
${samplingBody}

  return accum / max(weight_sum, 0.00001);
}
`;
}

/**
 * Dual Kawase downsample: five bilinear taps (centre ×4, diagonals ×1) at `1 + spread` source
 * texels. Writes the next, half-resolution pyramid level.
 */
export function createWlurKawaseDownShaderSource(): string {
  return `
struct KawaseDownParams {
  // xy: unused, zw: source resolution
  resolution: vec4f,
  // x: spread
  config: vec4f,
}

@group(0) @binding(0) var<uniform> params: KawaseDownParams;
@group(0) @binding(1) var source_texture: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

${fullscreenVertex}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let half_pixel = (1.0 + params.config.x) / params.resolution.zw;
  var color = textureSampleLevel(source_texture, source_sampler, in.uv, 0.0) * 4.0;
  color += textureSampleLevel(source_texture, source_sampler, in.uv + vec2f(-half_pixel.x, -half_pixel.y), 0.0);
  color += textureSampleLevel(source_texture, source_sampler, in.uv + vec2f(half_pixel.x, -half_pixel.y), 0.0);
  color += textureSampleLevel(source_texture, source_sampler, in.uv + vec2f(-half_pixel.x, half_pixel.y), 0.0);
  color += textureSampleLevel(source_texture, source_sampler, in.uv + vec2f(half_pixel.x, half_pixel.y), 0.0);
  return color / 8.0;
}
`;
}

/**
 * Dual Kawase upsample with a variable-blur blend. Upsamples the coarser level with four
 * diagonal bilinear taps, then mixes toward this level's sharper downsample by how far the
 * ramp's target depth exceeds this level, so each pixel only accumulates the levels it needs.
 */
export function createWlurKawaseUpShaderSource(): string {
  return `
struct KawaseUpParams {
  // xy: unused, zw: coarser source resolution
  resolution: vec4f,
  // x: offset, y: interpolation, z: direction, w: this level's index (>= 1)
  effect: vec4f,
  // x: depth at full ramp, y: spread
  config: vec4f,
}

@group(0) @binding(0) var<uniform> params: KawaseUpParams;
@group(0) @binding(1) var source_texture: texture_2d<f32>;
@group(0) @binding(2) var detail_texture: texture_2d<f32>;
@group(0) @binding(3) var input_sampler: sampler;
@group(0) @binding(4) var curve_texture: texture_2d<f32>;

${fullscreenVertex}
${mapFactor}
${curveSampling("input_sampler")}
${kawaseDepth}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let detail = textureSampleLevel(detail_texture, input_sampler, in.uv, 0.0);
  let raw_factor = map_factor(in.uv, params.effect.x, params.effect.y, params.effect.z);
  let depth = kawase_depth(sample_curve(curve_texture, raw_factor, 0.0), params.config.x);
  let weight = clamp(depth - params.effect.w, 0.0, 1.0);
  if (weight <= 0.0) {
    return detail;
  }

  // sqrt(5/3) keeps the radial variance of the classic 8-tap Kawase upsample.
  let sample_offset = (1.0 + params.config.y) / params.resolution.zw * 1.2909944487;
  var color = textureSampleLevel(source_texture, input_sampler, in.uv + vec2f(-sample_offset.x, -sample_offset.y), 0.0);
  color += textureSampleLevel(source_texture, input_sampler, in.uv + vec2f(sample_offset.x, -sample_offset.y), 0.0);
  color += textureSampleLevel(source_texture, input_sampler, in.uv + vec2f(-sample_offset.x, sample_offset.y), 0.0);
  color += textureSampleLevel(source_texture, input_sampler, in.uv + vec2f(sample_offset.x, sample_offset.y), 0.0);
  return mix(detail, color * 0.25, weight);
}
`;
}

export function createWlurCompositeShaderSource(): string {
  return `
struct CompositeParams {
  resolution: vec4f,
  effect: vec4f,
  tint: vec4f,
  // x: Kawase pyramid depth at full ramp; 0 for the Gaussian path.
  kawase: vec4f,
}

@group(0) @binding(0) var<uniform> params: CompositeParams;
@group(0) @binding(1) var original_texture: texture_2d<f32>;
@group(0) @binding(2) var blurred_texture: texture_2d<f32>;
@group(0) @binding(3) var tex_sampler: sampler;
@group(0) @binding(4) var curve_texture: texture_2d<f32>;

${fullscreenVertex}
${mapFactor}
${curveSampling("tex_sampler")}
${kawaseDepth}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let original = textureSampleLevel(original_texture, tex_sampler, in.uv, 0.0);
  let raw_factor = map_factor(in.uv, params.effect.x, params.effect.y, params.effect.z);
  if (raw_factor <= 0.000001) {
    return original;
  }

  let mix_factor = sample_curve(curve_texture, raw_factor, 2.0);
  if (mix_factor <= 0.000001) {
    return original;
  }

  var blurred = textureSampleLevel(blurred_texture, tex_sampler, in.uv, 0.0);
  if (params.kawase.x > 0.0) {
    // The pyramid's finest level is half resolution; below level 1 fade from the original.
    let level = kawase_depth(sample_curve(curve_texture, raw_factor, 0.0), params.kawase.x);
    blurred = mix(original, blurred, clamp(level, 0.0, 1.0));
  }
  let tint_factor = sample_curve(curve_texture, raw_factor, 1.0);
  let tint_strength = clamp(tint_factor * params.tint.a, 0.0, 1.0);
  let tinted_blur = vec4f(
    mix(blurred.rgb, params.tint.rgb, tint_strength),
    blurred.a,
  );
  let threshold_blend = select(
    1.0,
    smoothstep(0.0, params.resolution.z, mix_factor),
    params.resolution.z > 0.001,
  );
  let blend = select(0.0, threshold_blend, mix_factor > 0.0);
  return mix(original, tinted_blur, blend);
}
`;
}

export function createWlurNoiseShaderSource(): string {
  return `
struct NoiseParams {
  resolution: vec4f,
  effect: vec4f,
}

@group(0) @binding(0) var<uniform> params: NoiseParams;
@group(0) @binding(1) var input_texture: texture_2d<f32>;
@group(0) @binding(2) var input_sampler: sampler;
@group(0) @binding(3) var curve_texture: texture_2d<f32>;

${fullscreenVertex}
${mapFactor}
${curveSampling("input_sampler")}

fn overlay(base: f32, blend: f32) -> f32 {
  return select(2.0 * base * blend, 1.0 - 2.0 * (1.0 - base) * (1.0 - blend), base > 0.5);
}

fn rand(st: vec2f) -> f32 {
  return fract(sin(dot(st, vec2f(12.9898, 78.233))) * 43758.5453123);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let color = textureSampleLevel(input_texture, input_sampler, in.uv, 0.0);
  let raw_factor = map_factor(in.uv, params.effect.x, params.effect.y, params.effect.z);
  if (raw_factor <= 0.000001) {
    return color;
  }
  let factor = sample_curve(curve_texture, raw_factor, 0.0);
  let strength = min(factor * params.resolution.z, params.resolution.z);

  if (strength <= 0.0) {
    return color;
  }

  let noise_coord = floor(in.uv * params.resolution.xy * 10.0);
  let white = rand(noise_coord) * 0.5 + 0.5;
  let next_color = vec4f(
    overlay(color.r, white),
    overlay(color.g, white),
    overlay(color.b, white),
    color.a,
  );

  return mix(color, next_color, strength);
}
`;
}
