// Compute shader: advance particle physics each frame.
// Applies velocity, wind acceleration, turbulence, fade, and shrink.

// KEEP IN SYNC: Particle and Params structs are duplicated in
// disintegration-spawn.wgsl and disintegration-render.wgsl (WGSL has no #include).
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

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.particleCount) { return; }

  var p = particles[idx];

  // Skip dead particles
  if (p.life <= 0.0) { return; }

  // Skip particles that haven't spawned yet
  if (params.elapsed < p.spawnDelay) { return; }

  // Compute age as fraction of particle lifetime
  let age = (params.elapsed - p.spawnDelay) / params.particleLifetime;

  // Kill particle if lifetime exceeded
  if (age >= 1.0) {
    particles[idx].life = 0.0;
    return;
  }

  let dt = params.dt;

  // Apply velocity
  p.position += p.velocity * dt;

  // Wind acceleration
  let windDir = normalize(vec2f(params.windX, params.windY));
  p.velocity += windDir * params.windAccel * dt;

  // Turbulence: cheap sin/cos-based per-particle variation
  let freq = 3.0;
  let turbX = sin(params.elapsed * freq + p.position.y * 0.01 + f32(idx) * 0.1) * params.turbulence;
  let turbY = cos(params.elapsed * freq * 0.7 + p.position.x * 0.01 + f32(idx) * 0.13) * params.turbulence;
  p.velocity += vec2f(turbX, turbY) * dt;

  // Update life
  p.life = 1.0 - age;

  // Shrink
  p.size = max(p.size * (1.0 - dt * params.shrinkRate), 0.0);

  // Write back
  particles[idx] = p;
}
