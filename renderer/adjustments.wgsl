// Pre-processing adjustments shader - brightness, contrast, saturation
// Applied to source image/video BEFORE main shader processing
// Uniform buffer layout (32 bytes, 16-byte aligned)
struct Uniforms {
  resolution: vec2f,     // Image dimensions (offset 0)
  brightness: f32,       // 0-1, 0.5 = no change (offset 8)
  contrast: f32,         // 0-1, 0.5 = no change (offset 12)
  saturation: f32,       // 0-1, 0.5 = no change (offset 16)
  _pad0: f32,            // Padding (offset 20)
  _pad1: f32,            // Padding (offset 24)
  _pad2: f32,            // Padding (offset 28)
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

// Convert RGB to HSL
fn rgbToHsl(rgb: vec3f) -> vec3f {
  let maxC = max(max(rgb.r, rgb.g), rgb.b);
  let minC = min(min(rgb.r, rgb.g), rgb.b);
  let l = (maxC + minC) * 0.5;

  if (maxC == minC) {
    return vec3f(0.0, 0.0, l); // achromatic
  }

  let d = maxC - minC;
  let s = select(d / (maxC + minC), d / (2.0 - maxC - minC), l > 0.5);

  var h: f32;
  if (maxC == rgb.r) {
    h = (rgb.g - rgb.b) / d + select(0.0, 6.0, rgb.g < rgb.b);
  } else if (maxC == rgb.g) {
    h = (rgb.b - rgb.r) / d + 2.0;
  } else {
    h = (rgb.r - rgb.g) / d + 4.0;
  }
  h = h / 6.0;

  return vec3f(h, s, l);
}

// Helper for HSL to RGB conversion
fn hueToRgb(p: f32, q: f32, t: f32) -> f32 {
  var tt = t;
  if (tt < 0.0) { tt = tt + 1.0; }
  if (tt > 1.0) { tt = tt - 1.0; }
  if (tt < 1.0 / 6.0) { return p + (q - p) * 6.0 * tt; }
  if (tt < 1.0 / 2.0) { return q; }
  if (tt < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - tt) * 6.0; }
  return p;
}

// Convert HSL to RGB
fn hslToRgb(hsl: vec3f) -> vec3f {
  if (hsl.y == 0.0) {
    return vec3f(hsl.z); // achromatic
  }

  let q = select(hsl.z + hsl.y - hsl.z * hsl.y, hsl.z * (1.0 + hsl.y), hsl.z < 0.5);
  let p = 2.0 * hsl.z - q;

  return vec3f(
    hueToRgb(p, q, hsl.x + 1.0 / 3.0),
    hueToRgb(p, q, hsl.x),
    hueToRgb(p, q, hsl.x - 1.0 / 3.0)
  );
}

// Apply brightness adjustment
// brightness 0 = black, 0.5 = no change, 1 = white
fn applyBrightness(color: vec3f, brightness: f32) -> vec3f {
  // Map 0-1 to -1 to +1 range
  let b = (brightness - 0.5) * 2.0;
  return clamp(color + b, vec3f(0.0), vec3f(1.0));
}

// Apply contrast adjustment
// contrast 0 = gray, 0.5 = no change, 1 = max contrast
fn applyContrast(color: vec3f, contrast: f32) -> vec3f {
  // Map 0-1 to 0-2 range (0.5 maps to 1.0 = no change)
  let c = contrast * 2.0;
  return clamp((color - 0.5) * c + 0.5, vec3f(0.0), vec3f(1.0));
}

// Apply saturation adjustment
// saturation 0 = grayscale, 0.5 = no change, 1 = max saturation
fn applySaturation(color: vec3f, saturation: f32) -> vec3f {
  let hsl = rgbToHsl(color);
  // Map 0-1 to 0-2 range (0.5 maps to 1.0 = no change)
  let s = saturation * 2.0;
  let newS = clamp(hsl.y * s, 0.0, 1.0);
  return hslToRgb(vec3f(hsl.x, newS, hsl.z));
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

// Fragment shader - applies adjustments
@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = fragCoord.xy / uniforms.resolution;
  let sourceColor = textureSample(sourceTexture, sourceSampler, uv);

  // Apply adjustments in order: brightness -> contrast -> saturation
  var color = sourceColor.rgb;
  color = applyBrightness(color, uniforms.brightness);
  color = applyContrast(color, uniforms.contrast);
  color = applySaturation(color, uniforms.saturation);

  return vec4f(color, sourceColor.a);
}
