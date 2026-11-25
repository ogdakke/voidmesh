// Halftone shader: classic single-screen dots plus simulated print screens
// (newsprint, CMYK process rosette, two-ink risograph).
// Uniform buffer layout (304 bytes, 16-byte aligned)
struct Uniforms {
  resolution: vec2f,       // Canvas dimensions (offset 0)
  scale: f32,              // Classic: shape scale 0.1-3.0. Print: entity pixel scale (offset 8)
  intensity: f32,          // Brightness curve intensity 0-5 (offset 12)
  cellSize: f32,           // Cell size in pixels (offset 16)
  shape: u32,              // 0 = circle, 1 = square, 2 = vertical rect (offset 20)
  preserveColors: u32,     // 0 = false, 1 = true (offset 24)
  angle: f32,              // Print: base screen angle in degrees (offset 28)
  paletteCount: u32,       // Number of colors in palette (offset 32)
  kind: u32,               // 0 = classic, 1 = newsprint, 2 = cmyk, 3 = riso (offset 36)
  is_p3: u32,              // 1 = Display P3, 0 = sRGB (offset 40)
  print: u32,              // pack4x8unorm(dotGain, paper, misregistration, 0) (offset 44)
  palette: array<vec4f, 16>, // Color palette (offset 48, 256 bytes)
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

const PI = 3.14159265;
const KIND_CLASSIC = 0u;
const KIND_NEWSPRINT = 1u;
const KIND_CMYK = 2u;
const KIND_RISO = 3u;

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

fn halftoneAmount(sourceColor: vec4f) -> f32 {
  let rawBrightness = luminance(sourceColor.rgb);
  let brightness = applyIntensity(rawBrightness);
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

fn classicHalftone(pixelPos: vec2f) -> vec4f {
  // Determine which cell this pixel belongs to
  let cellIndex = floor(pixelPos / uniforms.cellSize);
  let cellCenter = (cellIndex + 0.5) * uniforms.cellSize;

  // Sample source texture at cell center
  let sampleUV = clamp(cellCenter / uniforms.resolution, vec2f(0.0), vec2f(1.0));
  let sourceColor = textureSampleLevel(sourceTexture, sourceSampler, sampleUV, 0.0);

  // Map brightness to shape radius
  // When preserveColors is true: bright = large dots (to show white/bright colors)
  // When preserveColors is false: dark = large dots (traditional halftone)
  let maxRadius = uniforms.cellSize * 0.5 * uniforms.scale;
  let shapeRadius = halftoneAmount(sourceColor) * maxRadius;

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
  let bgAlpha = bgColor.a * smoothstep(0.95, 1.0, sourceColor.a);

  // Determine shape color based on mode
  var shapeColor: vec4f;
  if (uniforms.preserveColors == 1u) {
    shapeColor = sourceColor;
  } else if (uniforms.paletteCount > 2u) {
    let matchedColor = findPaletteColorByLuminance(luminance(sourceColor.rgb));
    shapeColor = vec4f(matchedColor, 1.0);
  } else {
    shapeColor = uniforms.palette[1];
  }

  // Blend premultiplied colors and alphas based on coverage
  let bgPremult = bgColor.rgb * bgAlpha;
  let shapePremult = shapeColor.rgb * shapeColor.a;
  let outRgb = mix(bgPremult, shapePremult, alpha);
  let outAlpha = mix(bgAlpha, shapeColor.a, alpha);
  return vec4f(outRgb, outAlpha);
}

// ---- Print simulation ----

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn valueNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p: vec2f) -> f32 {
  return valueNoise(p) * 0.5 + valueNoise(p * 2.03 + 17.1) * 0.3 + valueNoise(p * 4.11 + 41.7) * 0.2;
}

fn rotate(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}

fn sourceAt(pixel: vec2f) -> vec4f {
  let uv = clamp(pixel / uniforms.resolution, vec2f(0.0), vec2f(1.0));
  return textureSampleLevel(sourceTexture, sourceSampler, uv, 0.0);
}

// Ink transmittance (solid ink printed on white paper) per kind and plate.
fn inkColor(plate: u32) -> vec3f {
  if (uniforms.kind == KIND_NEWSPRINT) {
    return vec3f(0.12, 0.11, 0.115);
  }
  if (uniforms.kind == KIND_CMYK) {
    var inks = array<vec3f, 4>(
      vec3f(0.0, 0.682, 0.937),   // cyan
      vec3f(0.925, 0.0, 0.549),   // magenta
      vec3f(1.0, 0.949, 0.0),     // yellow
      vec3f(0.137, 0.122, 0.125), // black
    );
    return inks[plate];
  }
  // Riso: fluorescent pink + medium blue
  var riso = array<vec3f, 2>(vec3f(1.0, 0.282, 0.69), vec3f(0.0, 0.47, 0.75));
  return riso[min(plate, 1u)];
}

fn plateCount() -> u32 {
  if (uniforms.kind == KIND_NEWSPRINT) { return 1u; }
  if (uniforms.kind == KIND_CMYK) { return 4u; }
  return 2u;
}

// Screen angle offsets (degrees). CMYK uses the classic C15/M75/Y0/K45 rosette.
fn plateAngle(plate: u32) -> f32 {
  if (uniforms.kind == KIND_NEWSPRINT) { return 45.0; }
  if (uniforms.kind == KIND_CMYK) {
    var angles = array<f32, 4>(15.0, 75.0, 0.0, 45.0);
    return angles[plate];
  }
  var riso = array<f32, 2>(15.0, 75.0);
  return riso[min(plate, 1u)];
}

// Fixed registration error direction per plate, scaled by the misregistration knob.
fn plateShift(plate: u32) -> vec2f {
  var dirs = array<vec2f, 4>(
    vec2f(0.8, -0.35),
    vec2f(-0.55, 0.7),
    vec2f(0.25, 0.9),
    vec2f(0.0, 0.0),
  );
  if (uniforms.kind == KIND_NEWSPRINT) { return vec2f(0.0); }
  if (uniforms.kind == KIND_CMYK) { return dirs[plate]; }
  // Riso drums drift more; keep one plate anchored.
  return select(vec2f(0.0), vec2f(-1.1, 0.75), plate == 1u);
}

// Separate an unpremultiplied colour into plate coverages (0..1).
fn separate(rgbIn: vec3f, alpha: f32) -> vec4f {
  var rgb = clamp(rgbIn, vec3f(0.0), vec3f(1.0));
  if (uniforms.intensity != 1.0) {
    rgb = pow(rgb, vec3f(max(uniforms.intensity, 0.01)));
  }
  if (uniforms.kind == KIND_NEWSPRINT) {
    return vec4f(1.0 - luminance(rgb), 0.0, 0.0, 0.0) * alpha;
  }
  if (uniforms.kind == KIND_CMYK) {
    // Skeleton black (partial GCR) keeps highlights clean and shadows rich.
    let k = 1.0 - max(rgb.r, max(rgb.g, rgb.b));
    let black = clamp((k - 0.25) / 0.75, 0.0, 1.0);
    var cmy = clamp((1.0 - rgb - black) / max(1.0 - black, 1e-3), vec3f(0.0), vec3f(1.0));
    // Total area coverage limit (~280%) like a press profile; shadows lean on black.
    let total = cmy.x + cmy.y + cmy.z;
    cmy *= min(1.0, max(2.8 - black, 0.0) / max(total, 1e-3));
    return vec4f(cmy, black) * alpha;
  }
  // Riso: least-squares fit of two ink densities to the target density.
  let d1 = -log(max(inkColor(0u), vec3f(0.02)));
  let d2 = -log(max(inkColor(1u), vec3f(0.02)));
  let dt = -log(max(rgb, vec3f(0.02)));
  let a11 = dot(d1, d1);
  let a12 = dot(d1, d2);
  let a22 = dot(d2, d2);
  let b1 = dot(d1, dt);
  let b2 = dot(d2, dt);
  let det = max(a11 * a22 - a12 * a12, 1e-4);
  var w = vec2f((b1 * a22 - b2 * a12) / det, (a11 * b2 - a12 * b1) / det);
  // Project negatives onto the single-ink solution.
  if (w.x < 0.0) { w = vec2f(0.0, b2 / a22); }
  if (w.y < 0.0) { w = vec2f(b1 / a11, 0.0); }
  // Density to area coverage for a flat ink (Murray-Davies).
  let cov = clamp(1.0 - exp(-w * 1.6), vec2f(0.0), vec2f(1.0));
  return vec4f(cov, 0.0, 0.0) * alpha;
}

fn plateValue(sep: vec4f, plate: u32) -> f32 {
  var v = array<f32, 4>(sep.x, sep.y, sep.z, sep.w);
  return v[plate];
}

fn unpremultiply(c: vec4f) -> vec3f {
  return c.rgb / max(c.a, 1e-4);
}

// Area-preserving threshold for the cosine spot function:
// the region {spot < c(t)} covers fraction t of the cell.
fn coverageThreshold(t: f32) -> f32 {
  let s = t - 0.5;
  let s2 = s * s;
  return 0.5 + s * (0.54665 + s2 * (2.85036 - 4.29110 * s2));
}

// Ink coverage of one plate at a pixel.
fn plateInk(pixel: vec2f, plate: u32, dotGain: f32, rough: f32, misreg: f32, pixelScale: f32) -> f32 {
  let cell = max(uniforms.cellSize, 1.0);
  let theta = radians(uniforms.angle + plateAngle(plate));
  let shiftScale = select(0.45, 0.9, uniforms.kind == KIND_RISO);
  let shift = plateShift(plate) * misreg * cell * shiftScale;

  // Screen space of this plate (registration error moves the printed plate).
  let q = rotate(pixel - shift, -theta) / cell;

  // Bilinear coverage from the four surrounding screen cells keeps dots
  // continuous across tone changes like a RIP thresholding a soft image.
  let base = floor(q - 0.5);
  let f = q - 0.5 - base;
  let c00 = rotate((base + vec2f(0.5, 0.5)) * cell, theta);
  let c10 = rotate((base + vec2f(1.5, 0.5)) * cell, theta);
  let c01 = rotate((base + vec2f(0.5, 1.5)) * cell, theta);
  let c11 = rotate((base + vec2f(1.5, 1.5)) * cell, theta);
  let s00 = sourceAt(c00);
  let s10 = sourceAt(c10);
  let s01 = sourceAt(c01);
  let s11 = sourceAt(c11);
  let t00 = plateValue(separate(unpremultiply(s00), s00.a), plate);
  let t10 = plateValue(separate(unpremultiply(s10), s10.a), plate);
  let t01 = plateValue(separate(unpremultiply(s01), s01.a), plate);
  let t11 = plateValue(separate(unpremultiply(s11), s11.a), plate);
  var t = mix(mix(t00, t10, f.x), mix(t01, t11, f.x), f.y);

  // Mechanical dot gain peaks in the midtones.
  t = clamp(t + dotGain * 0.9 * t * (1.0 - t), 0.0, 1.0);

  // Cosine spot: round dots in highlights, checkerboard at 50%, round holes in shadows.
  let local = (fract(q) - 0.5) * 2.0;
  let spot = 0.5 - 0.25 * (cos(PI * local.x) + cos(PI * local.y));

  // Paper fibres make dot edges ragged by roughly a pixel, independent of screen size.
  let authored = pixel / pixelScale;
  let edgeNoise = valueNoise(authored * 0.9 + f32(plate) * 31.7) - 0.5;
  let d = spot - coverageThreshold(t) + edgeNoise * rough * (1.6 / cell) * pixelScale;
  let fw = max(fwidth(spot), 1e-4);
  var ink = clamp(0.5 - d / fw, 0.0, 1.0);
  // Keep pure white unprinted and solids solid regardless of edge noise.
  ink = select(ink, 0.0, t <= 0.002);
  ink = select(ink, 1.0, t >= 0.998);
  return ink;
}

fn printHalftone(pixel: vec2f) -> vec4f {
  let knobs = unpack4x8unorm(uniforms.print);
  let dotGain = knobs.x;
  let paper = knobs.y;
  let misreg = knobs.z;
  let pixelScale = max(uniforms.scale, 1e-3);
  let authored = pixel / pixelScale;

  // Paper: clean coated white through to aged newsprint, with fibre texture.
  let paperTint = mix(vec3f(0.975, 0.972, 0.962), vec3f(0.905, 0.875, 0.80), paper);
  let fibre = fbm(authored * vec2f(0.09, 0.35)) - 0.5;
  let speck = smoothstep(0.92, 1.0, valueNoise(authored * 0.6 + 7.3));
  var color = paperTint * (1.0 + fibre * 0.09 * paper) * (1.0 - speck * 0.12 * paper);

  // Ink absorbs unevenly into rougher paper.
  let mottle = fbm(authored * 0.08 + 3.1);
  let rough = 0.4 + paper * 1.6;

  // The plate count depends only on uniforms, so sampling and derivatives stay in uniform control flow.
  let count = plateCount();
  for (var plate = 0u; plate < count; plate++) {
    let ink = plateInk(pixel, plate, dotGain, rough, misreg, pixelScale);
    let density = ink * (1.0 - paper * 0.22 * mottle);
    color *= mix(vec3f(1.0), inkColor(plate), density);
  }

  let alpha = sourceAt(pixel).a;
  return vec4f(color * alpha, alpha);
}

// Fragment shader - computes halftone effect per-pixel
@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  if (uniforms.kind == KIND_CLASSIC) {
    return classicHalftone(fragCoord.xy);
  }
  return printHalftone(fragCoord.xy);
}
