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

export function createWlurBlurShaderSource(axis: "x" | "y", kernelSize: number): string {
  const halfKernel = (kernelSize - 1) / 2;
  const texelOffset =
    axis === "x"
      ? "vec2f(sample_offset / params.output_resolution.z, 0.0)"
      : "vec2f(0.0, sample_offset / params.output_resolution.w)";

  return `
struct BlurParams {
  output_resolution: vec4f,
  effect: vec4f,
  config: vec4f,
}

@group(0) @binding(0) var<uniform> params: BlurParams;
@group(0) @binding(1) var input_texture: texture_2d<f32>;
@group(0) @binding(2) var input_sampler: sampler;

${fullscreenVertex}
${mapFactor}

const KERNEL_SIZE: u32 = ${kernelSize}u;
const HALF_KERNEL: f32 = ${halfKernel}.0;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let factor = map_factor(in.uv, params.effect.y, params.effect.z, params.effect.w);
  let radius = factor * params.effect.x * params.config.x;
  let original = textureSample(input_texture, input_sampler, in.uv);
  let sigma = max(radius, 0.001);
  var accum = vec4f(0.0);
  var weight_sum = 0.0;

  for (var i: u32 = 0u; i < KERNEL_SIZE; i = i + 1u) {
    let sample_offset = f32(i) - HALF_KERNEL;
    let weight = exp(-(sample_offset * sample_offset) / (2.0 * sigma * sigma));
    let sample_uv = clamp(in.uv + ${texelOffset}, vec2f(0.0), vec2f(1.0));
    accum = accum + textureSample(input_texture, input_sampler, sample_uv) * weight;
    weight_sum = weight_sum + weight;
  }

  let blurred = accum / max(weight_sum, 0.00001);
  let use_original = select(0.0, 1.0, radius <= 0.001);
  return mix(blurred, original, use_original);
}
`;
}

export function createWlurCompositeShaderSource(): string {
  return `
struct CompositeParams {
  resolution: vec4f,
  effect: vec4f,
  tint: vec4f,
}

@group(0) @binding(0) var<uniform> params: CompositeParams;
@group(0) @binding(1) var original_texture: texture_2d<f32>;
@group(0) @binding(2) var blurred_texture: texture_2d<f32>;
@group(0) @binding(3) var tex_sampler: sampler;

${fullscreenVertex}
${mapFactor}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let original = textureSample(original_texture, tex_sampler, in.uv);
  let factor = map_factor(in.uv, params.effect.x, params.effect.y, params.effect.z);
  let blurred = textureSample(blurred_texture, tex_sampler, in.uv);
  let tint_strength = factor * params.tint.a;
  let tinted_blur = vec4f(
    mix(blurred.rgb, params.tint.rgb, tint_strength),
    blurred.a,
  );
  let threshold_blend = select(
    1.0,
    smoothstep(0.0, params.resolution.z, factor),
    params.resolution.z > 0.001,
  );
  let blend = select(0.0, threshold_blend, factor > 0.0);
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

${fullscreenVertex}
${mapFactor}

fn overlay(base: f32, blend: f32) -> f32 {
  return select(2.0 * base * blend, 1.0 - 2.0 * (1.0 - base) * (1.0 - blend), base > 0.5);
}

fn rand(st: vec2f) -> f32 {
  return fract(sin(dot(st, vec2f(12.9898, 78.233))) * 43758.5453123);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let color = textureSample(input_texture, input_sampler, in.uv);
  let factor = map_factor(in.uv, params.effect.x, params.effect.y, params.effect.z);
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
