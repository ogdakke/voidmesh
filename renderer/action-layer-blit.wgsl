// Action Layer Blit Shader
// Fullscreen triangle that samples a blurred texture and applies dimming.
// Used to composite the blurred+dimmed background for the action layer overlay.

struct Params {
  tint_amount: f32, // How much to mix toward tint color (0 = none, 1 = fully tinted)
  blend: f32,       // Blend factor (0 = show original, 1 = fully blurred+tinted)
  _pad0: f32,
  _pad1: f32,
  tint_color: vec4f, // RGB tint color (dark mode: black, light mode: white), w unused
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

@fragment
fn fs_main(@builtin(position) frag_coord: vec4f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(src_texture));
  let uv = frag_coord.xy / dims;
  let blurred = textureSample(src_texture, src_sampler, uv);
  // Mix blurred content toward tint color, then alpha-blend with original canvas
  let tinted = mix(blurred.rgb, params.tint_color.rgb, params.tint_amount);
  return vec4f(tinted, params.blend);
}
