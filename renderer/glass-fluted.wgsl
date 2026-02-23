// Fluted glass shader - simulates light refracting through ridged glass
// Creates periodic cylindrical lens distortion with highlight/shadow depth cues
// Uniform buffer layout (336 bytes, 16-byte aligned) - shared with other shaders
struct Uniforms {
  resolution: vec2f,       // Canvas dimensions (offset 0)
  scale: f32,              // Lens curvature depth 0.1-3.0 (offset 8)
  intensity: f32,          // Refraction strength 0-5 (offset 12)
  cellSize: f32,           // Ridge period in pixels (offset 16)
  caustic: f32,            // Caustic brightness strength 0-2 (offset 20)
  dispersion: f32,         // Chromatic channel separation 0-1 (offset 24)
  angle: f32,              // Ridge angle in degrees (offset 28)
  color: vec4f,            // Unused (offset 32)
  background: vec4f,       // Unused (offset 48)
  paletteCount: u32,       // Unused (offset 64)
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  palette: array<vec4f, 16>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318530;

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

// Fragment shader - computes fluted glass refraction per-pixel
@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let pixelPos = fragCoord.xy;
  let uv = pixelPos / uniforms.resolution;

  // Convert angle from degrees to radians
  let angle_rad = uniforms.angle * PI / 180.0;
  let cosA = cos(angle_rad);
  let sinA = sin(angle_rad);

  // Center the coordinate system for rotation
  let centered = pixelPos - uniforms.resolution * 0.5;

  // Rotate into ridge-aligned space (ridges run along y-axis in rotated space)
  let rotatedX = centered.x * cosA + centered.y * sinA;

  // Compute ridge phase - periodic pattern along the perpendicular-to-ridge direction
  // cellSize controls the period (width of each ridge/slit)
  let frequency = TAU / max(uniforms.cellSize, 1.0);
  let phase = rotatedX * frequency;

  // Lens curvature profile: cos(phase) gives smooth cylindrical lens shape
  let ridgeProfile = cos(phase);

  // Scale controls the curvature depth: higher = deeper cylindrical lens
  let curvature = uniforms.scale;

  // Edge-sharpened refraction: tanh compresses the flat mid-ridge region
  // and sharpens the transition at ridge boundaries where glass bends light most.
  // Compared to raw -sin(phase), this makes edges snap harder while keeping
  // smooth regions relatively undistorted — closer to real cylindrical glass.
  let sharpness = 2.0;
  let edgeSlope = tanh(sharpness * sin(phase));
  let refraction = -edgeSlope * uniforms.intensity * curvature * 0.015;

  // Apply displacement perpendicular to ridges
  // In rotated space, displacement is along x-axis; rotate back to screen space
  let dx = refraction * cosA;
  let dy = refraction * sinA;

  // --- Chromatic dispersion (prism RGB splitting) ---
  // Green samples at base displaced UV; red and blue offset symmetrically
  // along the refraction direction
  let displacement = vec2f(dx, dy);
  let dispLen = length(displacement);
  let dispDir = select(vec2f(1.0, 0.0), displacement / dispLen, dispLen > 1e-6);
  let chromOffset = dispDir * uniforms.dispersion * uniforms.scale * 0.004;

  let uvBase = clamp(uv + displacement, vec2f(0.0), vec2f(1.0));
  let uvRed = clamp(uv + displacement + chromOffset, vec2f(0.0), vec2f(1.0));
  let uvBlue = clamp(uv + displacement - chromOffset, vec2f(0.0), vec2f(1.0));

  let colorR = textureSample(sourceTexture, sourceSampler, uvRed).r;
  let colorG = textureSample(sourceTexture, sourceSampler, uvBase).g;
  let colorB = textureSample(sourceTexture, sourceSampler, uvBlue).b;
  let colorA = textureSample(sourceTexture, sourceSampler, uvBase).a;

  // --- Caustic brightness (physically-based) ---
  // The cylindrical lens concentrates light where rays converge and spreads it where they diverge.
  // Computed from the Jacobian of the UV mapping using the tanh profile derivative:
  // d/dx[tanh(a·sin(φ))] = a·cos(φ)·sech²(a·sin(φ)) = a·cos(φ)·(1 - tanh²(a·sin(φ)))
  let causticK = uniforms.intensity * curvature * 0.5;
  let sechSq = 1.0 - edgeSlope * edgeSlope;
  let causticDeriv = sharpness * cos(phase) * sechSq;
  let jacobian = 1.0 + causticDeriv * frequency * causticK;
  // Smooth reciprocal: sqrt(j² + ε) avoids the hard floor clamp for softer caustic transitions
  let smoothJ = sqrt(jacobian * jacobian + 0.04);
  let rawCaustic = clamp(1.0 / smoothJ, 0.7, 5.0);
  // Mix between 1.0 (no caustic) and the computed caustic, controlled by the caustic knob
  let caustic = mix(1.0, rawCaustic, uniforms.caustic);

  // --- Fresnel edge glint (subtle) ---
  // At ridge edges where the glass surface is steep, a small fraction of light reflects.
  // cos(phase) ≈ 0 at edges (steep surface normal), so use 1 - |cos(phase)| as Fresnel proxy.
  let fresnel = pow(1.0 - abs(ridgeProfile), 5.0) * 0.003 * curvature;

  // Apply: caustic is a multiplier (content-dependent), fresnel is a tiny additive glint
  let result = vec3f(colorR, colorG, colorB) * caustic + fresnel;

  return vec4f(clamp(result, vec3f(0.0), vec3f(1.0)), colorA);
}
