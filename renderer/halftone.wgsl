// Uniform buffer layout (336 bytes, 16-byte aligned)
struct Uniforms {
  resolution: vec2f,       // Canvas dimensions (offset 0)
  scale: f32,              // Shape scale factor 0.1-3.0 (offset 8)
  intensity: f32,          // Brightness curve intensity 0-5 (offset 12)
  cellSize: f32,           // Cell size in pixels (offset 16)
  shape: u32,              // 0 = circle, 1 = square (offset 20)
  preserveColors: u32,     // 0 = false, 1 = true (offset 24)
  _eagerness: f32,         // Unused - eagerness for blobs (offset 28)
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

fn applyIntensity(value: f32) -> f32 {
  if (uniforms.intensity == 1.0) {
    return value;
  }
  return pow(value, max(uniforms.intensity, 0.01));
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
// More efficient than a quad (3 vertices vs 6, no index buffer)
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  // Positions for a triangle that covers the entire clip space
  // Triangle extends beyond [-1, 1] to ensure full coverage
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  return vec4f(positions[vertexIndex], 0.0, 1.0);
}

// Fragment shader - computes halftone effect per-pixel
@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let pixelPos = fragCoord.xy;

  // Determine which cell this pixel belongs to
  let cellIndex = floor(pixelPos / uniforms.cellSize);
  let cellCenter = (cellIndex + 0.5) * uniforms.cellSize;

  // Sample source texture at cell center
  // Convert pixel coordinates to normalized UV [0, 1]
  let sampleUV = cellCenter / uniforms.resolution;

  // Clamp UV to valid texture coordinates
  let clampedUV = clamp(sampleUV, vec2f(0.0), vec2f(1.0));
  let sourceColor = textureSample(sourceTexture, sourceSampler, clampedUV);

  let rawBrightness = luminance(sourceColor.rgb);

  // Apply intensity to brightness curve (higher intensity = more contrast)
  // Using power curve: intensity > 1 increases contrast, < 1 decreases it
  let brightness = applyIntensity(rawBrightness);

  // Map brightness to shape radius
  // When preserveColors is true: bright = large dots (to show white/bright colors)
  // When preserveColors is false: dark = large dots (traditional halftone)
  let maxRadius = uniforms.cellSize * 0.5 * uniforms.scale;
  let brightnessFactor = select(1.0 - brightness, brightness, uniforms.preserveColors == 1u);
  let shapeRadius = brightnessFactor * maxRadius;

  // Distance from pixel to cell center
  let toCenter = pixelPos - cellCenter;

  // Calculate anti-aliased alpha using signed distance field
  var alpha: f32;
  if (uniforms.shape == 0u) {
    // Circle: smooth edge using Euclidean distance
    let dist = length(toCenter);
    alpha = smoothstep(shapeRadius + 0.5, shapeRadius - 0.5, dist);
  } else if (uniforms.shape == 1u) {
    // Square: smooth edge using Chebyshev distance
    let dist = max(abs(toCenter.x), abs(toCenter.y));
    alpha = smoothstep(shapeRadius + 0.5, shapeRadius - 0.5, dist);
  } else {
    // Vertical rectangle: tall and narrow
    let rectWidth = shapeRadius * 0.3;
    let rectHeight = shapeRadius;
    let distX = abs(toCenter.x) - rectWidth;
    let distY = abs(toCenter.y) - rectHeight;
    let dist = max(distX, distY);
    alpha = smoothstep(0.5, -0.5, dist);
  }

  // For premultiplied alpha canvas, output RGB must be multiplied by alpha
  // Use palette[0] as background
  let bgColor = uniforms.palette[0];

  // Determine shape color based on mode
  var shapeColor: vec4f;
  if (uniforms.preserveColors == 1u) {
    // Preserve original source colors
    shapeColor = sourceColor;
  } else if (uniforms.paletteCount > 2u) {
    // Multi-color palette: find the palette color that best matches source luminance
    let sourceLum = luminance(sourceColor.rgb);
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
  let outRgb = mix(bgPremult, shapePremult, alpha);
  let outAlpha = mix(bgColor.a, shapeColor.a, alpha);

  return vec4f(outRgb, outAlpha);
}
