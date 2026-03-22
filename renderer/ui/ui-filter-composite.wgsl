struct ViewportUniforms {
  matrix_row0: vec4f,
  matrix_row1: vec4f,
  matrix_row2: vec4f,
  resolution: vec2f,
  zoom: f32,
  _padding: f32,
}

struct CompositeUniforms {
  rect: vec4f,
  params: vec4f, // x: clipRadius, y: clipEnabled, z/w unused
}

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;
@group(0) @binding(1) var<uniform> composite: CompositeUniforms;
@group(0) @binding(2) var sourceTexture: texture_2d<f32>;
@group(0) @binding(3) var sourceSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) localUV: vec2f,
  @location(1) worldSize: vec2f,
}

const QUAD_POSITIONS = array<vec2f, 6>(
  vec2f(0.0, 0.0),
  vec2f(1.0, 0.0),
  vec2f(0.0, 1.0),
  vec2f(1.0, 0.0),
  vec2f(1.0, 1.0),
  vec2f(0.0, 1.0),
);

fn sdRoundedBox(p: vec2f, halfSize: vec2f, radius: f32) -> f32 {
  let r = min(radius, min(halfSize.x, halfSize.y));
  let q = abs(p) - halfSize + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let uv = QUAD_POSITIONS[vertexIndex];
  let worldPos = vec2f(
    composite.rect.x + uv.x * composite.rect.z,
    composite.rect.y + uv.y * composite.rect.w,
  );

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
  out.worldSize = composite.rect.zw;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let sampleUv = vec2f(
    in.position.x / viewport.resolution.x,
    in.position.y / viewport.resolution.y,
  );
  let sampled = textureSample(sourceTexture, sourceSampler, sampleUv);

  if (composite.params.y < 0.5) {
    return sampled;
  }

  let p = (in.localUV - 0.5) * in.worldSize;
  let halfSize = in.worldSize * 0.5;
  let dist = sdRoundedBox(p, halfSize, composite.params.x);
  let pixelSize = 1.0 / viewport.zoom;
  let aa = smoothstep(0.0, -pixelSize, dist);
  if (aa <= 0.0) {
    discard;
  }

  return sampled * aa;
}
