// Composition shader for rendering entity textured quads on the infinite canvas
// Takes entity textures and composites them with viewport transform applied

struct ViewportUniforms {
  // 3x3 matrix stored as 3x vec4f (padded for alignment)
  // Transforms from world coordinates to clip space
  matrix_row0: vec4f,
  matrix_row1: vec4f,
  matrix_row2: vec4f,
  resolution: vec2f,
  zoom: f32,
  _padding: f32,
}

struct EntityUniforms {
  position: vec2f,    // Entity position in world coordinates
  size: vec2f,        // Entity size in world coordinates
  rotation: f32,      // Rotation in radians
  isHovered: u32,     // 1 if entity is hovered, 0 otherwise
  isSelected: u32,    // 1 if entity is selected, 0 otherwise
  debugMode: u32,     // 1 if debug mode is enabled, 0 otherwise
  scale: f32,         // Visual drag scale (1.0 = normal, < 1.0 = shrunk)
  _pad1: f32,
  _pad2: f32,
  _pad3: f32,
}

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;
@group(0) @binding(1) var<uniform> entity: EntityUniforms;
@group(0) @binding(2) var entityTexture: texture_2d<f32>;
@group(0) @binding(3) var entitySampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) size: vec2f,
}

// Vertex shader - transforms quad vertices from entity local space to clip space
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Quad vertices in local space (0,0 to 1,1)
  var localPositions = array<vec2f, 6>(
    vec2f(0.0, 0.0),  // Triangle 1
    vec2f(1.0, 0.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 0.0),  // Triangle 2
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

  let localPos = localPositions[vertexIndex];
  let uv = uvs[vertexIndex];

  // Apply visual drag scale around entity center
  let scaledSize = entity.size * entity.scale;
  let scaleOffset = (entity.size - scaledSize) * 0.5;

  // Transform to entity space: scale by (visually scaled) size, rotate, translate
  var worldPos = localPos * scaledSize;

  // Apply rotation around scaled entity center
  let center = scaledSize * 0.5;
  let centered = worldPos - center;
  let cosR = cos(entity.rotation);
  let sinR = sin(entity.rotation);
  let rotated = vec2f(
    centered.x * cosR - centered.y * sinR,
    centered.x * sinR + centered.y * cosR
  );
  worldPos = rotated + center;

  // Translate to world position (offset keeps entity centered during scale)
  worldPos = worldPos + entity.position + scaleOffset;

  // Apply viewport transform (world to clip space)
  // Reconstruct 3x3 matrix and apply
  let m0 = viewport.matrix_row0;
  let m1 = viewport.matrix_row1;
  let m2 = viewport.matrix_row2;

  let clipPos = vec2f(
    m0.x * worldPos.x + m1.x * worldPos.y + m2.x,
    m0.y * worldPos.x + m1.y * worldPos.y + m2.y
  );

  var output: VertexOutput;
  output.position = vec4f(clipPos, 0.0, 1.0);
  output.uv = uv;
  output.size = scaledSize;
  return output;
}

// Fragment shader - samples entity texture and renders hover/selection borders
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
    // Sample texture first (uniform control flow required for textureSample)
    let textureColor = textureSample(entityTexture, entitySampler, input.uv);
    // Calculate 5 screen-pixel border in UV space (zoom-compensated)
    let border_w = 5.0;
    // 1 screen pixel = 1 / (entity_size_in_world * zoom) in UV space
    let screenPixelWidth = 1.0 / (input.size.x * viewport.zoom) * border_w;
    let screenPixelHeight = 1.0 / (input.size.y * viewport.zoom) * border_w;
    let isNearEdgeX = input.uv.x < screenPixelWidth || input.uv.x > (1.0 - screenPixelWidth);
    let isNearEdgeY = input.uv.y < screenPixelHeight || input.uv.y > (1.0 - screenPixelHeight);
    let isNearEdge = isNearEdgeX || isNearEdgeY;

    // Debug mode border (red) - highest priority
    if (entity.debugMode == 1u && isNearEdge) {
        return vec4f(1.0, 0.0, 0.0, 1.0); // Red
    }

    // Selection border (blue)
    if (entity.isSelected == 1u && isNearEdge) {
        // rgba(0.09998, 129.99, 255)
        return vec4f(0, 0.509, 1, 1.0); // Blue
    }

    // Normal texture
    return textureColor;
}
