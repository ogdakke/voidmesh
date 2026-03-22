struct ViewportUniforms {
  matrix_row0: vec4f,
  matrix_row1: vec4f,
  matrix_row2: vec4f,
  resolution: vec2f,
  zoom: f32,
  _padding: f32,
}

struct SegmentData {
  startEnd: vec4f,
  color: vec4f,
  params: vec4f,
}

const MAX_SEGMENTS: u32 = 64u;
const CAP_BUTT: f32 = 0.0;
const CAP_ROUND: f32 = 1.0;
const CAP_SQUARE: f32 = 2.0;

struct SegmentUniforms {
  segmentCount: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  segments: array<SegmentData, MAX_SEGMENTS>,
}

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;
@group(0) @binding(1) var<uniform> segmentData: SegmentUniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec2f,
  @location(1) @interpolate(flat) instanceIdx: u32,
}

const QUAD_POSITIONS = array<vec2f, 6>(
  vec2f(0.0, 0.0),
  vec2f(1.0, 0.0),
  vec2f(0.0, 1.0),
  vec2f(1.0, 0.0),
  vec2f(1.0, 1.0),
  vec2f(0.0, 1.0),
);

fn sdBox(p: vec2f, halfSize: vec2f) -> f32 {
  let q = abs(p) - halfSize;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let segment = segmentData.segments[instanceIndex];
  let start = segment.startEnd.xy;
  let end = segment.startEnd.zw;
  let halfWidth = segment.params.x;

  let minPos = min(start, end) - vec2f(halfWidth, halfWidth);
  let maxPos = max(start, end) + vec2f(halfWidth, halfWidth);
  let uv = QUAD_POSITIONS[vertexIndex];
  let worldPos = minPos + (maxPos - minPos) * uv;

  let m0 = viewport.matrix_row0;
  let m1 = viewport.matrix_row1;
  let m2 = viewport.matrix_row2;
  let clipPos = vec2f(
    m0.x * worldPos.x + m1.x * worldPos.y + m2.x,
    m0.y * worldPos.x + m1.y * worldPos.y + m2.y,
  );

  var out: VertexOutput;
  out.position = vec4f(clipPos, 0.0, 1.0);
  out.worldPos = worldPos;
  out.instanceIdx = instanceIndex;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let segment = segmentData.segments[input.instanceIdx];
  let start = segment.startEnd.xy;
  let end = segment.startEnd.zw;
  let color = segment.color;
  let halfWidth = segment.params.x;
  let startCap = segment.params.y;
  let endCap = segment.params.z;

  let segmentDelta = end - start;
  let segmentLength = max(length(segmentDelta), 0.0001);
  let tangent = segmentDelta / segmentLength;
  let normal = vec2f(-tangent.y, tangent.x);
  let relative = input.worldPos - start;
  let local = vec2f(dot(relative, tangent), dot(relative, normal));

  var dist = sdBox(local - vec2f(segmentLength * 0.5, 0.0), vec2f(segmentLength * 0.5, halfWidth));

  if (startCap == CAP_ROUND) {
    dist = min(dist, length(local) - halfWidth);
  } else if (startCap == CAP_SQUARE) {
    dist = min(
      dist,
      sdBox(local - vec2f(-halfWidth * 0.5, 0.0), vec2f(halfWidth * 0.5, halfWidth)),
    );
  }

  let endLocal = local - vec2f(segmentLength, 0.0);
  if (endCap == CAP_ROUND) {
    dist = min(dist, length(endLocal) - halfWidth);
  } else if (endCap == CAP_SQUARE) {
    dist = min(
      dist,
      sdBox(local - vec2f(segmentLength + halfWidth * 0.5, 0.0), vec2f(halfWidth * 0.5, halfWidth)),
    );
  }

  let pixelSize = 1.0 / viewport.zoom;
  let aa = smoothstep(0.0, -pixelSize, dist);
  if (aa <= 0.0) {
    discard;
  }

  let alpha = color.a * aa;
  return vec4f(color.rgb * alpha, alpha);
}
