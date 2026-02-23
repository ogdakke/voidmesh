// Error diffusion dithering compute shader with multi-color palette support
// Processes image row-by-row with error propagation

struct Uniforms {
  resolution: vec2f,       // Image dimensions (offset 0)
  scale: f32,              // Unused for compute (offset 8)
  intensity: f32,          // Brightness curve intensity (offset 12)
  cellSize: f32,           // Pixelation cell size (offset 16)
  shape: u32,              // Unused (offset 20)
  preserveColors: u32,     // 0 = mono, 1 = per-channel RGB (offset 24)
  ditheringKind: u32,      // Algorithm index: 5-11 for error diffusion (offset 28)
  color: vec4f,            // Foreground color for mono mode (offset 32)
  background: vec4f,       // Background color for mono mode (offset 48)
  // Extended palette data (offset 64+)
  paletteCount: u32,       // Number of colors in palette (2-16) (offset 64)
  _pad0: u32,              // Padding for alignment (offset 68)
  _pad1: u32,              // Padding for alignment (offset 72)
  _pad2: u32,              // Padding for alignment (offset 76)
  palette: array<vec4f, 16>, // Color palette (offset 80, 256 bytes)
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var outputTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<storage, read_write> errorBuffer: array<vec4f>;

// Calculate buffer index from 2D position
fn getErrorIndex(x: u32, y: u32, width: u32) -> u32 {
  return y * width + x;
}

// Calculate brightness using ITU-R BT.601 luminance formula
fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
}

// Quantize a value to 0 or 1
fn quantize(value: f32) -> f32 {
  return select(0.0, 1.0, value >= 0.5);
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

// Find the nearest color to a given luminance (for monochrome dithering)
fn findNearestByLuminance(targetLum: f32) -> vec3f {
  var minDist = 1e10;
  var nearestColor = uniforms.palette[0].rgb;

  for (var i = 0u; i < uniforms.paletteCount; i++) {
    let paletteColor = uniforms.palette[i].rgb;
    let palLum = luminance(paletteColor);
    let dist = abs(palLum - targetLum);
    if (dist < minDist) {
      minDist = dist;
      nearestColor = paletteColor;
    }
  }

  return nearestColor;
}

// Diffuse error to neighboring pixels based on algorithm
// Algorithm indices: 5=floydSteinberg, 6=atkinson, 7=JJN, 8=stucki, 9=burkes, 10=sierra, 11=sierraLite
fn diffuseError(error: vec4f, x: u32, y: u32, width: u32, height: u32, serpentine: bool) {
  let algorithm = uniforms.ditheringKind;

  // Direction based on serpentine scanning (alternates each row)
  let dir = select(1i, -1i, serpentine);

  switch (algorithm) {
    case 5u: { // Floyd-Steinberg
      //       *  7/16
      // 3/16  5/16  1/16
      if (i32(x) + dir >= 0 && i32(x) + dir < i32(width)) {
        let idx = getErrorIndex(u32(i32(x) + dir), y, width);
        errorBuffer[idx] = errorBuffer[idx] + error * (7.0 / 16.0);
      }
      if (y + 1u < height) {
        if ((x > 0u && !serpentine) || (x + 1u < width && serpentine)) {
          let idx = getErrorIndex(u32(i32(x) - dir), y + 1u, width);
          errorBuffer[idx] = errorBuffer[idx] + error * (3.0 / 16.0);
        }
        let idx = getErrorIndex(x, y + 1u, width);
        errorBuffer[idx] = errorBuffer[idx] + error * (5.0 / 16.0);
        if (i32(x) + dir >= 0 && i32(x) + dir < i32(width)) {
          let idx2 = getErrorIndex(u32(i32(x) + dir), y + 1u, width);
          errorBuffer[idx2] = errorBuffer[idx2] + error * (1.0 / 16.0);
        }
      }
    }
    case 6u: { // Atkinson (1/8 weights, doesn't diffuse full error - preserves detail)
      //       *  1/8  1/8
      // 1/8  1/8  1/8
      //      1/8
      let w = 1.0 / 8.0;
      // Right
      if (i32(x) + dir >= 0 && i32(x) + dir < i32(width)) {
        let idx = getErrorIndex(u32(i32(x) + dir), y, width);
        errorBuffer[idx] = errorBuffer[idx] + error * w;
      }
      // Right+1
      if (i32(x) + 2 * dir >= 0 && i32(x) + 2 * dir < i32(width)) {
        let idx = getErrorIndex(u32(i32(x) + 2 * dir), y, width);
        errorBuffer[idx] = errorBuffer[idx] + error * w;
      }
      // Next row
      if (y + 1u < height) {
        if (i32(x) - dir >= 0 && i32(x) - dir < i32(width)) {
          let idx = getErrorIndex(u32(i32(x) - dir), y + 1u, width);
          errorBuffer[idx] = errorBuffer[idx] + error * w;
        }
        let idx = getErrorIndex(x, y + 1u, width);
        errorBuffer[idx] = errorBuffer[idx] + error * w;
        if (i32(x) + dir >= 0 && i32(x) + dir < i32(width)) {
          let idx2 = getErrorIndex(u32(i32(x) + dir), y + 1u, width);
          errorBuffer[idx2] = errorBuffer[idx2] + error * w;
        }
      }
      // Row+2
      if (y + 2u < height) {
        let idx = getErrorIndex(x, y + 2u, width);
        errorBuffer[idx] = errorBuffer[idx] + error * w;
      }
    }
    case 7u: { // Jarvis-Judice-Ninke (larger kernel, smoother)
      //           *  7/48  5/48
      // 3/48  5/48  7/48  5/48  3/48
      // 1/48  3/48  5/48  3/48  1/48
      let d = 48.0;
      // Current row
      if (i32(x) + dir >= 0 && i32(x) + dir < i32(width)) {
        errorBuffer[getErrorIndex(u32(i32(x) + dir), y, width)] += error * (7.0 / d);
      }
      if (i32(x) + 2 * dir >= 0 && i32(x) + 2 * dir < i32(width)) {
        errorBuffer[getErrorIndex(u32(i32(x) + 2 * dir), y, width)] += error * (5.0 / d);
      }
      // Row+1
      if (y + 1u < height) {
        let weights1 = array<f32, 5>(3.0, 5.0, 7.0, 5.0, 3.0);
        for (var dx = -2i; dx <= 2i; dx++) {
          let nx = i32(x) + dx * dir;
          if (nx >= 0 && nx < i32(width)) {
            errorBuffer[getErrorIndex(u32(nx), y + 1u, width)] += error * (weights1[dx + 2] / d);
          }
        }
      }
      // Row+2
      if (y + 2u < height) {
        let weights2 = array<f32, 5>(1.0, 3.0, 5.0, 3.0, 1.0);
        for (var dx = -2i; dx <= 2i; dx++) {
          let nx = i32(x) + dx * dir;
          if (nx >= 0 && nx < i32(width)) {
            errorBuffer[getErrorIndex(u32(nx), y + 2u, width)] += error * (weights2[dx + 2] / d);
          }
        }
      }
    }
    case 8u: { // Stucki (similar to JJN)
      let d = 42.0;
      // Current row
      if (i32(x) + dir >= 0 && i32(x) + dir < i32(width)) {
        errorBuffer[getErrorIndex(u32(i32(x) + dir), y, width)] += error * (8.0 / d);
      }
      if (i32(x) + 2 * dir >= 0 && i32(x) + 2 * dir < i32(width)) {
        errorBuffer[getErrorIndex(u32(i32(x) + 2 * dir), y, width)] += error * (4.0 / d);
      }
      // Row+1
      if (y + 1u < height) {
        let weights1 = array<f32, 5>(2.0, 4.0, 8.0, 4.0, 2.0);
        for (var dx = -2i; dx <= 2i; dx++) {
          let nx = i32(x) + dx * dir;
          if (nx >= 0 && nx < i32(width)) {
            errorBuffer[getErrorIndex(u32(nx), y + 1u, width)] += error * (weights1[dx + 2] / d);
          }
        }
      }
      // Row+2
      if (y + 2u < height) {
        let weights2 = array<f32, 5>(1.0, 2.0, 4.0, 2.0, 1.0);
        for (var dx = -2i; dx <= 2i; dx++) {
          let nx = i32(x) + dx * dir;
          if (nx >= 0 && nx < i32(width)) {
            errorBuffer[getErrorIndex(u32(nx), y + 2u, width)] += error * (weights2[dx + 2] / d);
          }
        }
      }
    }
    case 9u: { // Burkes (simplified JJN, faster)
      let d = 32.0;
      // Current row
      if (i32(x) + dir >= 0 && i32(x) + dir < i32(width)) {
        errorBuffer[getErrorIndex(u32(i32(x) + dir), y, width)] += error * (8.0 / d);
      }
      if (i32(x) + 2 * dir >= 0 && i32(x) + 2 * dir < i32(width)) {
        errorBuffer[getErrorIndex(u32(i32(x) + 2 * dir), y, width)] += error * (4.0 / d);
      }
      // Row+1
      if (y + 1u < height) {
        let weights = array<f32, 5>(2.0, 4.0, 8.0, 4.0, 2.0);
        for (var dx = -2i; dx <= 2i; dx++) {
          let nx = i32(x) + dx * dir;
          if (nx >= 0 && nx < i32(width)) {
            errorBuffer[getErrorIndex(u32(nx), y + 1u, width)] += error * (weights[dx + 2] / d);
          }
        }
      }
    }
    case 10u: { // Sierra (full)
      let d = 32.0;
      // Current row
      if (i32(x) + dir >= 0 && i32(x) + dir < i32(width)) {
        errorBuffer[getErrorIndex(u32(i32(x) + dir), y, width)] += error * (5.0 / d);
      }
      if (i32(x) + 2 * dir >= 0 && i32(x) + 2 * dir < i32(width)) {
        errorBuffer[getErrorIndex(u32(i32(x) + 2 * dir), y, width)] += error * (3.0 / d);
      }
      // Row+1
      if (y + 1u < height) {
        let weights1 = array<f32, 5>(2.0, 4.0, 5.0, 4.0, 2.0);
        for (var dx = -2i; dx <= 2i; dx++) {
          let nx = i32(x) + dx * dir;
          if (nx >= 0 && nx < i32(width)) {
            errorBuffer[getErrorIndex(u32(nx), y + 1u, width)] += error * (weights1[dx + 2] / d);
          }
        }
      }
      // Row+2
      if (y + 2u < height) {
        let weights2 = array<f32, 3>(2.0, 3.0, 2.0);
        for (var dx = -1i; dx <= 1i; dx++) {
          let nx = i32(x) + dx * dir;
          if (nx >= 0 && nx < i32(width)) {
            errorBuffer[getErrorIndex(u32(nx), y + 2u, width)] += error * (weights2[dx + 1] / d);
          }
        }
      }
    }
    default: { // case 11u: Sierra Lite (simplified Sierra)
      //       *  2/4
      // 1/4  1/4
      let d = 4.0;
      if (i32(x) + dir >= 0 && i32(x) + dir < i32(width)) {
        errorBuffer[getErrorIndex(u32(i32(x) + dir), y, width)] += error * (2.0 / d);
      }
      if (y + 1u < height) {
        if (i32(x) - dir >= 0 && i32(x) - dir < i32(width)) {
          errorBuffer[getErrorIndex(u32(i32(x) - dir), y + 1u, width)] += error * (1.0 / d);
        }
        errorBuffer[getErrorIndex(x, y + 1u, width)] += error * (1.0 / d);
      }
    }
  }
}

// Get the sample position for a pixel (handles cellSize pixelation)
fn getSamplePos(x: u32, y: u32) -> vec2u {
  if (uniforms.cellSize <= 1.0) {
    return vec2u(x, y);
  }
  // Pixelation: sample from cell center
  let cellX = floor(f32(x) / uniforms.cellSize);
  let cellY = floor(f32(y) / uniforms.cellSize);
  let centerX = u32((cellX + 0.5) * uniforms.cellSize);
  let centerY = u32((cellY + 0.5) * uniforms.cellSize);
  return vec2u(
    min(centerX, u32(uniforms.resolution.x) - 1u),
    min(centerY, u32(uniforms.resolution.y) - 1u)
  );
}

// Main compute shader - process one row at a time
// Each thread processes one row (32 threads per workgroup for better GPU occupancy)
// This shader is dispatched with ceil(height/32) workgroups
@compute @workgroup_size(32, 1, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let rowY = globalId.x;
  let width = u32(uniforms.resolution.x);
  let height = u32(uniforms.resolution.y);

  if (rowY >= height) {
    return;
  }

  // Serpentine scanning: alternate direction each row
  let serpentine = (rowY % 2u) == 1u;

  // Process pixels in this row
  for (var i: u32 = 0u; i < width; i++) {
    // Determine actual x position based on serpentine
    let x = select(i, width - 1u - i, serpentine);

    // Read pixel from input texture (with optional pixelation)
    let samplePos = getSamplePos(x, rowY);
    let pixel = textureLoad(inputTexture, samplePos, 0);

    // Get accumulated error for this pixel
    let errorIdx = getErrorIndex(x, rowY, width);
    let accumulatedError = errorBuffer[errorIdx];

    // Clear error buffer for this pixel (it's been consumed)
    errorBuffer[errorIdx] = vec4f(0.0);

    var outputColor: vec4f;

    if (uniforms.preserveColors == 1u) {
      // Per-channel dithering
      let adjustedR = pow(pixel.r, max(uniforms.intensity, 0.01)) + accumulatedError.r;
      let adjustedG = pow(pixel.g, max(uniforms.intensity, 0.01)) + accumulatedError.g;
      let adjustedB = pow(pixel.b, max(uniforms.intensity, 0.01)) + accumulatedError.b;

      let quantizedR = quantize(adjustedR);
      let quantizedG = quantize(adjustedG);
      let quantizedB = quantize(adjustedB);

      // Calculate error
      let errorR = adjustedR - quantizedR;
      let errorG = adjustedG - quantizedG;
      let errorB = adjustedB - quantizedB;
      let error = vec4f(errorR, errorG, errorB, 0.0);

      // Diffuse error to neighbors
      diffuseError(error, x, rowY, width, height, serpentine);

      outputColor = vec4f(quantizedR, quantizedG, quantizedB, pixel.a);
    } else if (uniforms.paletteCount > 2u) {
      // Multi-color palette dithering with full RGB error diffusion
      let adjustedR = pow(pixel.r, max(uniforms.intensity, 0.01)) + accumulatedError.r;
      let adjustedG = pow(pixel.g, max(uniforms.intensity, 0.01)) + accumulatedError.g;
      let adjustedB = pow(pixel.b, max(uniforms.intensity, 0.01)) + accumulatedError.b;
      let adjustedColor = vec3f(adjustedR, adjustedG, adjustedB);

      // Find nearest palette color
      let quantizedColor = findNearestPaletteColor(adjustedColor);

      // Calculate RGB error
      let errorR = adjustedColor.r - quantizedColor.r;
      let errorG = adjustedColor.g - quantizedColor.g;
      let errorB = adjustedColor.b - quantizedColor.b;
      let error = vec4f(errorR, errorG, errorB, 0.0);

      // Diffuse error to neighbors
      diffuseError(error, x, rowY, width, height, serpentine);

      outputColor = vec4f(quantizedColor, pixel.a);
    } else {
      // Classic 2-color dithering (backward compatible)
      let gray = luminance(pixel.rgb);
      let adjustedGray = pow(gray, max(uniforms.intensity, 0.01)) + accumulatedError.r;

      let quantized = quantize(adjustedGray);
      let error = vec4f(adjustedGray - quantized, 0.0, 0.0, 0.0);

      // Diffuse error
      diffuseError(error, x, rowY, width, height, serpentine);

      // Map to palette colors (palette[0] = background, palette[1] = foreground)
      let bgColor = uniforms.palette[0].rgb;
      let fgColor = uniforms.palette[1].rgb;
      let finalRgb = mix(bgColor, fgColor, quantized);

      let bgAlpha = uniforms.palette[0].a;
      let fgAlpha = uniforms.palette[1].a;
      let finalAlpha = mix(bgAlpha, fgAlpha, quantized);

      outputColor = vec4f(finalRgb, finalAlpha);
    }

    // Write output pixel (premultiplied alpha)
    textureStore(outputTexture, vec2u(x, rowY), vec4f(outputColor.rgb * outputColor.a, outputColor.a));
  }
}
