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
  disintProgress: f32, // Disintegration progress (0 = inactive, 0-1 = dissolving)
  disintSeed: f32,    // Per-entity random seed for noise variation
  _pad3: f32,
}

@group(0) @binding(0) var<uniform> viewport: ViewportUniforms;
@group(0) @binding(1) var<uniform> entity: EntityUniforms;
@group(0) @binding(2) var entityTexture: texture_2d<f32>;
@group(0) @binding(3) var entitySampler: sampler;

const BORDER_PX: f32 = 2.0;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) size: vec2f,
}

// --- Noise functions for disintegration ---

fn hash21(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453);
}

// Smooth value noise
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

// Fractal brownian motion — organic dissolve pattern
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

// --- End noise functions ---

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

  // Expand quad outward for outside selection/debug borders
  let border_px = BORDER_PX;
  let needsBorder = (entity.isSelected == 1u) || (entity.debugMode == 1u);
  let borderExpand = select(
    vec2f(0.0),
    vec2f(border_px / (scaledSize.x * viewport.zoom), border_px / (scaledSize.y * viewport.zoom)),
    needsBorder
  );
  let expandedLocalPos = localPos * (vec2f(1.0) + 2.0 * borderExpand) - borderExpand;
  let expandedUV = uv * (vec2f(1.0) + 2.0 * borderExpand) - borderExpand;

  // Transform to entity space: scale by (visually scaled) size, rotate, translate
  var worldPos = expandedLocalPos * scaledSize;

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
  output.uv = expandedUV;
  output.size = scaledSize;
  return output;
}

// Fragment shader - samples entity texture and renders hover/selection borders
// Also handles disintegration dissolve-to-dust effect when disintProgress > 0
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
    // Sample texture (clamp UV for expanded border region)
    let textureColor = textureSample(entityTexture, entitySampler, clamp(input.uv, vec2f(0.0), vec2f(1.0)));

    // Outside border: UV is outside [0,1] when quad is expanded for selection/debug
    let inBorder = input.uv.x < 0.0 || input.uv.x > 1.0 || input.uv.y < 0.0 || input.uv.y > 1.0;

    // --- Disintegration effect ---
    if (entity.disintProgress > 0.0) {
        if (inBorder) { discard; }
        return disintegrate(input, textureColor);
    }

    // Debug mode border (red) - highest priority
    if (entity.debugMode == 1u && inBorder) {
        return vec4f(1.0, 0.0, 0.0, 1.0); // Red
    }

    // Selection border (blue)
    if (entity.isSelected == 1u && inBorder) {
        return vec4f(59.0/255.0, 130.0/255.0, 246.0/255.0, 1.0); // #3B82F6
    }

    // Normal texture
    return textureColor;
}

// Disintegration: noise-driven dissolve with dust particle drift
fn disintegrate(input: VertexOutput, textureColor: vec4f) -> vec4f {
    let progress = entity.disintProgress;
    let seed = entity.disintSeed;
    let uv = input.uv;

    // Compute dissolve threshold: blend FBM noise with horizontal gradient
    // Gradient creates a directional sweep (left to right), noise adds organic edges
    let noiseCoord = uv * 5.0 + vec2f(seed, seed * 0.7);
    let noiseVal = fbmNoise(noiseCoord);
    let gradient = uv.x * 0.8 + uv.y * 0.2; // mostly horizontal sweep
    let threshold = mix(noiseVal, gradient, 0.35);

    // Overshoot progress to ensure complete dissolve at progress=1.0
    let dissolveEdge = progress * 1.25;

    // Solid pixel — not yet reached by dissolve wave
    if (threshold >= dissolveEdge) {
        let edgeDist = threshold - dissolveEdge;
        // Alpha fade at dissolve edge
        let edgeFade = smoothstep(0.0, 0.04, edgeDist);
        // Subtle blue tint near the edge (~rgb(0, 130, 255))
        let glow = smoothstep(0.06, 0.0, edgeDist);
        let tinted = vec3f(
            textureColor.r * (1.0 - glow * 0.1),
            mix(textureColor.g, 0.51, glow * 0.1),
            mix(textureColor.b, 1.0, glow * 0.15),
        );
        return vec4f(tinted, textureColor.a * edgeFade);
    }

    // Dissolved — particles handle this region
    discard;
    return vec4f(0.0);
}
