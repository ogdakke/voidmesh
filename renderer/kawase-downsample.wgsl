// Dual Kawase Downsample Shader
// 5-tap bilinear filter at half-texel diagonal offsets.
// Each pass halves the resolution, spreading blur exponentially.
//
// Uniform buffer layout (16 bytes, 16-byte aligned)
struct Uniforms {
  src_resolution: vec2f,  // Source texture resolution (offset 0)
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
  // UV at the destination pixel center, mapped to source coordinates
  // *2 because destination is at half resolution
  let uv = frag_coord.xy / (uniforms.src_resolution * 0.5);
  let half_pixel = (1.0 + uniforms.offset) / uniforms.src_resolution;

  // 5-tap downsample kernel:
  // Center: weight 4/8
  // Four diagonals at +-half_pixel: weight 1/8 each
  var color = textureSample(src_texture, src_sampler, uv) * 4.0;
  color += textureSample(src_texture, src_sampler, uv + vec2f(-half_pixel.x, -half_pixel.y));
  color += textureSample(src_texture, src_sampler, uv + vec2f( half_pixel.x, -half_pixel.y));
  color += textureSample(src_texture, src_sampler, uv + vec2f(-half_pixel.x,  half_pixel.y));
  color += textureSample(src_texture, src_sampler, uv + vec2f( half_pixel.x,  half_pixel.y));

  return color / 8.0;
}
