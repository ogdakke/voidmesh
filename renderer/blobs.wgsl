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
  _pad1: u32,              // Padding for alignment (offset 72)
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

// Calculate brightness using ITU-R BT.601 luminance formula
fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.299, 0.587, 0.114));
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

  // Pre-sample all 25 cells in uniform control flow (5x5 kernel)
  // Expanded from 3x3 to allow dots to extend beyond cell boundaries
  // Each cell stores: rgb = color, w = radius
  var cellData: array<vec4f, 25>;
  var cellCenters: array<vec2f, 25>;
  var cellValid: array<bool, 25>;

  // Max radius with scale applied
  let maxRadius = uniforms.cellSize * 0.75 * uniforms.scale;

  for (var i: u32 = 0u; i < 25u; i++) {
    let dy = i32(i / 5u) - 2;
    let dx = i32(i % 5u) - 2;
    let neighborCell = currentCell + vec2f(f32(dx), f32(dy));

    // Get cell center with stagger offset
    let cellCenter = getCellCenter(neighborCell);
    cellCenters[i] = cellCenter;

    // Check if cell center is within canvas bounds (not just cell index)
    let valid = cellCenter.x >= 0.0 && cellCenter.y >= 0.0 &&
                cellCenter.x <= uniforms.resolution.x && cellCenter.y <= uniforms.resolution.y;
    cellValid[i] = valid;

    // Sample texture (always, to maintain uniform control flow)
    let sampleUV = clamp(cellCenter / uniforms.resolution, vec2f(0.0), vec2f(1.0));
    let sourceColor = textureSample(sourceTexture, sourceSampler, sampleUV);
    // Apply intensity to brightness curve (higher intensity = more contrast)
    let rawBrightness = luminance(sourceColor.rgb);
    let brightness = pow(rawBrightness, max(uniforms.intensity, 0.01));
    // When preserveColors is true: bright = large dots (to show white/bright colors)
    // When preserveColors is false: dark = large dots (traditional halftone)
    let brightnessFactor = select(1.0 - brightness, brightness, uniforms.preserveColors == 1u);
    let shapeRadius = sqrt(brightnessFactor) * maxRadius;

    cellData[i] = vec4f(sourceColor.rgb, shapeRadius);
  }

  // Current cell is at index 12 (center of 5x5 grid)
  let currentColor = cellData[12].rgb;
  let currentRadius = cellData[12].w;
  let currentCenter = cellCenters[12];
  // Compute k for smin based on eagerness (map 0-1 to useful range)
  let k = uniforms.eagerness * uniforms.cellSize * 1.5;

  // Initialize with current cell's distance
  var minDist = sdDot(pixelPos, currentCenter, currentRadius);

  // Track closest individual dot for hard color selection (Voronoi-style)
  var closestDist = minDist;
  var closestColor = currentColor;

  // Process all neighbors — smin merges ALL dots, eagerness controls amount
  for (var i: u32 = 0u; i < 25u; i++) {
    if (i == 12u) { continue; }  // Skip center cell

    let neighborColor = cellData[i].rgb;
    let neighborRadius = cellData[i].w;
    let neighborCenter = cellCenters[i];

    // Skip invalid or zero-radius neighbors
    if (!cellValid[i] || neighborRadius <= 0.5) { continue; }

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
