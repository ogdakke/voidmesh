// SDF-based rounded rectangle shader for UI box rendering.
// Renders up to 16 boxes per draw call using instanced rendering.
// Each box supports vertical gradient fill, optional border, and anti-aliased edges.

struct ViewportUniforms {
  matrix_row0: vec4f,
  matrix_row1: vec4f,
  matrix_row2: vec4f,
  resolution: vec2f,
  zoom: f32,
  _padding: f32,
}

struct BoxData {
  // World-space rect: x, y, width, height
  rect: vec4f,
  // Top color (RGBA, straight alpha)
  topColor: vec4f,
  // Bottom color (RGBA, straight alpha)
  bottomColor: vec4f,
  // Border color (RGBA, straight alpha)
  borderColor: vec4f,
  // x: borderRadius, y: borderWidth, z: opacity, w: unused
  params: vec4f,
}

const MAX_BOXES: u32 = 16u;

struct BoxUniforms {
  boxCount: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  boxes: array<BoxData, MAX_BOXES>,
}

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;
@group(0) @binding(1) var<uniform> boxData: BoxUniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) localUV: vec2f,
  @location(1) worldSize: vec2f,
  @location(2) @interpolate(flat) instanceIdx: u32,
}

// Quad vertices: two triangles forming a unit quad (0,0)-(1,1)
const QUAD_POSITIONS = array<vec2f, 6>(
  vec2f(0.0, 0.0),
  vec2f(1.0, 0.0),
  vec2f(0.0, 1.0),
  vec2f(1.0, 0.0),
  vec2f(1.0, 1.0),
  vec2f(0.0, 1.0),
);

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let box = boxData.boxes[instanceIndex];
  let uv = QUAD_POSITIONS[vertexIndex];

  // World-space position of the vertex
  let worldPos = vec2f(
    box.rect.x + uv.x * box.rect.z,
    box.rect.y + uv.y * box.rect.w,
  );

  // Transform to clip space using viewport matrix
  let m0 = viewport.matrix_row0;
  let m1 = viewport.matrix_row1;
  let m2 = viewport.matrix_row2;
  let clipPos = vec2f(
    m0.x * worldPos.x + m1.x * worldPos.y + m2.x,
    m0.y * worldPos.x + m1.y * worldPos.y + m2.y,
  );

  var out: VertexOutput;
  out.position = vec4f(clipPos, 0.0, 1.0);
  out.localUV = uv;
  out.worldSize = vec2f(box.rect.z, box.rect.w);
  out.instanceIdx = instanceIndex;
  return out;
}

// Signed distance function for a rounded rectangle.
// p: point relative to rect center
// halfSize: half-dimensions of the rect
// radius: corner radius
fn sdRoundedBox(p: vec2f, halfSize: vec2f, radius: f32) -> f32 {
  let r = min(radius, min(halfSize.x, halfSize.y));
  let q = abs(p) - halfSize + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let box = boxData.boxes[in.instanceIdx];
  let borderRadius = box.params.x;
  let borderWidth = box.params.y;
  let opacity = box.params.z;
  let boxSize = in.worldSize;

  // Centered coordinates: (0,0) at box center
  let p = (in.localUV - 0.5) * boxSize;
  let halfSize = boxSize * 0.5;

  // Evaluate SDF
  let dist = sdRoundedBox(p, halfSize, borderRadius);

  // Anti-aliasing: compute pixel size in world space for ~1px smooth band
  let pixelSize = 1.0 / viewport.zoom;
  let aa = smoothstep(0.0, -pixelSize, dist);

  if (aa <= 0.0) {
    discard;
  }

  // Fill color: vertical gradient from top to bottom
  let fillColor = mix(box.topColor, box.bottomColor, in.localUV.y);

  // Determine if we're in the border region
  var color: vec4f;
  if (borderWidth > 0.0) {
    let innerDist = sdRoundedBox(p, halfSize - borderWidth, max(borderRadius - borderWidth, 0.0));
    let borderMask = smoothstep(-pixelSize, 0.0, innerDist);
    color = mix(fillColor, box.borderColor, borderMask);
  } else {
    color = fillColor;
  }

  // Apply opacity and anti-aliasing
  let finalAlpha = color.a * opacity * aa;

  // Output premultiplied alpha
  return vec4f(color.rgb * finalAlpha, finalAlpha);
}
