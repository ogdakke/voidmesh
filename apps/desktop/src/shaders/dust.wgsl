// Deletion dust (the web's renderer/disintegration-*.wgsl): a deleted entity's last image breaks
// into particles that drift off on a wind. Three entry points, each built as its own module from
// this prelude plus its section (`gfx/dust.rs`), since they bind group 0 differently:
//
//   spawn   once per deletion: place particles on opaque pixels of the snapshot, timed to the
//           dissolve front `fs_dissolve` (composite.wgsl) sweeps across it
//   update  each frame: wind, turbulence, fade and shrink
//   vs/fs   draw the live particles as soft dots

struct Particle {
  position: vec2f,
  velocity: vec2f,
  color: vec4f,   // the snapshot's texel: sRGB-encoded, premultiplied
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

// Must match composite.wgsl's, so particles leave as the dissolve front passes.
fn hash21(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453);
}

fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbmNoise(p: vec2f) -> f32 {
  var value = 0.0;
  var amp = 0.5;
  var pos = p;
  for (var i = 0; i < 3; i++) {
    value += amp * valueNoise(pos);
    pos *= 2.0;
    amp *= 0.5;
  }
  return value;
}

//@ spawn

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> particles: array<Particle>;

fn pcgHash(input: u32) -> u32 {
  let state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn randomFloat(idx: u32, offset: u32) -> f32 {
  return f32(pcgHash(idx * 16807u + offset)) / 4294967295.0;
}

@compute @workgroup_size(64)
fn spawn(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.particleCount) { return; }
  let seedU = u32(params.seed * 1000.0);

  // Up to four tries for an opaque pixel.
  var uv = vec2f(randomFloat(idx, seedU + 0u), randomFloat(idx, seedU + 1u));
  let dims = textureDimensions(sourceTexture);
  var color = vec4f(0.0);
  var found = false;
  for (var attempt = 0u; attempt < 4u; attempt++) {
    if (attempt > 0u) {
      uv = vec2f(randomFloat(idx, seedU + attempt * 2u + 100u), randomFloat(idx, seedU + attempt * 2u + 101u));
    }
    let x = clamp(u32(uv.x * f32(dims.x)), 0u, dims.x - 1u);
    let y = clamp(u32(uv.y * f32(dims.y)), 0u, dims.y - 1u);
    color = textureLoad(sourceTexture, vec2u(x, y), 0);
    if (color.a >= 0.1) {
      found = true;
      break;
    }
  }
  if (!found) {
    particles[idx].life = 0.0;
    particles[idx].size = 0.0;
    return;
  }

  let local = uv * params.entitySize;
  let center = params.entitySize * 0.5;
  let c = local - center;
  let rotated = vec2f(c.x * params.cosR - c.y * params.sinR, c.x * params.sinR + c.y * params.cosR);
  let worldPos = rotated + center + params.entityPosition;

  // When the dissolve front reaches this pixel: invert easeOutExpo(t / duration) * 1.25.
  let noiseVal = fbmNoise(uv * 5.0 + vec2f(params.seed, params.seed * 0.7));
  let gradient = uv.x * 0.8 + uv.y * 0.2;
  let threshold = mix(noiseVal, gradient, 0.35);
  let nt = clamp(threshold / 1.25, 0.0, 0.9999);
  let dissolveTime = -log2(1.0 - nt) / 10.0 * params.duration;
  let stagger = randomFloat(idx, seedU + 70u) * params.particleLifetime * 0.3;
  let spawnDelay = max(dissolveTime + stagger - 0.2, 0.0);

  let windDir = normalize(vec2f(params.windX, params.windY));
  let angle = randomFloat(idx, seedU + 50u) * 6.283185;
  let velocity = windDir * params.windStrength * (0.5 + randomFloat(idx, seedU + 51u))
               + vec2f(cos(angle), sin(angle)) * params.scatterStrength;

  particles[idx].position = worldPos;
  particles[idx].velocity = velocity;
  particles[idx].color = color;
  particles[idx].life = 1.0;
  particles[idx].size = params.particleSize * (0.3 + randomFloat(idx, seedU + 60u));
  particles[idx].spawnDelay = spawnDelay;
}

//@ update

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;

@compute @workgroup_size(64)
fn update(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.particleCount) { return; }
  var p = particles[idx];
  if (p.life <= 0.0 || params.elapsed < p.spawnDelay) { return; }
  let age = (params.elapsed - p.spawnDelay) / params.particleLifetime;
  if (age >= 1.0) {
    particles[idx].life = 0.0;
    return;
  }
  let dt = params.dt;
  p.position += p.velocity * dt;
  let windDir = normalize(vec2f(params.windX, params.windY));
  p.velocity += windDir * params.windAccel * dt;
  let freq = 3.0;
  let turbX = sin(params.elapsed * freq + p.position.y * 0.01 + f32(idx) * 0.1) * params.turbulence;
  let turbY = cos(params.elapsed * freq * 0.7 + p.position.x * 0.01 + f32(idx) * 0.13) * params.turbulence;
  p.velocity += vec2f(turbX, turbY) * dt;
  p.life = 1.0 - age;
  p.size = max(p.size * (1.0 - dt * params.shrinkRate), 0.0);
  particles[idx] = p;
}

//@ render

// World to this pass's pixels: `px = world * k + offset`, in a pass `size` pixels big.
struct View {
  k: f32,
  srgb: f32,   // 1: the frame blends in sRGB (no conversion)
  _pad: vec2f,
  offset: vec2f,
  size: vec2f,
}

var<immediate> view: View;

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> params: Params;

struct V {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
  @location(1) life: f32,
  @location(2) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> V {
  let p = particles[ii];
  var o: V;
  if (p.life <= 0.0 || params.elapsed < p.spawnDelay) {
    o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
    o.color = vec4f(0.0);
    o.life = 0.0;
    o.uv = vec2f(0.0);
    return o;
  }
  var corners = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = corners[vi];
  let world = p.position + (c - 0.5) * p.size;
  let px = world * view.k + view.offset;
  o.pos = vec4f(px.x / view.size.x * 2.0 - 1.0, 1.0 - px.y / view.size.y * 2.0, 0.0, 1.0);
  o.color = p.color;
  o.life = p.life;
  o.uv = c;
  return o;
}

fn to_linear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

@fragment
fn fs(in: V) -> @location(0) vec4f {
  let dist = length(in.uv - 0.5) * 2.0;
  let alpha = smoothstep(1.0, 0.5, dist) * in.life;
  if (alpha < 0.01) { discard; }
  var c = in.color;
  if (view.srgb == 0.0 && c.a > 0.0) {
    c = vec4f(to_linear(c.rgb / c.a) * c.a, c.a);
  }
  // Premultiplied out.
  return c * alpha;
}
