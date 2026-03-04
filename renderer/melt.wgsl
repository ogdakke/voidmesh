// Melt effect shader - brighter pixels drip downward
// Uniform buffer layout (336 bytes, 16-byte aligned)
struct Uniforms {
  resolution: vec2f,       // Canvas dimensions (offset 0)
  scale: f32,              // Particle scale factor (offset 8)
  intensity: f32,          // Effect intensity - controls drip amount (offset 12)
  cellSize: f32,           // Cell size in pixels (offset 16)
  shape: u32,              // 0 = circle, 1 = square, 2 = rect_v (offset 20)
  preserveColors: u32,     // 0 = false, 1 = true (offset 24)
  _unused: f32,            // Unused padding (offset 28)
  color: vec4f,            // Shape color RGBA (offset 32) - legacy, use palette instead
  background: vec4f,       // Background color RGBA (offset 48) - legacy, use palette instead
  // Extended palette data (offset 64+)
  paletteCount: u32,       // Number of colors in palette (offset 64)
  _pad0: u32,              // Padding for alignment (offset 68)
  is_p3: u32,              // 1 = Display P3, 0 = sRGB (offset 72)
  _pad2: u32,              // Padding for alignment (offset 76)
  palette: array<vec4f, 16>, // Color palette (offset 80, 256 bytes)
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

// Calculate brightness using color-space-appropriate luminance coefficients
fn luminance(c: vec3f) -> f32 {
  let coeffs = select(vec3f(0.2126, 0.7152, 0.0722), vec3f(0.2290, 0.6917, 0.0793), uniforms.is_p3 != 0u);
  return dot(c, coeffs);
}

// Find the palette color whose luminance best matches the target luminance
// Skips palette[0] (background), searches palette[1..paletteCount]
fn findPaletteColorByLuminance(targetLum: f32) -> vec3f {
  var bestColor = uniforms.palette[1].rgb;
  var bestDist = 1e10;

  for (var i = 1u; i < uniforms.paletteCount; i++) {
    let palColor = uniforms.palette[i].rgb;
    let palLum = luminance(palColor);
    let dist = abs(palLum - targetLum);
    if (dist < bestDist) {
      bestDist = dist;
      bestColor = palColor;
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

// Calculate SDF-based alpha for a shape at given distance
fn calcShapeAlpha(toCenter: vec2f, shapeRadius: f32, shape: u32) -> f32 {
  if (shape == 0u) {
    // Circle: Euclidean distance
    let dist = length(toCenter);
    return smoothstep(shapeRadius + 0.5, shapeRadius - 0.5, dist);
  } else if (shape == 1u) {
    // Square: Chebyshev distance
    let dist = max(abs(toCenter.x), abs(toCenter.y));
    return smoothstep(shapeRadius + 0.5, shapeRadius - 0.5, dist);
  } else {
    // Vertical rectangle: tall and narrow
    let rectWidth = shapeRadius * 0.3;
    let rectHeight = shapeRadius;
    let distX = abs(toCenter.x) - rectWidth;
    let distY = abs(toCenter.y) - rectHeight;
    let dist = max(distX, distY);
    return smoothstep(0.5, -0.5, dist);
  }
}

// Fragment shader - computes melt effect per-pixel
// Checks cells above to see if shapes have dripped into our position
@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let pixelPos = fragCoord.xy;
  let baseCellY = floor(pixelPos.y / uniforms.cellSize);
  let cellX = floor(pixelPos.x / uniforms.cellSize);

  // Track best (highest alpha) shape found
  var bestAlpha: f32 = 0.0;
  var bestColor: vec4f = vec4f(0.0);

  // Max drip is intensity * 2 cells, so check that many cells above
  // Check up to 11 cells above (for intensity up to 5)
  // Using fixed loop count for uniform control flow
  for (var dy: i32 = 0; dy >= -10; dy = dy - 1) {
    let checkCellY = baseCellY + f32(dy);
    let checkCellCenter = vec2f(
      (cellX + 0.5) * uniforms.cellSize,
      (checkCellY + 0.5) * uniforms.cellSize
    );

    // Sample texture at this cell (uniform sampling)
    let sampleUV = checkCellCenter / uniforms.resolution;
    let clampedUV = clamp(sampleUV, vec2f(0.0), vec2f(1.0));
    let sourceColor = textureSample(sourceTexture, sourceSampler, clampedUV);

    // Skip if cell is outside texture bounds
    let isValidCell = sampleUV.y >= 0.0 && sampleUV.y <= 1.0;

    // Calculate brightness
    let luma = luminance(sourceColor.rgb);

    // Calculate how far this cell's shape drips down
    let offY = luma * uniforms.cellSize * 2.0 * uniforms.intensity;
    let meltedCenter = vec2f(checkCellCenter.x, checkCellCenter.y + offY);

    // Calculate shape size
    let maxRadius = uniforms.cellSize * 0.5;
    let shapeRadius = luma * maxRadius * uniforms.scale;

    // Distance from pixel to melted shape center
    let toCenter = pixelPos - meltedCenter;

    // Calculate alpha for this shape
    let alpha = calcShapeAlpha(toCenter, shapeRadius, uniforms.shape);

    // Only use if cell is valid and has better coverage
    let effectiveAlpha = select(0.0, alpha, isValidCell);

    // Keep the shape with highest alpha (front shapes take priority)
    if (effectiveAlpha > bestAlpha) {
      bestAlpha = effectiveAlpha;
      bestColor = sourceColor;
    }
  }

  // Use palette[0] as background
  let bgColor = uniforms.palette[0];

  // Determine shape color based on mode
  var shapeColor: vec4f;
  if (uniforms.preserveColors == 1u) {
    // Preserve original source colors
    shapeColor = bestColor;
  } else if (uniforms.paletteCount > 2u) {
    // Multi-color palette: find the palette color that best matches source luminance
    let sourceLum = luminance(bestColor.rgb);
    let matchedColor = findPaletteColorByLuminance(sourceLum);
    shapeColor = vec4f(matchedColor, 1.0);
  } else {
    // 2-color palette: use palette[1] as foreground
    shapeColor = uniforms.palette[1];
  }

  // Premultiply RGB by alpha for each color
  let bgPremult = bgColor.rgb * bgColor.a;
  let shapePremult = shapeColor.rgb * shapeColor.a;

  // Blend premultiplied colors and alphas based on coverage
  let outRgb = mix(bgPremult, shapePremult, bestAlpha);
  let outAlpha = mix(bgColor.a, shapeColor.a, bestAlpha);

  return vec4f(outRgb, outAlpha);
}
