// Bloom Upsample Shader
// Based on Call of Duty: Advanced Warfare technique (Siggraph 2014)
//
// This shader performs progressive upsampling using a 3x3 tent filter.
// The filter radius is specified in texture coordinates, so it automatically
// scales with mip resolution (larger radius on larger mips).
//
// The shader is used with ADDITIVE BLENDING enabled:
// output = current_mip + filtered(smaller_mip)
// This progressively accumulates blur through the mip chain.

struct UpsampleUniforms {
  filter_radius: f32,   // Filter radius in UV space (e.g., 0.005)
  _pad0: f32,
  dst_resolution: vec2f, // Destination texture resolution for UV calculation
}

@group(0) @binding(0) var<uniform> uniforms: UpsampleUniforms;
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
  // Compute UV using destination resolution (passed via uniforms)
  // frag_coord is in destination texture space, so we divide by dst_resolution
  let uv = frag_coord.xy / uniforms.dst_resolution;
  
  // Filter radius in texture coordinates
  // This radius grows in pixel terms as we upsample to larger mips
  let x = uniforms.filter_radius;
  let y = uniforms.filter_radius;
  
  // 3x3 tent filter sampling pattern:
  // a - b - c
  // d - e - f
  // g - h - i
  // ('e' is the current texel center)
  
  let a = textureSample(src_texture, src_sampler, uv + vec2f(-x,  y)).rgb;
  let b = textureSample(src_texture, src_sampler, uv + vec2f( 0.0, y)).rgb;
  let c = textureSample(src_texture, src_sampler, uv + vec2f( x,  y)).rgb;
  
  let d = textureSample(src_texture, src_sampler, uv + vec2f(-x,  0.0)).rgb;
  let e = textureSample(src_texture, src_sampler, uv + vec2f( 0.0, 0.0)).rgb;
  let f = textureSample(src_texture, src_sampler, uv + vec2f( x,  0.0)).rgb;
  
  let g = textureSample(src_texture, src_sampler, uv + vec2f(-x, -y)).rgb;
  let h = textureSample(src_texture, src_sampler, uv + vec2f( 0.0, -y)).rgb;
  let i = textureSample(src_texture, src_sampler, uv + vec2f( x, -y)).rgb;
  
  // Apply 3x3 tent filter weights:
  //  1   | 1 2 1 |
  // -- x | 2 4 2 |
  // 16   | 1 2 1 |
  //
  // Center (e) gets weight 4/16
  // Edge neighbors (b,d,f,h) get weight 2/16 each
  // Corner neighbors (a,c,g,i) get weight 1/16 each
  
  var upsample = e * 4.0;
  upsample += (b + d + f + h) * 2.0;
  upsample += (a + c + g + i);
  upsample *= (1.0 / 16.0);
  
  return vec4f(upsample, 1.0);
}
