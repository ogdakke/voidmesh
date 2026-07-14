// Instanced composition for consecutive entities sampling one regular GPU texture.

struct ViewportUniforms {
  matrix_row0: vec4f,
  matrix_row1: vec4f,
  matrix_row2: vec4f,
  resolution: vec2f,
  zoom: f32,
  _padding: f32,
}

// Eight 32-bit values, 32-byte storage-buffer stride.
struct EntityInstance {
  position: vec2f,
  size: vec2f,
  rotation: f32,
  isSelected: u32,
  debugMode: u32,
  scale: f32,
}

struct DragUniforms {
  offset: vec2f,
  scale: f32,
  _padding: f32,
}

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;
@group(0) @binding(1) var<storage, read> entities: array<EntityInstance>;
@group(0) @binding(2) var entityTexture: texture_2d<f32>;
@group(0) @binding(3) var entitySampler: sampler;
@group(0) @binding(4) var<uniform> drag: DragUniforms;

const BORDER_PX: f32 = 2.0;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) isSelected: u32,
  @location(2) @interpolate(flat) debugMode: u32,
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  var localPositions = array<vec2f, 6>(
    vec2f(0.0, 0.0),
    vec2f(1.0, 0.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 0.0),
    vec2f(1.0, 1.0),
    vec2f(0.0, 1.0)
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 0.0),
    vec2f(1.0, 0.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 0.0),
    vec2f(1.0, 1.0),
    vec2f(0.0, 1.0)
  );

  let entity = entities[instanceIndex];
  let localPos = localPositions[vertexIndex];
  let uv = uvs[vertexIndex];
  let selected = entity.isSelected == 1u;
  let hasDragTransform = drag.scale > 0.0;
  let selectedScale = select(entity.scale, drag.scale, selected && hasDragTransform);
  let selectedOffset = select(vec2f(0.0), drag.offset, selected && hasDragTransform);
  let scaledSize = entity.size * selectedScale;
  let scaleOffset = (entity.size - scaledSize) * 0.5;
  let needsBorder = entity.isSelected == 1u;
  let borderExpand = select(
    vec2f(0.0),
    vec2f(
      BORDER_PX / (scaledSize.x * viewport.zoom),
      BORDER_PX / (scaledSize.y * viewport.zoom),
    ),
    needsBorder,
  );
  let expandedLocalPos = localPos * (vec2f(1.0) + 2.0 * borderExpand) - borderExpand;
  let expandedUV = uv * (vec2f(1.0) + 2.0 * borderExpand) - borderExpand;

  var worldPos = expandedLocalPos * scaledSize;
  let center = scaledSize * 0.5;
  let centered = worldPos - center;
  let cosR = cos(entity.rotation);
  let sinR = sin(entity.rotation);
  worldPos = vec2f(
    centered.x * cosR - centered.y * sinR,
    centered.x * sinR + centered.y * cosR,
  ) + center + entity.position + selectedOffset + scaleOffset;

  let m0 = viewport.matrix_row0;
  let m1 = viewport.matrix_row1;
  let m2 = viewport.matrix_row2;
  let clipPos = vec2f(
    m0.x * worldPos.x + m1.x * worldPos.y + m2.x,
    m0.y * worldPos.x + m1.y * worldPos.y + m2.y,
  );

  var output: VertexOutput;
  output.position = vec4f(clipPos, 0.0, 1.0);
  output.uv = expandedUV;
  output.isSelected = entity.isSelected;
  output.debugMode = entity.debugMode;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let textureColor = textureSample(
    entityTexture,
    entitySampler,
    clamp(input.uv, vec2f(0.0), vec2f(1.0)),
  );
  let inBorder =
    input.uv.x < 0.0 || input.uv.x > 1.0 || input.uv.y < 0.0 || input.uv.y > 1.0;

  if (input.isSelected == 1u && inBorder) {
    if (input.debugMode == 1u) {
      return vec4f(1.0, 0.0, 0.0, 1.0);
    }
    return vec4f(59.0 / 255.0, 130.0 / 255.0, 246.0 / 255.0, 1.0);
  }

  return textureColor;
}
