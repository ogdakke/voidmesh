// Glitch shader — 4 variants: channelShift, scanline, blockCorrupt, pixelSmear
// Uniform buffer layout (304 bytes, 16-byte aligned)
struct Uniforms {
  resolution: vec2f,       // Canvas dimensions (offset 0)
  scale: f32,              // Scale factor 0.1-3.0 (offset 8)
  intensity: f32,          // Effect intensity 0-5 (offset 12)
  cellSize: f32,           // Size parameter (offset 16)
  time: f32,               // Animation time (offset 20, overwritten by variant)
  angle: f32,              // Direction angle in degrees (offset 24, overwritten by variant)
  kind: u32,               // 0=channelShift, 1=scanline, 2=blockCorrupt, 3=pixelSmear (offset 28)
  paletteCount: u32,       // Number of palette colors (offset 32)
  _pad0: u32,
  is_p3: u32,              // 1 = Display P3, 0 = sRGB (offset 40)
  _pad2: u32,
  palette: array<vec4f, 16>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

// ---- Hash functions for pseudo-random patterns ----

fn hash11(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x *= x + 33.33;
  x *= x + x;
  return fract(x);
}

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn hash31(p: vec3f) -> f32 {
  var p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// ---- Helpers ----

fn luminance(c: vec3f) -> f32 {
  let coeffs = select(vec3f(0.2126, 0.7152, 0.0722), vec3f(0.2290, 0.6917, 0.0793), uniforms.is_p3 != 0u);
  return dot(c, coeffs);
}

fn findNearestPaletteColor(rgb: vec3f) -> vec3f {
  var minDist = 1e10;
  var nearest = uniforms.palette[0].rgb;
  for (var i = 0u; i < uniforms.paletteCount; i++) {
    let pc = uniforms.palette[i].rgb;
    let diff = rgb - pc;
    let dist = dot(diff, diff);
    if (dist < minDist) {
      minDist = dist;
      nearest = pc;
    }
  }
  return nearest;
}

// Load a texel at UV coordinates using integer coords (no filtering).
// Safe to call from non-uniform control flow (unlike textureSample).
fn loadAtUV(uv: vec2f) -> vec4f {
  let dims = vec2f(textureDimensions(sourceTexture));
  let coord = vec2i(clamp(uv * dims, vec2f(0.0), dims - 1.0));
  return textureLoad(sourceTexture, coord, 0);
}

// ---- Glitch variants ----

fn channelShift(uv: vec2f) -> vec4f {
  let angleRad = uniforms.angle * 3.14159265 / 180.0;
  let dir = vec2f(cos(angleRad), sin(angleRad));

  // Base shift amount scales with intensity and size
  let baseShift = uniforms.intensity * uniforms.cellSize / uniforms.resolution;

  // Per-channel shift directions (static)
  let rShift = baseShift * dir * 1.0;
  let gShift = baseShift * dir * -0.5;
  let bShift = baseShift * dir * 0.3;

  let r = textureSample(sourceTexture, sourceSampler, clamp(uv + rShift, vec2f(0.0), vec2f(1.0))).r;
  let g = textureSample(sourceTexture, sourceSampler, clamp(uv + gShift, vec2f(0.0), vec2f(1.0))).g;
  let b = textureSample(sourceTexture, sourceSampler, clamp(uv + bShift, vec2f(0.0), vec2f(1.0))).b;
  let a = textureSample(sourceTexture, sourceSampler, uv).a;

  return vec4f(r, g, b, a);
}

fn scanlineDisplace(uv: vec2f) -> vec4f {
  let pixelY = uv.y * uniforms.resolution.y;
  let bandSize = max(uniforms.cellSize, 1.0);
  let bandIndex = floor(pixelY / bandSize);

  // Hash per band (static)
  let h = hash21(vec2f(bandIndex, 0.0));

  // Displacement: only some bands shift (controlled by intensity)
  let threshold = 1.0 - uniforms.intensity * 0.6;
  let bandActive = step(threshold, h); // 1.0 if h >= threshold, else 0.0
  let strength = select(0.0, (h - threshold) / max(1.0 - threshold, 0.001), h > threshold);
  let displacement = bandActive * (hash21(vec2f(bandIndex + 100.0, 0.0)) - 0.5) * 2.0 * strength * uniforms.scale * 0.15;

  // Add subtle per-scanline jitter
  let lineJitter = hash11(bandIndex * 7.31) * 0.002 * uniforms.intensity;

  let displacedUV = vec2f(clamp(uv.x + displacement + lineJitter, 0.0, 1.0), uv.y);
  return textureSample(sourceTexture, sourceSampler, displacedUV);
}

fn blockCorrupt(uv: vec2f) -> vec4f {
  let blockSize = max(uniforms.cellSize, 1.0);
  let blockCoord = floor(uv * uniforms.resolution / blockSize);

  // Determine if this block is corrupted (static)
  let h = hash31(vec3f(blockCoord, 0.0));
  let corruptThreshold = 1.0 - uniforms.intensity * 0.4;

  // Compute displaced UV (always computed, conditionally used via mix)
  let strength = select(0.0, (h - corruptThreshold) / max(1.0 - corruptThreshold, 0.001), h > corruptThreshold);
  let displaceHash = vec2f(
    hash31(vec3f(blockCoord + 50.0, 0.0)) - 0.5,
    hash31(vec3f(blockCoord + 150.0, 0.0)) - 0.5,
  );
  let blockDisplace = displaceHash * uniforms.scale * 0.3 * strength;
  let displacedUV = clamp(uv + blockDisplace, vec2f(0.0), vec2f(1.0));

  // Sample both original and displaced unconditionally (uniform control flow)
  let originalColor = textureSample(sourceTexture, sourceSampler, uv);
  let displacedColor = textureSample(sourceTexture, sourceSampler, displacedUV);

  // Select between original and displaced
  var color = mix(originalColor, displacedColor, strength);

  // Occasional color channel corruption (branchless via select)
  let channelHash = hash31(vec3f(blockCoord + 250.0, 0.0));
  let doSwap = step(0.7, channelHash) * step(corruptThreshold, h);
  let ch = u32(channelHash * 9.0) % 3u;
  let swapped = select(
    select(
      vec4f(color.b, color.g, color.r, color.a), // ch == 2
      vec4f(color.r, color.b, color.g, color.a), // ch == 1
      ch == 1u
    ),
    vec4f(color.g, color.r, color.b, color.a), // ch == 0
    ch == 0u
  );
  color = mix(color, swapped, doSwap);

  return color;
}

fn pixelSmear(uv: vec2f) -> vec4f {
  let angleRad = uniforms.angle * 3.14159265 / 180.0;
  let dir = vec2f(cos(angleRad), sin(angleRad));

  // Smear length in UV space
  let smearLength = uniforms.cellSize * uniforms.scale / uniforms.resolution;

  let sourceColor = textureSample(sourceTexture, sourceSampler, uv);
  let sourceLum = luminance(sourceColor.rgb);

  // Brightness threshold for smearing — pixels above threshold get smeared
  let threshold = 1.0 - uniforms.intensity * 0.8;

  // Always march (no early return), use textureLoad for non-uniform samples
  let steps = 16u;
  var accum = sourceColor.rgb;
  let stepSize = smearLength / f32(steps);
  let timeOffset = 0.0;

  var totalW = 1.0;
  for (var i = 1u; i <= steps; i++) {
    let offset = dir * stepSize * (f32(i) + timeOffset);
    let sampleUV = clamp(uv - offset, vec2f(0.0), vec2f(1.0));
    let s = loadAtUV(sampleUV);

    // Weight falls off with distance
    let w = 1.0 - f32(i) / f32(steps + 1u);
    accum += s.rgb * w;
    totalW += w;
  }

  let smeared = accum / totalW;
  // Blend: below threshold = original, above = smeared
  let blend = smoothstep(threshold, threshold + 0.2, sourceLum);
  let result = mix(sourceColor.rgb, smeared, blend);
  return vec4f(result, sourceColor.a);
}

// ---- Vertex shader ----

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  return vec4f(positions[vertexIndex], 0.0, 1.0);
}

// ---- Fragment shader ----

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = fragCoord.xy / uniforms.resolution;

  // kind encodes: bits 0-7 = glitch variant, bit 8 = quantize to palette
  let actualKind = uniforms.kind & 255u;
  let quantize = (uniforms.kind & 256u) != 0u;

  // Dispatch to variant (kind is uniform — safe for textureSample)
  var color: vec4f;
  if (actualKind == 0u) {
    color = channelShift(uv);
  } else if (actualKind == 1u) {
    color = scanlineDisplace(uv);
  } else if (actualKind == 2u) {
    color = blockCorrupt(uv);
  } else {
    color = pixelSmear(uv);
  }

  // Palette quantization (when preserveColors is off)
  if (quantize && uniforms.paletteCount >= 2u) {
    let quantized = findNearestPaletteColor(color.rgb);
    color = vec4f(quantized, color.a);
  }

  // Premultiply alpha
  return vec4f(color.rgb * color.a, color.a);
}
