// Flowing glass shader - simulates thick organic glass with flowing wave distortion
// Multi-frequency wave interference, chromatic dispersion (prism RGB splitting),
// physically-based caustics, and Fresnel edge highlights
// Uniform buffer layout (336 bytes, 16-byte aligned) - shared with other shaders
struct Uniforms {
  resolution: vec2f,       // Canvas dimensions (offset 0)
  scale: f32,              // Wave amplitude / curvature depth 0.1-3.0 (offset 8)
  intensity: f32,          // Refraction displacement strength 0-5 (offset 12)
  cellSize: f32,           // Wave spacing / wavelength in pixels (offset 16)
  dispersion: f32,         // Chromatic channel separation 0-1 (offset 20)
  time: f32,               // Animation time in seconds (offset 24)
  flow: f32,               // Ridge undulation 0=straight, 1=very wavy (offset 28)
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
const PHI: f32 = 1.61803398;  // Golden ratio for secondary wave frequency

// Turbulence: multi-octave rotated sine displacements for animated fluid motion
const TURB_OCTAVES: u32 = 8u;
const TURB_AMP: f32 = 0.7;
const TURB_SPEED: f32 = 0.3;
const TURB_FREQ: f32 = 2.0;
const TURB_EXP: f32 = 1.4;

// Pseudo-random hash: 2D -> 1D, non-periodic noise source
fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

// Warps a 2D position with layered rotated sine-wave displacements.
// Operates in normalized UV space for resolution independence.
fn turbulence(pos_in: vec2f, time: f32) -> vec2f {
  var pos = pos_in;
  var freq = TURB_FREQ;

  // 2x2 rotation matrix as column vectors (WGSL has no mat2)
  // Rotation by ~53.13°: cos≈0.6, sin≈0.8
  var rot0 = vec2f(0.6, 0.8);
  var rot1 = vec2f(-0.8, 0.6);

  let slowTime = time * 0.07;
  let slowFloor = floor(slowTime);
  let slowFrac = smoothstep(0.0, 1.0, fract(slowTime));

  for (var i: u32 = 0u; i < TURB_OCTAVES; i++) {
    // (rot * pos).y = dot(row1, pos) where row1 = (rot0.y, rot1.y)
    let rotated_y = rot0.y * pos.x + rot1.y * pos.y;

    // Non-periodic drift: hash-based phase offset that wanders per octave
    let octaveKey = f32(i) * 17.3;
    let drift = mix(
      hash21(vec2f(octaveKey, slowFloor)),
      hash21(vec2f(octaveKey, slowFloor + 1.0)),
      slowFrac
    ) * TAU;

    let phase = freq * rotated_y + TURB_SPEED * time + f32(i) + drift * 0.5;
    pos += TURB_AMP * rot0 * sin(phase) / freq;

    // Compound rotation: rot = rot * base_rotation
    let nr0 = rot0 * 0.6 + rot1 * 0.8;
    let nr1 = rot0 * (-0.8) + rot1 * 0.6;
    rot0 = nr0;
    rot1 = nr1;

    freq *= TURB_EXP;
  }

  return pos;
}

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

// Compute the combined wave height and its gradient at a pixel position.
// Returns vec3(height, dHeight/dx, dHeight/dy).
fn waveField(pos: vec2f, freq: f32, wavelength: f32, amplitude: f32, flow: f32, time: f32) -> vec3f {
  // --- Primary wave: vertical ridges with sinusoidal undulation ---
  // The y-modulation creates the flowing look: ridges that meander sideways.
  // When flow=0, yMod=0 and ridges are perfectly straight (like fluted glass).
  let yFreq = freq * 0.3;
  let yMod = sin(pos.y * yFreq) * wavelength * 0.15 * flow;
  // Slow phase drift so the glass surface itself evolves over time
  let timeDrift = sin(time * 0.13) * wavelength * 0.1;
  let primaryPhase = (pos.x + yMod + timeDrift) * freq;
  // Subtle amplitude breathing: glass thickness varies organically
  let ampMod = 1.0 + 0.1 * sin(time * 0.11 + pos.x * 0.001);
  let primaryHeight = cos(primaryPhase) * amplitude * ampMod;

  // Analytical gradient of primary wave (ampMod applied to amplitude)
  let dPrimaryPhase_dx = freq;
  let dPrimaryPhase_dy = cos(pos.y * yFreq) * yFreq * wavelength * 0.15 * flow * freq;
  let dPrimary_dx = -sin(primaryPhase) * amplitude * ampMod * dPrimaryPhase_dx;
  let dPrimary_dy = -sin(primaryPhase) * amplitude * ampMod * dPrimaryPhase_dy;

  // --- Secondary wave: golden-ratio frequency for interference complexity ---
  let secondaryFreq = freq * PHI;
  let yMod2 = sin(pos.y * yFreq * PHI) * wavelength * 0.08 * flow;
  let timeDrift2 = sin(time * 0.09 + 2.7) * wavelength * 0.07;
  let secondaryPhase = (pos.x + yMod2 + timeDrift2) * secondaryFreq;
  let secondaryAmplitude = amplitude * 0.35;
  let secondaryHeight = cos(secondaryPhase) * secondaryAmplitude;

  let dSecondaryPhase_dx = secondaryFreq;
  let dSecondaryPhase_dy = cos(pos.y * yFreq * PHI) * yFreq * PHI * wavelength * 0.08 * flow * secondaryFreq;
  let dSecondary_dx = -sin(secondaryPhase) * secondaryAmplitude * dSecondaryPhase_dx;
  let dSecondary_dy = -sin(secondaryPhase) * secondaryAmplitude * dSecondaryPhase_dy;

  // --- Cross-wave: perpendicular component for flowing lattice effect ---
  // Only appears when flow > 0, adding horizontal ridges
  let crossPhase = pos.y * freq * 0.7;
  let crossAmplitude = amplitude * 0.2 * flow;
  let crossHeight = cos(crossPhase) * crossAmplitude;

  let dCross_dx = 0.0;
  let dCross_dy = -sin(crossPhase) * crossAmplitude * freq * 0.7;

  // --- Combine ---
  let totalHeight = primaryHeight + secondaryHeight + crossHeight;
  let totalGrad_x = dPrimary_dx + dSecondary_dx + dCross_dx;
  let totalGrad_y = dPrimary_dy + dSecondary_dy + dCross_dy;

  return vec3f(totalHeight, totalGrad_x, totalGrad_y);
}

// Fragment shader - computes flowing glass refraction per-pixel
@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let pixelPos = fragCoord.xy;
  let uv = pixelPos / uniforms.resolution;

  let wavelength = max(uniforms.cellSize, 1.0);
  let freq = TAU / wavelength;
  let amplitude = uniforms.scale;
  let flow = uniforms.flow;

  // --- Turbulence: warp position for animated fluid motion ---
  let warpedUV = turbulence(uv, uniforms.time);
  let warpedPos = warpedUV * uniforms.resolution;

  // --- Step 1: Evaluate wave field (using warped position) ---
  let field = waveField(warpedPos, freq, wavelength, amplitude, flow, uniforms.time);
  let waveHeight = field.x;
  let grad_x = field.y;
  let grad_y = field.z;

  // --- Step 2: Edge-sharpened refraction displacement ---
  // Apply tanh to the gradient magnitude: compresses gentle slopes, sharpens
  // the transition at wave edges where glass bends light most dramatically.
  let refractionScale = uniforms.intensity * 0.015;
  let gradMag = length(vec2f(grad_x, grad_y));
  let gradDir = select(vec2f(0.0), vec2f(grad_x, grad_y) / gradMag, gradMag > 1e-6);
  let normFactor = max(freq * amplitude, 0.001);
  let sharpness = 2.0;
  let sharpenedMag = tanh(sharpness * gradMag / normFactor) * normFactor;
  let displacement = -gradDir * sharpenedMag * refractionScale;

  // --- Step 3: Chromatic dispersion (prism RGB splitting) ---
  // Green samples at base displaced UV; red and blue offset symmetrically
  // along the refraction direction
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

  // --- Step 4: Caustic brightness (physically-based from Jacobian) ---
  // Finite-difference 2D Jacobian: evaluate wave gradient at neighboring pixels
  let eps = 0.5;
  let fieldPx = waveField(warpedPos + vec2f(eps, 0.0), freq, wavelength, amplitude, flow, uniforms.time);
  let fieldMx = waveField(warpedPos - vec2f(eps, 0.0), freq, wavelength, amplitude, flow, uniforms.time);
  let fieldPy = waveField(warpedPos + vec2f(0.0, eps), freq, wavelength, amplitude, flow, uniforms.time);
  let fieldMy = waveField(warpedPos - vec2f(0.0, eps), freq, wavelength, amplitude, flow, uniforms.time);

  // d(displacement_x)/dx and d(displacement_y)/dy via central differences
  let dDx_dx = -(fieldPx.y - fieldMx.y) / (2.0 * eps) * refractionScale;
  let dDy_dy = -(fieldPy.z - fieldMy.z) / (2.0 * eps) * refractionScale;

  // Simplified 2D Jacobian determinant (ignoring off-diagonal terms)
  let jacobian = (1.0 + dDx_dx) * (1.0 + dDy_dy);
  // Smooth reciprocal: sqrt(j² + ε) avoids the hard floor clamp for softer caustic transitions
  let smoothJ = sqrt(jacobian * jacobian + 0.04);
  let rawCaustic = clamp(1.0 / smoothJ, 0.7, 5.0);
  let caustic = mix(1.0, rawCaustic, clamp(uniforms.intensity * 0.3, 0.0, 1.0));

  // --- Step 5: Fresnel edge highlights ---
  // Subtle glints where wave surface is steep (height passes through zero)
  let maxHeight = amplitude * 1.55;  // Approximate max from combined waves
  let normalizedHeight = abs(waveHeight) / max(maxHeight, 0.01);
  let fresnel = pow(1.0 - clamp(normalizedHeight, 0.0, 1.0), 5.0) * 0.005 * amplitude;

  // --- Step 6: Combine ---
  let result = vec3f(colorR, colorG, colorB) * caustic + fresnel;

  return vec4f(clamp(result, vec3f(0.0), vec3f(1.0)), colorA);
}
