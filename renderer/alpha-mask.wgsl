// Keeps fully transparent source pixels transparent after an effect pass.

@group(0) @binding(0) var effectTexture: texture_2d<f32>;
@group(0) @binding(1) var maskTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );

  var out: VertexOutput;
  out.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  return out;
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(effectTexture));
  let uv = clamp(fragCoord.xy / dims, vec2f(0.0), vec2f(1.0));
  let effectColor = textureSample(effectTexture, texSampler, uv);
  let sourceAlpha = textureSample(maskTexture, texSampler, uv).a;
  let alpha = select(effectColor.a, 0.0, sourceAlpha <= 0.0001);

  return vec4f(effectColor.rgb, alpha);
}
