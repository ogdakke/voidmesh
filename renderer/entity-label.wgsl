// Entity label textured quad shader
// Renders a pre-rasterized label texture at a world-space position

struct ViewportUniforms {
  matrix_row0: vec4f,
  matrix_row1: vec4f,
  matrix_row2: vec4f,
  resolution: vec2f,
  zoom: f32,
  _padding: f32,
}

struct LabelUniforms {
  position: vec2f,  // Top-left in world coordinates
  size: vec2f,      // Width/height in world coordinates
  opacity: f32,
  _pad: f32,
  textureSize: vec2f,
  atlasOrigin: vec2f,
  _pad2: vec2f,
}

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;
@group(0) @binding(1) var<uniform> label: LabelUniforms;
@group(0) @binding(2) var labelTexture: texture_2d<f32>;
@group(0) @binding(3) var labelSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 6>(
    vec2f(0.0, 0.0),
    vec2f(1.0, 0.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 0.0),
    vec2f(1.0, 1.0),
    vec2f(0.0, 1.0),
  );

  let localPos = positions[vertexIndex];
  let worldPos = localPos * label.size + label.position;

  let m0 = viewport.matrix_row0;
  let m1 = viewport.matrix_row1;
  let m2 = viewport.matrix_row2;

  let clipPos = vec2f(
    m0.x * worldPos.x + m1.x * worldPos.y + m2.x,
    m0.y * worldPos.x + m1.y * worldPos.y + m2.y,
  );

  var output: VertexOutput;
  output.position = vec4f(clipPos, 0.0, 1.0);
  output.uv = localPos;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let allocationSize = vec2f(textureDimensions(labelTexture));
  let texel = clamp(
    input.uv * label.textureSize - vec2f(0.5),
    vec2f(0.0),
    label.textureSize - vec2f(1.0),
  );
  let uv = (label.atlasOrigin + texel + vec2f(0.5)) / allocationSize;
  let color = textureSample(labelTexture, labelSampler, uv);
  return color * label.opacity;
}
