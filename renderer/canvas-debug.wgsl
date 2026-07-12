struct ViewportUniforms {
  matrix_row0: vec4f,
  matrix_row1: vec4f,
  matrix_row2: vec4f,
  resolution: vec2f,
  zoom: f32,
  _padding: f32,
}

struct AlphaUniforms {
  position: vec2f,
  size: vec2f,
  rotation: f32,
  cols: u32,
  rows: u32,
  _padding: u32,
}

struct SpatialInstance {
  position: vec2f,
  size: vec2f,
  level: f32,
  kind: u32,
  _padding: vec2u,
}

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;
@group(0) @binding(1) var<uniform> alpha: AlphaUniforms;
@group(0) @binding(2) var<storage, read> alphaCells: array<u32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) level: f32,
  @location(2) @interpolate(flat) kind: u32,
}

fn worldToClip(world: vec2f) -> vec4f {
  return vec4f(
    viewport.matrix_row0.x * world.x + viewport.matrix_row1.x * world.y + viewport.matrix_row2.x,
    viewport.matrix_row0.y * world.x + viewport.matrix_row1.y * world.y + viewport.matrix_row2.y,
    0.0,
    1.0,
  );
}

fn quadVertex(index: u32) -> vec2f {
  let vertices = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  return vertices[index];
}

@vertex
fn vs_alpha(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let uv = quadVertex(vertexIndex);
  let local = (uv - 0.5) * alpha.size;
  let c = cos(alpha.rotation);
  let s = sin(alpha.rotation);
  let world = alpha.position + alpha.size * 0.5 + vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
  var output: VertexOutput;
  output.position = worldToClip(world);
  output.uv = uv;
  output.level = 0.0;
  output.kind = 0u;
  return output;
}

@fragment
fn fs_alpha(input: VertexOutput) -> @location(0) vec4f {
  let grid = input.uv * vec2f(f32(alpha.cols), f32(alpha.rows));
  let cell = min(vec2u(grid), vec2u(alpha.cols - 1u, alpha.rows - 1u));
  let occupied = alphaCells[cell.y * alpha.cols + cell.x] != 0u;
  let edge = min(min(fract(grid.x), 1.0 - fract(grid.x)), min(fract(grid.y), 1.0 - fract(grid.y)));
  let lineWidth = max(fwidth(grid.x), fwidth(grid.y)) * 0.8;
  let line = 1.0 - smoothstep(lineWidth, lineWidth * 1.5, edge);
  let fill = select(vec4f(1.0, 0.18, 0.25, 0.12), vec4f(0.1, 0.95, 0.45, 0.14), occupied);
  return mix(fill, vec4f(1.0, 0.82, 0.12, 0.8), line);
}

@group(1) @binding(0) var<uniform> spatialViewport: ViewportUniforms;
@group(1) @binding(1) var<storage, read> spatialInstances: array<SpatialInstance>;

@vertex
fn vs_spatial(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let instance = spatialInstances[instanceIndex];
  let uv = quadVertex(vertexIndex);
  var output: VertexOutput;
  let world = instance.position + uv * instance.size;
  output.position = vec4f(
    spatialViewport.matrix_row0.x * world.x + spatialViewport.matrix_row1.x * world.y + spatialViewport.matrix_row2.x,
    spatialViewport.matrix_row0.y * world.x + spatialViewport.matrix_row1.y * world.y + spatialViewport.matrix_row2.y,
    0.0,
    1.0,
  );
  output.uv = uv;
  output.level = instance.level;
  output.kind = instance.kind;
  return output;
}

@fragment
fn fs_spatial(input: VertexOutput) -> @location(0) vec4f {
  let levelColor = 0.5 + 0.5 * sin(vec3f(0.0, 2.1, 4.2) + log2(max(input.level, 1.0)) * 1.7);
  if (input.kind == 1u) {
    let d = length(input.uv - 0.5);
    if (d > 0.5) { discard; }
    return vec4f(levelColor, 0.95);
  }
  let edge = min(min(input.uv.x, 1.0 - input.uv.x), min(input.uv.y, 1.0 - input.uv.y));
  let lineWidth = 1.5 / max(input.level * spatialViewport.zoom, 1.0);
  let line = 1.0 - smoothstep(lineWidth, lineWidth * 1.5, edge);
  if (line < 0.01) { discard; }
  return vec4f(levelColor, line * 0.8);
}
