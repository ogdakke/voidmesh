// Post-processing effects shader
// Applies grain, bloom (from pre-computed texture), and chromatic aberration per-entity

// Uniform buffer layout (64 bytes, 16-byte aligned)
struct PostProcessUniforms {
  resolution: vec2f,           // offset 0 (8 bytes)
  grain_size: f32,             // offset 8
  grain_intensity: f32,        // offset 12
  bloom_threshold: f32,        // offset 16 (used for soft threshold in downsample)
  bloom_intensity: f32,        // offset 20 (mix strength, ~0.04 is subtle)
  bloom_filter_radius: f32,    // offset 24 (UV-space radius for upsample filter)
  chromatic_offset: f32,       // offset 28
  enabled_flags: u32,          // offset 32 (bit0: grain, bit1: bloom, bit2: chromatic aberration)
  time: f32,                   // offset 36 (for animated grain)
  _pad0: f32,                  // offset 40
  _pad1: f32,                  // offset 44
  _pad2: vec4f,                // offset 48 (padding to 64 bytes)
}

// Flag bit positions
const FLAG_GRAIN: u32 = 1u;
const FLAG_BLOOM: u32 = 2u;
const FLAG_CHROMATIC: u32 = 4u;

@group(0) @binding(0) var<uniform> uniforms: PostProcessUniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;
@group(0) @binding(3) var bloomTexture: texture_2d<f32>;

// Hash function for pseudo-random noise
fn hash(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Generate film grain noise
fn grain(pixelPos: vec2f, time: f32, size: f32, intensity: f32) -> f32 {
  // Scale UV by grain size (larger size = larger grain blocks)
  var scaledUV: vec2f;
  if (size <= 1.0) {
    scaledUV = floor(pixelPos);
  } else {
    scaledUV = floor(pixelPos / size);
  }

  // Add time variation for animated grain
  let noise = hash(scaledUV + vec2f(time * 100.0, time * 73.0));

  // Center noise around 0 and scale by intensity
  return (noise - 0.5) * intensity;
}

// Chromatic aberration - offset RGB channels with radial falloff
fn chromaticAberration(uv: vec2f) -> vec3f {
  let center = vec2f(0.5);
  let toCenter = uv - center;
  let dist = length(toCenter);
  let dir = normalize(toCenter);

  // Scale offset by distance from center (max dist is ~0.707 at corners)
  // Multiply by 2.0 to normalize so edges get full effect
  let offset = uniforms.chromatic_offset / uniforms.resolution * dist * 2.0;

  // Sample each channel at different offsets
  let r = textureSample(sourceTexture, sourceSampler, uv + dir * offset).r;
  let g = textureSample(sourceTexture, sourceSampler, uv).g;
  let b = textureSample(sourceTexture, sourceSampler, uv - dir * offset).b;

  return vec3f(r, g, b);
}

// Vertex shader - generates a fullscreen triangle
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  return vec4f(positions[vertexIndex], 0.0, 1.0);
}

// Fragment shader - applies post-processing effects
@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = fragCoord.xy / uniforms.resolution;
  let flags = uniforms.enabled_flags;

  // Early exit if no effects enabled
  if (flags == 0u) {
    return textureSample(sourceTexture, sourceSampler, uv);
  }

  // Start with base color
  var color: vec3f;

  // Apply chromatic aberration first (modifies how we sample)
  if ((flags & FLAG_CHROMATIC) != 0u && uniforms.chromatic_offset > 0.0) {
    color = chromaticAberration(uv);
  } else {
    color = textureSample(sourceTexture, sourceSampler, uv).rgb;
  }

  // Apply bloom from pre-computed bloom texture (additive blend)
  // The bloom texture already contains the blurred bright areas from the
  // multi-pass downsample/upsample pipeline. We simply mix it in.
  if ((flags & FLAG_BLOOM) != 0u && uniforms.bloom_intensity > 0.0) {
    let bloomColor = textureSample(bloomTexture, sourceSampler, uv).rgb;
    // Use intensity as blend factor - physically-based bloom uses low values (~0.04)
    // but we allow higher values for artistic effect
    color = color + bloomColor * uniforms.bloom_intensity;
  }

  // Apply grain (last, adds noise on top)
  if ((flags & FLAG_GRAIN) != 0u && uniforms.grain_intensity > 0.0) {
    let grainValue = grain(fragCoord.xy, uniforms.time, uniforms.grain_size, uniforms.grain_intensity);
    color += vec3f(grainValue);
  }

  // Clamp to valid range
  color = clamp(color, vec3f(0.0), vec3f(1.0));

  // Get alpha from original texture
  let alpha = textureSample(sourceTexture, sourceSampler, uv).a;

  return vec4f(color, alpha);
}
