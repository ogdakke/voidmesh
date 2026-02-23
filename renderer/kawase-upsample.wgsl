// Dual Kawase Upsample Shader
// 8-tap bilinear filter to reconstruct image at double resolution.
// Used with standard (non-additive) blending since this produces a
// pure blur, not an additive accumulation like bloom.
//
// Uniform buffer layout (16 bytes, 16-byte aligned)
struct Uniforms {
  dst_resolution: vec2f,  // Destination texture resolution (offset 0)
  offset: f32,            // Per-pass offset for fine blur tuning (offset 8)
  _pad0: f32,             // Padding (offset 12)
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var src_texture: texture_2d<f32>;
@group(0) @binding(2) var src_sampler: sampler;

// Vertex shader - fullscreen triangle
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  return vec4f(positions[vertex_index], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) frag_coord: vec4f) -> @location(0) vec4f {
  let uv = frag_coord.xy / uniforms.dst_resolution;
  // Source is at half resolution
  let src_resolution = uniforms.dst_resolution * 0.5;
  let half_pixel = (1.0 + uniforms.offset) / src_resolution;

  // 8-tap upsample kernel:
  // 4 diagonal neighbors at +-1 texel offset: weight 1/12 each (total 4/12)
  // 4 axis-aligned neighbors at +-2 texel offset: weight 2/12 each (total 8/12)
  var color = vec4f(0.0);

  // Diagonal samples (weight 1)
  color += textureSample(src_texture, src_sampler, uv + vec2f(-half_pixel.x, -half_pixel.y));
  color += textureSample(src_texture, src_sampler, uv + vec2f( half_pixel.x, -half_pixel.y));
  color += textureSample(src_texture, src_sampler, uv + vec2f(-half_pixel.x,  half_pixel.y));
  color += textureSample(src_texture, src_sampler, uv + vec2f( half_pixel.x,  half_pixel.y));

  // Axis-aligned samples (weight 2)
  color += textureSample(src_texture, src_sampler, uv + vec2f(-half_pixel.x * 2.0, 0.0)) * 2.0;
  color += textureSample(src_texture, src_sampler, uv + vec2f( half_pixel.x * 2.0, 0.0)) * 2.0;
  color += textureSample(src_texture, src_sampler, uv + vec2f(0.0, -half_pixel.y * 2.0)) * 2.0;
  color += textureSample(src_texture, src_sampler, uv + vec2f(0.0,  half_pixel.y * 2.0)) * 2.0;

  return color / 12.0;
}
