// Vertex + fragment shader: instanced rendering of dust particles as soft circles.
// Each instance reads from the particle storage buffer.

struct ViewportUniforms {
  matrix_row0: vec4f,
  matrix_row1: vec4f,
  matrix_row2: vec4f,
  resolution: vec2f,
  zoom: f32,
  _padding: f32,
}

struct Particle {
  position: vec2f,
  velocity: vec2f,
  color: vec4f,
  life: f32,
  size: f32,
  spawnDelay: f32,
  _pad: f32,
}

struct Params {
  entityPosition: vec2f,
  entitySize: vec2f,
  seed: f32,
  particleCount: u32,
  duration: f32,
  particleLifetime: f32,
  windX: f32,
  windY: f32,
  windStrength: f32,
  scatterStrength: f32,
  particleSize: f32,
  turbulence: f32,
  shrinkRate: f32,
  cosR: f32,
  sinR: f32,
  elapsed: f32,
  dt: f32,
  windAccel: f32,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<uniform> params: Params;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) life: f32,
  @location(2) uv: vec2f,
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let p = particles[instanceIndex];

  var output: VertexOutput;

  // Cull dead or unspawned particles (degenerate triangle behind clip plane)
  if (p.life <= 0.0 || params.elapsed < p.spawnDelay) {
    output.position = vec4f(0.0, 0.0, -2.0, 1.0);
    output.color = vec4f(0.0);
    output.life = 0.0;
    output.uv = vec2f(0.0);
    return output;
  }

  // Quad vertices (2 triangles, 6 vertices)
  var quadOffsets = array<vec2f, 6>(
    vec2f(-0.5, -0.5),
    vec2f( 0.5, -0.5),
    vec2f(-0.5,  0.5),
    vec2f( 0.5, -0.5),
    vec2f( 0.5,  0.5),
    vec2f(-0.5,  0.5),
  );

  var quadUVs = array<vec2f, 6>(
    vec2f(0.0, 0.0),
    vec2f(1.0, 0.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 0.0),
    vec2f(1.0, 1.0),
    vec2f(0.0, 1.0),
  );

  let offset = quadOffsets[vertexIndex] * p.size;
  let worldPos = p.position + offset;

  // Viewport transform (same as composition.wgsl)
  let m0 = viewport.matrix_row0;
  let m1 = viewport.matrix_row1;
  let m2 = viewport.matrix_row2;
  let clipPos = vec2f(
    m0.x * worldPos.x + m1.x * worldPos.y + m2.x,
    m0.y * worldPos.x + m1.y * worldPos.y + m2.y,
  );

  output.position = vec4f(clipPos, 0.0, 1.0);
  output.color = p.color;
  output.life = p.life;
  output.uv = quadUVs[vertexIndex];
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  // Soft circle SDF
  let dist = length(input.uv - 0.5) * 2.0;
  var alpha = smoothstep(1.0, 0.5, dist);

  // Fade with life
  alpha *= input.life;

  if (alpha < 0.01) {
    discard;
  }

  // Slight warm tint on dying particles
  let warmth = (1.0 - input.life) * 0.15;
  var color = input.color;
  color = vec4f(
    min(color.r + warmth, 1.0),
    color.g,
    max(color.b - warmth * 0.5, 0.0),
    color.a * alpha,
  );

  return color;
}
