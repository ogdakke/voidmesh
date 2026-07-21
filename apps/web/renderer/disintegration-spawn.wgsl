// Compute shader: initialize particles from entity snapshot texture.
// Runs once per overlay to place particles at entity pixel positions.

// KEEP IN SYNC: Particle and Params structs are duplicated in
// disintegration-update.wgsl and disintegration-render.wgsl (WGSL has no #include).
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
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> particles: array<Particle>;

// --- Noise functions (must match composition.wgsl for synchronized dissolve) ---

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

// PCG-style hash for deterministic random from index + seed
fn pcgHash(input: u32) -> u32 {
  var state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn randomFloat(idx: u32, offset: u32) -> f32 {
  return f32(pcgHash(idx * 16807u + offset)) / 4294967295.0;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.particleCount) { return; }

  let seedU = u32(params.seed * 1000.0);

  // Generate random UV — try up to 4 positions to avoid transparent pixels
  var uv = vec2f(
    randomFloat(idx, seedU + 0u),
    randomFloat(idx, seedU + 1u),
  );

  let texDims = textureDimensions(sourceTexture);
  var color = vec4f(0.0);
  var found = false;

  for (var attempt = 0u; attempt < 4u; attempt++) {
    if (attempt > 0u) {
      uv = vec2f(
        randomFloat(idx, seedU + attempt * 2u + 100u),
        randomFloat(idx, seedU + attempt * 2u + 101u),
      );
    }

    let texelX = clamp(u32(uv.x * f32(texDims.x)), 0u, texDims.x - 1u);
    let texelY = clamp(u32(uv.y * f32(texDims.y)), 0u, texDims.y - 1u);
    color = textureLoad(sourceTexture, vec2u(texelX, texelY), 0);

    if (color.a >= 0.1) {
      found = true;
      break;
    }
  }

  // Dead particle if no opaque pixel found
  if (!found) {
    particles[idx].life = 0.0;
    particles[idx].size = 0.0;
    return;
  }

  // Compute world position: local UV -> entity space -> rotate -> translate
  let localPos = uv * params.entitySize;
  let center = params.entitySize * 0.5;
  let centered = localPos - center;
  let rotated = vec2f(
    centered.x * params.cosR - centered.y * params.sinR,
    centered.x * params.sinR + centered.y * params.cosR,
  );
  let worldPos = rotated + center + params.entityPosition;

  // Compute spawn delay from dissolve threshold (synchronized with composition.wgsl)
  let noiseCoord = uv * 5.0 + vec2f(params.seed, params.seed * 0.7);
  let noiseVal = fbmNoise(noiseCoord);
  let gradient = uv.x * 0.8 + uv.y * 0.2;
  let threshold = mix(noiseVal, gradient, 0.35);
  // Invert easeOutExpo to find exact time when dissolve front reaches this threshold.
  // Composition uses: dissolveEdge = easeOutExpo(t/duration) * 1.25
  // easeOutExpo(x) = 1 - 2^(-10x), so t = -duration * log2(1 - threshold/1.25) / 10
  let nt = clamp(threshold / 1.25, 0.0, 0.9999);
  let dissolveTime = -log2(1.0 - nt) / 10.0 * params.duration;
  // Per-particle random stagger so they don't all pop in at the same instant
  let stagger = randomFloat(idx, seedU + 70u) * params.particleLifetime * 0.3;
  let spawnDelay = max(dissolveTime + stagger - 0.2, 0.0);

  // Random velocity: wind + scatter
  let windDir = normalize(vec2f(params.windX, params.windY));
  let scatterAngle = randomFloat(idx, seedU + 50u) * 6.283185;
  let scatterDir = vec2f(cos(scatterAngle), sin(scatterAngle));
  let velocity = windDir * params.windStrength * (0.5 + randomFloat(idx, seedU + 51u))
               + scatterDir * params.scatterStrength;

  // Random initial size scaled to entity
  let baseSize = params.particleSize * (0.3 + randomFloat(idx, seedU + 60u) * 1.0);

  // Write particle
  particles[idx].position = worldPos;
  particles[idx].velocity = velocity;
  particles[idx].color = color;
  particles[idx].life = 1.0;
  particles[idx].size = baseSize;
  particles[idx].spawnDelay = spawnDelay;
}
