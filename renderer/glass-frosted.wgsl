// Frosted glass shader - simulates textured/hammered privacy glass
// Voronoi cells with per-cell convex dome lens distortion, frost scatter, and edge highlights
// Uniform buffer layout (336 bytes, 16-byte aligned) - shared with other shaders
struct Uniforms {
  resolution: vec2f,       // Canvas dimensions (offset 0)
  scale: f32,              // Lens dome curvature depth 0.1-3.0 (offset 8)
  intensity: f32,          // Refraction displacement strength 0-5 (offset 12)
  cellSize: f32,           // Voronoi cell size in pixels (offset 16)
  highlight: f32,          // Edge highlight strength 0-1 (offset 20)
  dispersion: f32,         // Chromatic channel separation 0-1 (offset 24)
  frostiness: f32,         // Frost scatter radius 0-1 (offset 28)
  color: vec4f,            // Unused (offset 32)
  background: vec4f,       // Unused (offset 48)
  paletteCount: u32,       // Unused (offset 64)
  _pad0: u32,
  is_p3: u32,
  hasDepth: u32,
  palette: array<vec4f, 16>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;
@group(0) @binding(3) var depthTexture: texture_2d<f32>;
@group(0) @binding(4) var depthSampler: sampler;

// --- Voronoi helpers ---

// Hash function for cell jitter (2D -> 2D, returns values in -1..1)
fn hash2(p: vec2f) -> vec2f {
  let k = vec2f(
    dot(p, vec2f(127.1, 311.7)),
    dot(p, vec2f(269.5, 183.3))
  );
  return fract(sin(k) * 43758.5453) * 2.0 - 1.0;
}

// Compute Voronoi distances: returns vec2(d1, d2)
// d1 = distance to nearest cell center, d2 = distance to second nearest
// Writes nearest cell center position to the output pointer
fn voronoiDistances(pos: vec2f, cellSz: f32, nearestCenter: ptr<function, vec2f>) -> vec2f {
  let cell = floor(pos / cellSz);
  var d1 = 1e10;
  var d2 = 1e10;

  for (var dy: i32 = -1; dy <= 1; dy++) {
    for (var dx: i32 = -1; dx <= 1; dx++) {
      let neighbor = cell + vec2f(f32(dx), f32(dy));
      // Jitter each grid cell's point by up to 0.4 cell-widths from center
      let jitter = hash2(neighbor) * 0.4;
      let cellPoint = (neighbor + 0.5 + jitter) * cellSz;
      let d = distance(pos, cellPoint);

      if (d < d1) {
        d2 = d1;
        d1 = d;
        *nearestCenter = cellPoint;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return vec2f(d1, d2);
}

// --- Poisson disk offsets for frost sampling (8 well-distributed points) ---
const POISSON_DISK = array<vec2f, 8>(
  vec2f(-0.613,  0.617),
  vec2f( 0.170, -0.040),
  vec2f(-0.299, -0.615),
  vec2f( 0.729, -0.312),
  vec2f( 0.015,  0.453),
  vec2f(-0.727,  0.087),
  vec2f( 0.409,  0.629),
  vec2f( 0.247, -0.756)
);

// Vertex shader - generates a fullscreen triangle
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  return vec4f(positions[vertexIndex], 0.0, 1.0);
}

// Fragment shader - frosted glass effect per-pixel
@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let pixelPos = fragCoord.xy;
  let uv = pixelPos / uniforms.resolution;
  let cellSz = max(uniforms.cellSize, 1.0);

  // --- Step 1: Voronoi cell computation ---
  var nearestCenter: vec2f;
  let dists = voronoiDistances(pixelPos, cellSz, &nearestCenter);
  let d1 = dists.x;  // distance to nearest cell center
  let d2 = dists.y;  // distance to second nearest

  // --- Step 2: Per-cell convex dome lens displacement ---
  // Each cell acts as a dome/lens. Displacement direction points from pixel toward cell center.
  let toCenter = nearestCenter - pixelPos;
  let toCenterLen = length(toCenter);
  let dir = select(vec2f(0.0), toCenter / toCenterLen, toCenterLen > 0.001);

  // Normalized distance from cell center (0 at center, ~1 at cell edge)
  let cellRadius = (d1 + d2) * 0.5;
  let t = clamp(d1 / max(cellRadius, 1.0), 0.0, 1.0);

  // Dome profile: bell curve peaking at mid-radius (where surface slope is steepest)
  // Zero at center (flat apex), max at ~0.45, zero at edge (flat border)
  let domeProfile = smoothstep(0.0, 0.45, t) * smoothstep(1.0, 0.45, t);

  // Depth modulation: sample depth unconditionally (uniform control flow)
  // hasDepth packing: bit 0 = enabled, bit 1 = invert, bits 16-31 = influence
  let rawDepth = textureSample(depthTexture, depthSampler, uv).r;
  let depthEnabled = (uniforms.hasDepth & 1u) == 1u;
  let depthInvert = (uniforms.hasDepth & 2u) != 0u;
  let depthInfluence = f32(uniforms.hasDepth >> 16u) / 65535.0;
  let frostedDepth = select(rawDepth, 1.0 - rawDepth, depthInvert);
  let depthMod = mix(0.4, 1.6, frostedDepth);
  let depthScale = select(1.0, mix(1.0, depthMod, depthInfluence), depthEnabled);

  // Displacement magnitude in UV space (depth modulates refraction strength)
  let displaceMag = domeProfile * uniforms.intensity * uniforms.scale * 0.02 * depthScale;
  let displacement = dir * displaceMag;

  // Base UV after lens refraction
  let baseUV = clamp(uv + displacement, vec2f(0.0), vec2f(1.0));

  // --- Step 3: Chromatic dispersion + Frost scatter (8 Poisson-disk samples) ---
  // Chromatic dispersion: offset R and B channels along the refraction direction
  let dispLen = length(displacement);
  let dispDir = select(vec2f(1.0, 0.0), displacement / dispLen, dispLen > 1e-6);
  let chromOffset = dispDir * uniforms.dispersion * uniforms.scale * 0.004;

  let baseUVR = clamp(uv + displacement + chromOffset, vec2f(0.0), vec2f(1.0));
  let baseUVB = clamp(uv + displacement - chromOffset, vec2f(0.0), vec2f(1.0));

  // Scatter radius proportional to frostiness and cell size, in UV space
  let frostRadius = uniforms.frostiness * cellSz
    / max(uniforms.resolution.x, uniforms.resolution.y) * 0.5;

  // When frostiness=0 and dispersion=0, all offsets collapse — GPU texture cache makes this ~free
  var accumR = 0.0;
  var accumG = 0.0;
  var accumB = 0.0;
  var accumA = 0.0;
  for (var i: u32 = 0u; i < 8u; i++) {
    let offset = POISSON_DISK[i] * frostRadius;
    accumR += textureSample(sourceTexture, sourceSampler, clamp(baseUVR + offset, vec2f(0.0), vec2f(1.0))).r;
    let gSample = textureSample(sourceTexture, sourceSampler, clamp(baseUV + offset, vec2f(0.0), vec2f(1.0)));
    accumG += gSample.g;
    accumA += gSample.a;
    accumB += textureSample(sourceTexture, sourceSampler, clamp(baseUVB + offset, vec2f(0.0), vec2f(1.0))).b;
  }
  let sampledColor = vec4f(accumR, accumG, accumB, accumA) * 0.125; // divide by 8

  // --- Step 4: Cell edge highlighting ---
  // Edge proximity: d2-d1 approaches 0 on the Voronoi border (equidistant from two centers)
  let edgeDist = d2 - d1;
  let edgeWidth = cellSz * 0.03;
  let edgeFactor = 1.0 - smoothstep(0.0, edgeWidth, edgeDist);

  // Subtle additive highlight at cell edges, controlled by highlight knob
  let coeffs = select(vec3f(0.2126, 0.7152, 0.0722), vec3f(0.2290, 0.6917, 0.0793), uniforms.is_p3 != 0u);
  let bgLuminance = dot(sampledColor.rgb, coeffs);
  let edgeHighlight = edgeFactor * uniforms.highlight * 0.12 * bgLuminance;

  // --- Step 5: Caustic brightness (dome focuses light toward cell center) ---
  let caustic = 1.0 + (1.0 - t * t) * 0.008 * uniforms.scale;

  // --- Step 6: Combine ---
  let result = sampledColor.rgb * caustic + edgeHighlight;

  return vec4f(clamp(result, vec3f(0.0), vec3f(1.0)), sampledColor.a);
}
