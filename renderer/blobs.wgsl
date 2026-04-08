// Uniform buffer layout (336 bytes, 16-byte aligned)
struct Uniforms {
  resolution: vec2f,       // Canvas dimensions (offset 0)
  scale: f32,              // Shape scale factor 0.1-3.0 (offset 8)
  intensity: f32,          // Brightness curve intensity 0-5 (offset 12)
  cellSize: f32,           // Cell size in pixels (offset 16)
  shape: u32,              // 0 = circle, 1 = square (offset 20)
  preserveColors: u32,     // 0 = false, 1 = true (offset 24)
  eagerness: f32,          // Merge eagerness 0-1 (offset 28)
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

// Polynomial smooth minimum (quadratic variant from iquilezles.org/articles/smin/)
// k controls blend region: higher k = wider blend = more merging
fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

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

// Signed distance to a dot shape (circle, square, or vertical rectangle)
fn sdDot(pos: vec2f, center: vec2f, radius: f32) -> f32 {
  if (uniforms.shape == 0u) {
    // Circle: Euclidean distance
    return length(pos - center) - radius;
  } else if (uniforms.shape == 1u) {
    // Square: box SDF
    let d = abs(pos - center) - vec2f(radius);
    return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
  } else {
    // Vertical rectangle: tall and narrow box SDF
    let rectWidth = radius * 0.3;
    let rectHeight = radius;
    let d = abs(pos - center) - vec2f(rectWidth, rectHeight);
    return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
  }
}

// Get horizontal offset for staggered grid (every other row offset by 0.5)
fn getRowOffset(row: f32) -> f32 {
  return select(0.0, 0.5, u32(row) % 2u == 1u);
}

// Get cell index accounting for stagger offset
// Uses proper hexagonal spacing: rowHeight = cellSize * sqrt(3)/2
// This makes all 6 nearest neighbors exactly cellSize apart
fn getCellIndex(pos: vec2f) -> vec2f {
  let rowHeight = uniforms.cellSize * 0.866;
  let row = floor(pos.y / rowHeight);
  let rowOffset = getRowOffset(row);
  let adjustedX = pos.x - rowOffset * uniforms.cellSize;
  return vec2f(floor(adjustedX / uniforms.cellSize), row);
}

// Get cell center from cell index
fn getCellCenter(cellIdx: vec2f) -> vec2f {
  let rowHeight = uniforms.cellSize * 0.866;
  let rowOffset = getRowOffset(cellIdx.y);
  return vec2f(
    (cellIdx.x + 0.5 + rowOffset) * uniforms.cellSize,
    (cellIdx.y + 0.5) * rowHeight
  );
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

// Fragment shader - computes metaball-style blobs with smooth blending
@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let pixelPos = fragCoord.xy;
  let currentCell = getCellIndex(pixelPos);

  // Max radius with scale applied
  let maxRadius = uniforms.cellSize * 0.75 * uniforms.scale;
  let k = uniforms.eagerness * uniforms.cellSize * 1.5;
  // Conservative influence bound used to skip neighbor cells that cannot affect this pixel.
  let maxInfluence = maxRadius + k + 2.0;
  let neighborReachX = select(1, 2, maxInfluence > uniforms.cellSize * 1.05);
  let neighborReachY = select(1, 2, maxInfluence > (uniforms.cellSize * 0.866) * 1.05);

  let currentCenter = getCellCenter(currentCell);
  let currentSampleUV = clamp(currentCenter / uniforms.resolution, vec2f(0.0), vec2f(1.0));
  let currentColor = textureSampleLevel(sourceTexture, sourceSampler, currentSampleUV, 0.0).rgb;
  let currentRawBrightness = luminance(currentColor);
  let currentBrightness = pow(currentRawBrightness, max(uniforms.intensity, 0.01));
  let currentBrightnessFactor = select(
    1.0 - currentBrightness,
    currentBrightness,
    uniforms.preserveColors == 1u,
  );
  let currentRadius = sqrt(currentBrightnessFactor) * maxRadius;

  // Initialize with current cell's distance
  var minDist = sdDot(pixelPos, currentCenter, currentRadius);

  // Track closest individual dot for hard color selection (Voronoi-style)
  var closestDist = minDist;
  var closestColor = currentColor;

  // Process neighboring cells. We skip cells whose maximum possible influence
  // cannot reach the current pixel, which cuts a lot of unnecessary samples.
  for (var i: u32 = 0u; i < 25u; i++) {
    let dy = i32(i / 5u) - 2;
    let dx = i32(i % 5u) - 2;
    if (dx == 0 && dy == 0) { continue; }
    if (abs(dx) > neighborReachX || abs(dy) > neighborReachY) { continue; }

    let neighborCell = currentCell + vec2f(f32(dx), f32(dy));
    let neighborCenter = getCellCenter(neighborCell);
    if (
      neighborCenter.x < 0.0 || neighborCenter.y < 0.0 ||
      neighborCenter.x > uniforms.resolution.x || neighborCenter.y > uniforms.resolution.y
    ) {
      continue;
    }

    let delta = abs(pixelPos - neighborCenter);
    if (delta.x > maxInfluence || delta.y > maxInfluence) { continue; }

    let sampleUV = clamp(neighborCenter / uniforms.resolution, vec2f(0.0), vec2f(1.0));
    let sourceColor = textureSampleLevel(sourceTexture, sourceSampler, sampleUV, 0.0);
    let rawBrightness = luminance(sourceColor.rgb);
    let brightness = pow(rawBrightness, max(uniforms.intensity, 0.01));
    let brightnessFactor = select(
      1.0 - brightness,
      brightness,
      uniforms.preserveColors == 1u,
    );
    let neighborRadius = sqrt(brightnessFactor) * maxRadius;
    if (neighborRadius <= 0.5) { continue; }
    let neighborColor = sourceColor.rgb;

    let dist = sdDot(pixelPos, neighborCenter, neighborRadius);

    // Track closest individual dot for color (hard selection, no blending)
    if (dist < closestDist) {
      closestDist = dist;
      closestColor = neighborColor;
    }

    // Merge all dots: smin for gooey bridges, min as fallback when eagerness=0
    if (k > 0.001) {
      minDist = smin(minDist, dist, k);
    } else {
      minDist = min(minDist, dist);
    }
  }

  // Anti-aliased alpha from signed distance field (fwidth for pixel-perfect sharpness)
  let aa = fwidth(minDist);
  let alpha = smoothstep(aa, -aa, minDist);

  // Use palette[0] as background
  let bgColor = uniforms.palette[0];

  // Determine shape color — hard selection from closest dot, no blending
  var shapeColor: vec4f;
  if (uniforms.preserveColors == 1u) {
    shapeColor = vec4f(closestColor, 1.0);
  } else if (uniforms.paletteCount > 2u) {
    // Multi-color palette: match palette to closest dot's luminance
    let matchedColor = findPaletteColorByLuminance(luminance(closestColor));
    shapeColor = vec4f(matchedColor, 1.0);
  } else {
    // 2-color palette: use palette[1] as foreground
    shapeColor = uniforms.palette[1];
  }

  // Premultiplied alpha blending
  let bgPremult = bgColor.rgb * bgColor.a;
  let shapePremult = shapeColor.rgb * shapeColor.a;
  let outRgb = mix(bgPremult, shapePremult, alpha);
  let outAlpha = mix(bgColor.a, shapeColor.a, alpha);

  return vec4f(outRgb, outAlpha);
}
