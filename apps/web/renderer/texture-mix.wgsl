// Texture Mix Shader
// Linearly interpolates between two textures based on a uniform mix factor.
// Used for smooth cross-level blending in Dual Kawase blur.
//
// Uniform buffer layout (16 bytes, 16-byte aligned)
struct Uniforms {
  resolution: vec2f,  // Output resolution (offset 0)
  mix_factor: f32,    // 0.0 = texture A only, 1.0 = texture B only (offset 8)
  _pad0: f32,         // Padding (offset 12)
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var texture_a: texture_2d<f32>;
@group(0) @binding(2) var texture_b: texture_2d<f32>;
@group(0) @binding(3) var tex_sampler: sampler;

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
  let uv = frag_coord.xy / uniforms.resolution;
  let color_a = textureSample(texture_a, tex_sampler, uv);
  let color_b = textureSample(texture_b, tex_sampler, uv);
  return mix(color_a, color_b, uniforms.mix_factor);
}
