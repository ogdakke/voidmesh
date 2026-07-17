// Full-screen copy pass: samples rgba16float source, outputs to rgba8unorm target.
// Used by the export pipeline to convert 16-bit intermediates to 8-bit for readback.

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Full-screen triangle
  let uv = vec2f(f32((vertexIndex << 1u) & 2u), f32(vertexIndex & 2u));
  var out: VertexOutput;
  out.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(uv.x, 1.0 - uv.y);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, in.uv);
}
