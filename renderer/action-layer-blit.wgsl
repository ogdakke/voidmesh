// Action Layer Blit Shader
// Fullscreen triangle that samples a blurred texture and applies dimming.
// Used to composite the blurred+dimmed background for the action layer overlay.

struct Params {
  tint_amount: f32, // How much to mix toward tint color (0 = none, 1 = fully tinted)
  blend: f32,       // Blend factor (0 = show original, 1 = fully blurred+tinted)
  blur_offset: f32,
  _pad1: f32,
  tint_color: vec4f, // RGB tint color (dark mode: black, light mode: white), w unused
  resolution: vec4f, // Full-resolution output size in xy
}

@group(0) @binding(0) var src_texture: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var<uniform> params: Params;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  return vec4f(positions[vertex_index], 0.0, 1.0);
}

fn composite_blur(blurred: vec4f) -> vec4f {
  // Mix blurred content toward tint color, then alpha-blend with original canvas
  let tinted = mix(blurred.rgb, params.tint_color.rgb, params.tint_amount);
  return vec4f(tinted, params.blend);
}

@fragment
fn fs_main(@builtin(position) frag_coord: vec4f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(src_texture));
  let uv = frag_coord.xy / dims;
  return composite_blur(textureSample(src_texture, src_sampler, uv));
}

@fragment
fn fs_upsample(@builtin(position) frag_coord: vec4f) -> @location(0) vec4f {
  let uv = frag_coord.xy / params.resolution.xy;
  let src_resolution = params.resolution.xy * 0.5;
  let half_pixel = (1.0 + params.blur_offset) / src_resolution;
  var color = vec4f(0.0);

  color += textureSample(src_texture, src_sampler, uv + vec2f(-half_pixel.x, -half_pixel.y));
  color += textureSample(src_texture, src_sampler, uv + vec2f( half_pixel.x, -half_pixel.y));
  color += textureSample(src_texture, src_sampler, uv + vec2f(-half_pixel.x,  half_pixel.y));
  color += textureSample(src_texture, src_sampler, uv + vec2f( half_pixel.x,  half_pixel.y));
  color += textureSample(src_texture, src_sampler, uv + vec2f(-half_pixel.x * 2.0, 0.0)) * 2.0;
  color += textureSample(src_texture, src_sampler, uv + vec2f( half_pixel.x * 2.0, 0.0)) * 2.0;
  color += textureSample(src_texture, src_sampler, uv + vec2f(0.0, -half_pixel.y * 2.0)) * 2.0;
  color += textureSample(src_texture, src_sampler, uv + vec2f(0.0,  half_pixel.y * 2.0)) * 2.0;

  return composite_blur(color / 12.0);
}
