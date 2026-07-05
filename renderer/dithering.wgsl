// Dithering shader - ordered dithering with various patterns and multi-color palette support
// Uniform buffer layout (336 bytes, 16-byte aligned)
struct Uniforms {
  resolution: vec2f,       // Canvas dimensions (offset 0)
  scale: f32,              // Pattern scale factor 0.1-3.0 (offset 8)
  intensity: f32,          // Brightness curve intensity 0-5 (offset 12)
  cellSize: f32,           // Pixelation cell size (offset 16)
  shape: u32,              // Unused for dithering (offset 20)
  preserveColors: u32,     // 0 = mono (2-color), 1 = per-channel RGB (offset 24)
  ditheringKind: u32,      // Algorithm: 0=bayer2x2, 1=bayer4x4, 2=bayer8x8, 3=whiteNoise, 4=blueNoise (offset 28)
  color: vec4f,            // Foreground color for mono mode (offset 32)
  background: vec4f,       // Background color for mono mode (offset 48)
  // Extended palette data (offset 64+)
  paletteCount: u32,       // Number of colors in palette (2-16) (offset 64)
  _pad0: u32,              // Padding for alignment (offset 68)
  is_p3: u32,              // 1 = Display P3, 0 = sRGB (offset 72)
  _pad2: u32,              // Padding for alignment (offset 76)
  palette: array<vec4f, 16>, // Color palette (offset 80, 256 bytes)
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

// Bayer 2x2 matrix (values 0-3, normalized to 0-1)
fn bayer2x2(pos: vec2u) -> f32 {
  let matrix = array<f32, 4>(
    0.0, 2.0,
    3.0, 1.0
  );
  let idx = (pos.y % 2u) * 2u + (pos.x % 2u);
  return (matrix[idx] + 0.5) / 4.0;
}

// Bayer 4x4 matrix (values 0-15, normalized to 0-1)
fn bayer4x4(pos: vec2u) -> f32 {
  let matrix = array<f32, 16>(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  let idx = (pos.y % 4u) * 4u + (pos.x % 4u);
  return (matrix[idx] + 0.5) / 16.0;
}

// Bayer 8x8 matrix (values 0-63, normalized to 0-1)
fn bayer8x8(pos: vec2u) -> f32 {
  let matrix = array<f32, 64>(
     0.0, 32.0,  8.0, 40.0,  2.0, 34.0, 10.0, 42.0,
    48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
    12.0, 44.0,  4.0, 36.0, 14.0, 46.0,  6.0, 38.0,
    60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
     3.0, 35.0, 11.0, 43.0,  1.0, 33.0,  9.0, 41.0,
    51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
    15.0, 47.0,  7.0, 39.0, 13.0, 45.0,  5.0, 37.0,
    63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0
  );
  let idx = (pos.y % 8u) * 8u + (pos.x % 8u);
  return (matrix[idx] + 0.5) / 64.0;
}

// White noise hash function (PCG-based)
fn hash(p: vec2u) -> f32 {
  var state = (p.x * 1597334673u) ^ (p.y * 3812015801u);
  state = (state * 1664525u) + 1013904223u;
  state = state ^ (state >> 16u);
  state = (state * 1664525u) + 1013904223u;
  return f32(state) / 4294967295.0;
}

// Blue noise approximation using interleaved gradient noise (Jorge Jimenez)
// Better than white noise, avoids clumping patterns
fn blueNoise(pos: vec2f) -> f32 {
  return fract(52.9829189 * fract(0.06711056 * pos.x + 0.00583715 * pos.y));
}

// Get threshold value based on dithering algorithm
fn getThreshold(pixelPos: vec2f, patternScale: f32) -> f32 {
  // Scale the position for pattern size
  let scaledPos = pixelPos / patternScale;
  let intPos = vec2u(u32(scaledPos.x), u32(scaledPos.y));

  switch (uniforms.ditheringKind) {
    case 0u: { // bayer2x2
      return bayer2x2(intPos);
    }
    case 1u: { // bayer4x4
      return bayer4x4(intPos);
    }
    case 2u: { // bayer8x8
      return bayer8x8(intPos);
    }
    case 3u: { // whiteNoise
      return hash(intPos);
    }
    case 4u: { // blueNoise (IGN)
      return blueNoise(floor(scaledPos));
    }
    default: {
      return bayer4x4(intPos); // Default to bayer4x4
    }
  }
}

// Quantize a value to binary (0 or 1) using threshold
fn quantize(value: f32, threshold: f32) -> f32 {
  return select(0.0, 1.0, value >= threshold);
}

// Calculate brightness using color-space-appropriate luminance coefficients
fn luminance(c: vec3f) -> f32 {
  let coeffs = select(vec3f(0.2126, 0.7152, 0.0722), vec3f(0.2290, 0.6917, 0.0793), uniforms.is_p3 != 0u);
  return dot(c, coeffs);
}

fn applyIntensity(value: f32) -> f32 {
  if (uniforms.intensity == 1.0) {
    return value;
  }
  return pow(value, max(uniforms.intensity, 0.01));
}

// Find the nearest color in the palette using squared Euclidean distance
fn findNearestPaletteColor(rgb: vec3f) -> vec3f {
  var minDist = 1e10;
  var nearestColor = uniforms.palette[0].rgb;

  for (var i = 0u; i < uniforms.paletteCount; i++) {
    let paletteColor = uniforms.palette[i].rgb;
    let diff = rgb - paletteColor;
    let dist = dot(diff, diff); // squared Euclidean distance
    if (dist < minDist) {
      minDist = dist;
      nearestColor = paletteColor;
    }
  }

  return nearestColor;
}

// Find two nearest palette colors for dithering and their blend ratio
fn findTwoNearestColors(rgb: vec3f) -> vec4f {
  // Returns: xy = darker color index, zw = lighter color index (packed as index.0, index.0)
  // Actually returns rgb of darker and lighter colors
  var lum = luminance(rgb);
  var lowerColor = uniforms.palette[0].rgb;
  var upperColor = uniforms.palette[0].rgb;
  var lowerLum = 0.0;
  var upperLum = 1.0;

  // Find the two palette colors that bracket the input luminance
  for (var i = 0u; i < uniforms.paletteCount; i++) {
    let palColor = uniforms.palette[i].rgb;
    let palLum = luminance(palColor);

    if (palLum <= lum && palLum >= lowerLum) {
      lowerLum = palLum;
      lowerColor = palColor;
    }
    if (palLum >= lum && palLum <= upperLum) {
      upperLum = palLum;
      upperColor = palColor;
    }
  }

  return vec4f(lowerLum, upperLum, 0.0, 0.0);
}

// Get palette color by luminance bracket
fn getPaletteColorByLuminance(targetLum: f32, findLower: bool) -> vec3f {
  var bestColor = uniforms.palette[0].rgb;
  var bestLum: f32;
  if (findLower) {
    bestLum = -1.0;
  } else {
    bestLum = 2.0;
  }

  for (var i = 0u; i < uniforms.paletteCount; i++) {
    let palColor = uniforms.palette[i].rgb;
    let palLum = luminance(palColor);

    if (findLower) {
      if (palLum <= targetLum && palLum > bestLum) {
        bestLum = palLum;
        bestColor = palColor;
      }
    } else {
      if (palLum >= targetLum && palLum < bestLum) {
        bestLum = palLum;
        bestColor = palColor;
      }
    }
  }

  return bestColor;
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

// Fragment shader - computes dithered output per-pixel
@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let pixelPos = fragCoord.xy;

  // Optional pixelation: sample at cell center if cellSize > 1
  var samplePos = pixelPos;
  if (uniforms.cellSize > 1.0) {
    let cellIndex = floor(pixelPos / uniforms.cellSize);
    let cellCenter = (cellIndex + 0.5) * uniforms.cellSize;
    samplePos = cellCenter;
  }

  // Sample source texture
  let sampleUV = samplePos / uniforms.resolution;
  let clampedUV = clamp(sampleUV, vec2f(0.0), vec2f(1.0));
  let sourceColor = textureSample(sourceTexture, sourceSampler, clampedUV);

  // Pattern scale: larger scale = larger pattern, smaller scale = finer pattern
  // Scale of 1.0 means 1:1 pixel mapping to pattern
  let patternScale = max(uniforms.scale, 0.1);

  // Get dither threshold for this pixel
  let threshold = getThreshold(pixelPos, patternScale);

  var outColor: vec4f;

  if (uniforms.preserveColors == 1u) {
    // Per-channel RGB dithering: dither each channel independently
    // Apply intensity curve to each channel before dithering
    let adjustedR = applyIntensity(sourceColor.r);
    let adjustedG = applyIntensity(sourceColor.g);
    let adjustedB = applyIntensity(sourceColor.b);

    let ditheredR = quantize(adjustedR, threshold);
    let ditheredG = quantize(adjustedG, threshold);
    let ditheredB = quantize(adjustedB, threshold);
    let ditheredA = quantize(sourceColor.a, threshold);

    outColor = vec4f(ditheredR, ditheredG, ditheredB, ditheredA);
  } else if (uniforms.paletteCount > 2u) {
    // Multi-color palette dithering
    // Apply intensity curve to input color
    let adjustedColor = vec3f(
      applyIntensity(sourceColor.r),
      applyIntensity(sourceColor.g),
      applyIntensity(sourceColor.b)
    );

    // Calculate luminance for the adjusted color
    let lum = luminance(adjustedColor);

    // Find the two bracketing colors from palette based on luminance
    var lowerColor = uniforms.palette[0].rgb;
    var upperColor = uniforms.palette[0].rgb;
    var lowerAlpha = uniforms.palette[0].a;
    var upperAlpha = uniforms.palette[0].a;
    var lowerLum = -0.01;
    var upperLum = 1.01;

    // Find colors that bracket the target luminance
    for (var i = 0u; i < uniforms.paletteCount; i++) {
      let palColor = uniforms.palette[i].rgb;
      let palLum = luminance(palColor);
      let palAlpha = uniforms.palette[i].a;

      if (palLum <= lum && palLum > lowerLum) {
        lowerLum = palLum;
        lowerColor = palColor;
        lowerAlpha = palAlpha;
      }
      if (palLum >= lum && palLum < upperLum) {
        upperLum = palLum;
        upperColor = palColor;
        upperAlpha = palAlpha;
      }
    }

    // Calculate blend factor based on where luminance falls between the two colors
    var blendFactor = 0.0;
    if (upperLum > lowerLum) {
      blendFactor = (lum - lowerLum) / (upperLum - lowerLum);
    }

    // Use threshold to dither between the two bracketing colors
    let dithered = select(0.0, 1.0, blendFactor >= threshold);
    let finalColor = mix(lowerColor, upperColor, dithered);
    let finalAlpha = mix(lowerAlpha, upperAlpha, dithered);
    let sourceCoverage = quantize(sourceColor.a, threshold);

    outColor = vec4f(finalColor, finalAlpha * sourceCoverage);
  } else {
    // Classic 2-color dithering (backward compatible)
    let gray = luminance(sourceColor.rgb);
    // Apply intensity curve (higher = more contrast)
    let adjustedGray = applyIntensity(gray);

    let dithered = quantize(adjustedGray, threshold);

    // Blend between palette[0] (background) and palette[1] (foreground)
    let bgColor = uniforms.palette[0].rgb;
    let fgColor = uniforms.palette[1].rgb;
    let finalColor = mix(bgColor, fgColor, dithered);

    // Use alpha from background/foreground colors
    let bgAlpha = uniforms.palette[0].a;
    let fgAlpha = uniforms.palette[1].a;
    let finalAlpha = mix(bgAlpha, fgAlpha, dithered);
    let sourceCoverage = quantize(sourceColor.a, threshold);

    outColor = vec4f(finalColor, finalAlpha * sourceCoverage);
  }

  // Premultiply alpha for canvas blending
  return vec4f(outColor.rgb * outColor.a, outColor.a);
}
