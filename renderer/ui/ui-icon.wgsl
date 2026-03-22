struct ViewportUniforms {
  matrix_row0: vec4f,
  matrix_row1: vec4f,
  matrix_row2: vec4f,
  resolution: vec2f,
  zoom: f32,
  _padding: f32,
}

struct IconData {
  rect: vec4f,
  tint: vec4f,
}

const MAX_ICONS: u32 = 16u;

struct IconUniforms {
  icon_count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  icons: array<IconData, MAX_ICONS>,
}

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;
@group(0) @binding(1) var<uniform> iconData: IconUniforms;
@group(0) @binding(2) var iconTexture: texture_2d<f32>;
@group(0) @binding(3) var iconSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) instanceIdx: u32,
}

const QUAD_POSITIONS = array<vec2f, 6>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0)
);

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let icon = iconData.icons[instanceIndex];
  let localPos = QUAD_POSITIONS[vertexIndex];

  let worldPos = vec2f(
    icon.rect.x + localPos.x * icon.rect.z,
    icon.rect.y + localPos.y * icon.rect.w,
  );

  let m0 = viewport.matrix_row0;
  let m1 = viewport.matrix_row1;
  let m2 = viewport.matrix_row2;
  let clipPos = vec2f(
    m0.x * worldPos.x + m1.x * worldPos.y + m2.x,
    m0.y * worldPos.x + m1.y * worldPos.y + m2.y
  );

  var output: VertexOutput;
  output.position = vec4f(clipPos, 0.0, 1.0);
  output.uv = localPos;
  output.instanceIdx = instanceIndex;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let icon = iconData.icons[input.instanceIdx];
  let texColor = textureSample(iconTexture, iconSampler, input.uv);
  return vec4f(texColor.rgb * icon.tint.rgb, texColor.a * icon.tint.a);
}
