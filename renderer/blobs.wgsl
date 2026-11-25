// Uniform buffer layout (304 bytes, 16-byte aligned)
struct Uniforms {
  resolution: vec2f,       // Canvas dimensions (offset 0)
  scale: f32,              // Shape scale factor 0.1-3.0 (offset 8)
  intensity: f32,          // Brightness curve intensity 0-5 (offset 12)
  cellSize: f32,           // Cell size in pixels (offset 16)
  shape: u32,              // 0 = circle, 1 = square (offset 20)
  preserveColors: u32,     // 0 = false, 1 = true (offset 24)
  eagerness: f32,          // Merge eagerness 0-1 (offset 28)
  paletteCount: u32,       // Number of colors in palette (offset 32)
  _pad0: u32,              // Padding for alignment (offset 36)
  is_p3: u32,              // 1 = Display P3, 0 = sRGB (offset 40)
  _pad2: u32,              // Padding for alignment (offset 44)
  palette: array<vec4f, 16>, // Color palette (offset 48, 256 bytes)
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

// Calculate brightness using color-space-appropriate luminance coefficients
fn luminance(c: vec3f) -> f32 {
  let coeffs = select(vec3f(0.2126, 0.7152, 0.0722), vec3f(0.2290, 0.6917, 0.0793), uniforms.is_p3 != 0u);
  return dot(c, coeffs);
}

fn blobAmount(sourceColor: vec4f) -> f32 {
  let rawBrightness = luminance(sourceColor.rgb);
  let brightness = pow(rawBrightness, max(uniforms.intensity, 0.01));
  let traditionalInk = sourceColor.a * (1.0 - brightness);
  let colorInk = sourceColor.a * brightness;
  return select(traditionalInk, colorInk, uniforms.preserveColors == 1u);
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

// Hexagonal grid: rows are cellSize * sqrt(3)/2 apart and odd rows shift by half a cell,
// so all six nearest neighbours are exactly cellSize apart.
const ROW_HEIGHT_RATIO = 0.8660254;

fn rowOffset(row: i32) -> f32 {
  return f32(row & 1) * 0.5;
}

fn cellCenter(col: i32, row: i32) -> vec2f {
  let rowHeight = uniforms.cellSize * ROW_HEIGHT_RATIO;
  return vec2f(
    (f32(col) + 0.5 + rowOffset(row)) * uniforms.cellSize,
    (f32(row) + 0.5) * rowHeight
  );
}

// Farthest a dot's edge reaches from its centre, relative to its radius.
fn shapeReach() -> f32 {
  if (uniforms.shape == 1u) { return 1.4142136; }
  if (uniforms.shape == 2u) { return 1.0440307; }
  return 1.0;
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

// Fragment shader - metaball-style blobs.
//
// Every dot within reach of the pixel contributes to one field, and the set of dots
// is chosen from the pixel position alone (not from the pixel's own cell). Each dot's
// contribution falls to zero before the reach boundary and the field is a plain sum, so
// the result is continuous across cell borders and independent of evaluation order.
@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let pixelPos = fragCoord.xy;
  let cellSize = uniforms.cellSize;
  let rowHeight = cellSize * ROW_HEIGHT_RATIO;

  let maxRadius = cellSize * 0.75 * uniforms.scale;
  // Width of the merge falloff outside a dot's edge.
  let k = uniforms.eagerness * cellSize * 1.5;
  let merging = k > 0.5;
  // Reach covers every dot whose shape or falloff touches the pixel, plus the nearest
  // centre (at most cellSize / sqrt(3) away) so colour selection always sees it.
  let reach = maxRadius * shapeReach() + max(select(0.0, k, merging), cellSize * 0.6) + 2.0;

  let rowMin = i32(ceil((pixelPos.y - reach) / rowHeight - 0.5));
  let rowMax = i32(floor((pixelPos.y + reach) / rowHeight - 0.5));

  var field = 0.0;
  var minDist = 1e10;
  var closestDist = 1e10;
  var closestColor = vec3f(0.0);
  var closestAlpha = 0.0;

  for (var row = rowMin; row <= rowMax; row++) {
    let offset = rowOffset(row);
    let colMin = i32(ceil((pixelPos.x - reach) / cellSize - 0.5 - offset));
    let colMax = i32(floor((pixelPos.x + reach) / cellSize - 0.5 - offset));
    for (var col = colMin; col <= colMax; col++) {
      let center = cellCenter(col, row);
      let sampleUV = clamp(center / uniforms.resolution, vec2f(0.0), vec2f(1.0));
      let sourceColor = textureSampleLevel(sourceTexture, sourceSampler, sampleUV, 0.0);
      let radius = sqrt(blobAmount(sourceColor)) * maxRadius;
      let dist = sdDot(pixelPos, center, radius);

      // Hard colour selection from the closest dot edge (Voronoi-style, no blending).
      if (dist < closestDist) {
        closestDist = dist;
        closestColor = sourceColor.rgb;
        closestAlpha = sourceColor.a;
      }

      minDist = min(minDist, dist);

      // Falloff width scales with dot size so empty or tiny dots cannot grow blobs
      // out of the background; a lone dot's boundary stays exactly at dist = 0.
      let width = k * saturate(radius / (0.25 * cellSize));
      if (width > 0.0) {
        let t = max(1.0 - dist / width, 0.0);
        field += t * t;
      }
    }
  }

  // Signed coverage: positive inside. Without merging this is the plain union of dots.
  let coverage = select(-minDist, field - 1.0, merging);
  let aa = max(fwidth(coverage), 1e-4);
  let alpha = smoothstep(-aa, aa, coverage);
  // Use palette[0] as background
  let bgColor = uniforms.palette[0];
  let bgAlpha = bgColor.a * smoothstep(0.95, 1.0, closestAlpha);

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
  let bgPremult = bgColor.rgb * bgAlpha;
  let shapePremult = shapeColor.rgb * shapeColor.a;
  let outRgb = mix(bgPremult, shapePremult, alpha);
  let outAlpha = mix(bgAlpha, shapeColor.a, alpha);

  return vec4f(outRgb, outAlpha);
}
