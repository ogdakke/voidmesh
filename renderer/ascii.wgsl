// ASCII shader - converts image to ASCII art using MSDF (Multi-channel Signed Distance Field) font atlas
// Renders crisp, scalable characters at any cell size using distance field anti-aliasing

// ============================================================================
// Uniform Buffer Layout (336 bytes, 16-byte aligned)
// ============================================================================

struct Uniforms {
  resolution: vec2f,       // Canvas dimensions (offset 0)
  scale: f32,              // Character scale within cell 0.1-3.0 (offset 8)
  intensity: f32,          // Brightness curve intensity 0-5 (offset 12)
  cellSize: f32,           // Cell size in pixels (offset 16)
  shape: u32,              // Unused for ASCII (offset 20)
  preserveColors: u32,     // 0 = false, 1 = true (offset 24)
  asciiKind: u32,          // Character set: 0=standard, 1=extended, 2=binary, 3=minimal (offset 28)
  color: vec4f,            // Foreground color RGBA (offset 32) - legacy, use palette instead
  background: vec4f,       // Background color RGBA (offset 48) - legacy, use palette instead
  // Extended palette data (offset 64+)
  paletteCount: u32,       // Number of colors in palette (offset 64)
  asciiInvert: u32,        // Invert brightness mapping (offset 68)
  is_p3: u32,              // 1 = Display P3, 0 = sRGB (offset 72)
  _pad2: u32,              // Padding for alignment (offset 76)
  palette: array<vec4f, 16>, // Color palette (offset 80, 256 bytes)
}

// ============================================================================
// Bindings
// ============================================================================

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;
@group(0) @binding(3) var atlasTexture: texture_2d<f32>;
@group(0) @binding(4) var atlasSampler: sampler;

// ============================================================================
// MSDF Atlas Constants
// ============================================================================

// Atlas dimensions (from msdf-atlas-gen output)
const ATLAS_WIDTH: f32 = 264.0;
const ATLAS_HEIGHT: f32 = 318.0;
const ATLAS_COLS: u32 = 8u;
const ATLAS_ROWS: u32 = 6u;
const CELL_WIDTH: f32 = 33.0;
const CELL_HEIGHT: f32 = 53.0;
const DISTANCE_RANGE: f32 = 4.0;  // pxrange used when generating atlas

// Total number of glyphs in the charset
const GLYPH_COUNT: u32 = 49u;

// Glyph positions in the atlas grid (col, row)
// Ordered by visual density (brightness) - space is lightest, dense chars are darkest
// Row 0 = top of texture, Row 5 = bottom of texture
// Space (index 0) has col=-1, row=-1 indicating no glyph to render
const GLYPH_POSITIONS: array<vec2i, 49> = array<vec2i, 49>(
  vec2i(-1, -1), // 0: 'space' (U+0020)
  vec2i(0, 1), // 1: '.' (U+002E)
  vec2i(0, 2), // 2: ':' (U+003A)
  vec2i(7, 0), // 3: '-' (U+002D)
  vec2i(2, 2), // 4: '=' (U+003D)
  vec2i(5, 0), // 5: '+' (U+002B)
  vec2i(4, 0), // 6: '*' (U+002A)
  vec2i(1, 0), // 7: '#' (U+0023)
  vec2i(2, 0), // 8: '%' (U+0025)
  vec2i(3, 2), // 9: '@' (U+0040)
  vec2i(4, 3), // 10: 'I' (U+0049)
  vec2i(7, 3), // 11: 'L' (U+004C)
  vec2i(6, 4), // 12: 'T' (U+0054)
  vec2i(5, 3), // 13: 'J' (U+004A)
  vec2i(3, 5), // 14: 'Y' (U+0059)
  vec2i(6, 2), // 15: 'C' (U+0043)
  vec2i(0, 5), // 16: 'V' (U+0056)
  vec2i(2, 5), // 17: 'X' (U+0058)
  vec2i(4, 5), // 18: 'Z' (U+005A)
  vec2i(1, 3), // 19: 'F' (U+0046)
  vec2i(6, 1), // 20: '7' (U+0037)
  vec2i(5, 4), // 21: 'S' (U+0053)
  vec2i(4, 1), // 22: '3' (U+0033)
  vec2i(0, 3), // 23: 'E' (U+0045)
  vec2i(4, 2), // 24: 'A' (U+0041)
  vec2i(3, 1), // 25: '2' (U+0032)
  vec2i(2, 3), // 26: 'G' (U+0047)
  vec2i(2, 4), // 27: 'P' (U+0050)
  vec2i(6, 3), // 28: 'K' (U+004B)
  vec2i(7, 2), // 29: 'D' (U+0044)
  vec2i(3, 3), // 30: 'H' (U+0048)
  vec2i(7, 4), // 31: 'U' (U+0055)
  vec2i(4, 4), // 32: 'R' (U+0052)
  vec2i(5, 1), // 33: '4' (U+0034)
  vec2i(1, 4), // 34: 'N' (U+004E)
  vec2i(5, 2), // 35: 'B' (U+0042)
  vec2i(7, 1), // 36: '9' (U+0039)
  vec2i(3, 4), // 37: 'Q' (U+0051)
  vec2i(1, 5), // 38: 'W' (U+0057)
  vec2i(0, 4), // 39: 'M' (U+004D)
  vec2i(3, 0), // 40: '&' (U+0026)
  vec2i(1, 1), // 41: '0' (U+0030)
  vec2i(2, 1), // 42: '1' (U+0031)
  vec2i(6, 0), // 43: ',' (U+002C)
  vec2i(1, 2), // 44: ';' (U+003B)
  vec2i(0, 0), // 45: '!' (U+0021)
  vec2i(5, 5), // 46: '^' (U+005E)
  vec2i(7, 5), // 47: '~' (U+007E)
  vec2i(6, 5)  // 48: '_' (U+005F)
);

// ============================================================================
// Character Set Mappings
// ============================================================================

// Standard set: " .:-=+*#%@" (10 levels, indices 0-9)
const STANDARD_COUNT: u32 = 10u;

// Extended set: full charset (49 levels, indices 0-48)
const EXTENDED_COUNT: u32 = 49u;

// Binary set: "0" and "1" (2 levels)
const BINARY_INDICES: array<u32, 2> = array<u32, 2>(41u, 42u); // '0' at index 41, '1' at index 42
const BINARY_COUNT: u32 = 2u;

// Minimal set: " .-+*#" (6 levels)
const MINIMAL_INDICES: array<u32, 6> = array<u32, 6>(0u, 1u, 3u, 5u, 6u, 7u); // space, '.', '-', '+', '*', '#'
const MINIMAL_COUNT: u32 = 6u;

// ============================================================================
// MSDF Helper Functions
// ============================================================================

// Calculate median of three values - core MSDF decoding
fn median(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

// Sample a glyph from the MSDF atlas and return its alpha value
fn sampleGlyph(glyphIndex: u32, cellUV: vec2f, screenPxSize: f32) -> f32 {
  let pos = GLYPH_POSITIONS[glyphIndex];
  
  let col = f32(pos.x);
  let row = f32(pos.y);
  
  // Apply scale to cell UV (centered scaling)
  let scale = uniforms.scale;
  let scaledUV = (cellUV - 0.5) / scale + 0.5;
  
  // Calculate UV coordinates in the atlas texture
  // GLYPH_POSITIONS uses GPU texture coordinates (row 0 = top)
  // No Y flip needed since positions are already in GPU coordinate space
  // Clamp to valid range to avoid sampling outside atlas
  let clampedUV = clamp(scaledUV, vec2f(0.001), vec2f(0.999));
  let atlasUV = vec2f(
    (col * CELL_WIDTH + clampedUV.x * CELL_WIDTH) / ATLAS_WIDTH,
    (row * CELL_HEIGHT + clampedUV.y * CELL_HEIGHT) / ATLAS_HEIGHT
  );
  
  // Sample the MSDF texture
  let msdf = textureSample(atlasTexture, atlasSampler, atlasUV);
  
  // Decode MSDF: take median of RGB channels
  let d = median(msdf.r, msdf.g, msdf.b);
  
  // Calculate screen-space pixel range for anti-aliasing
  // This ensures crisp edges at any scale
  let pxRange = DISTANCE_RANGE * screenPxSize / (CELL_HEIGHT * scale);
  let edgeWidth = 0.5 / max(pxRange, 1.0);
  
  // Apply smoothstep for anti-aliased edge
  let alpha = smoothstep(0.5 - edgeWidth, 0.5 + edgeWidth, d);
  
  // Mask out pixels outside scaled bounds and space character (pos.x < 0)
  let inBounds = scaledUV.x >= 0.0 && scaledUV.x <= 1.0 && scaledUV.y >= 0.0 && scaledUV.y <= 1.0;
  let isValidGlyph = pos.x >= 0;
  
  return select(0.0, alpha, inBounds && isValidGlyph);
}

// ============================================================================
// Character Selection
// ============================================================================

// Get the number of levels for the current character set
fn getLevelCount() -> u32 {
  switch (uniforms.asciiKind) {
    case 0u: { return STANDARD_COUNT; }  // standard
    case 1u: { return EXTENDED_COUNT; }  // extended
    case 2u: { return BINARY_COUNT; }    // binary
    case 3u: { return MINIMAL_COUNT; }   // minimal
    default: { return STANDARD_COUNT; }
  }
}

// Map a brightness level to a glyph index based on the current character set
fn getGlyphIndex(brightness: f32) -> u32 {
  let levelCount = getLevelCount();
  let level = u32(clamp(brightness * f32(levelCount), 0.0, f32(levelCount - 1u)));
  
  switch (uniforms.asciiKind) {
    case 0u: {
      // Standard: indices 0-9 map directly
      return level;
    }
    case 1u: {
      // Extended: indices 0-48 map directly  
      return level;
    }
    case 2u: {
      // Binary: use '0' for dark, '1' for bright
      return BINARY_INDICES[level];
    }
    case 3u: {
      // Minimal: use lookup table
      return MINIMAL_INDICES[level];
    }
    default: {
      return level;
    }
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

// Calculate brightness using color-space-appropriate luminance coefficients
fn luminance(c: vec3f) -> f32 {
  let coeffs = select(vec3f(0.2126, 0.7152, 0.0722), vec3f(0.2290, 0.6917, 0.0793), uniforms.is_p3 != 0u);
  return dot(c, coeffs);
}

// Find the palette color whose luminance best matches the target luminance
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

fn asciiDensity(sourceColor: vec4f) -> f32 {
  let sourceLum = luminance(sourceColor.rgb);
  let alphaOnlyWeight = 1.0 - smoothstep(0.95, 1.0, sourceColor.a);
  let alphaDensity = sourceColor.a * (1.0 - sourceLum) * alphaOnlyWeight;
  return max(sourceLum, alphaDensity);
}

// ============================================================================
// Vertex Shader
// ============================================================================

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  return vec4f(positions[vertexIndex], 0.0, 1.0);
}

// ============================================================================
// Fragment Shader
// ============================================================================

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let pixelPos = fragCoord.xy;
  
  // Calculate effective cell size (cellSize determines sampling resolution)
  let effectiveCellSize = uniforms.cellSize;
  
  // Determine which cell this pixel belongs to
  let cellIndex = floor(pixelPos / effectiveCellSize);
  let cellCenter = (cellIndex + 0.5) * effectiveCellSize;
  
  // Position within the cell (0-1 range)
  let cellUV = fract(pixelPos / effectiveCellSize);
  
  // Sample source texture at cell center
  let sampleUV = cellCenter / uniforms.resolution;
  let clampedUV = clamp(sampleUV, vec2f(0.0), vec2f(1.0));
  let sourceColor = textureSample(sourceTexture, sourceSampler, clampedUV);
  
  // Calculate visible density. RGB luminance handles ordinary image detail; alpha
  // adds coverage for media like shadows encoded as black RGB with varying alpha.
  let rawBrightness = asciiDensity(sourceColor);
  
  // Apply intensity curve (higher intensity = more contrast)
  let brightness = pow(rawBrightness, max(uniforms.intensity, 0.01));
  
  // Apply invert if enabled
  var finalBrightness = brightness;
  if (uniforms.asciiInvert == 1u) {
    finalBrightness = 1.0 - brightness;
  }
  
  // Get the glyph index for this brightness level
  let glyphIndex = getGlyphIndex(finalBrightness);
  
  // Sample the MSDF glyph
  let charAlpha = sampleGlyph(glyphIndex, cellUV, effectiveCellSize);
  
  // Use palette[0] as background
  let bgColor = uniforms.palette[0];
  
  // Determine foreground color based on mode
  var fgColor: vec4f;
  if (uniforms.preserveColors == 1u) {
    // Use original source color
    fgColor = sourceColor;
  } else if (uniforms.paletteCount > 2u) {
    // Multi-color palette: find best match by luminance
    let matchedColor = findPaletteColorByLuminance(luminance(sourceColor.rgb));
    fgColor = vec4f(matchedColor, 1.0);
  } else {
    // 2-color palette: use palette[1] as foreground
    fgColor = uniforms.palette[1];
  }
  
  // Blend foreground and background based on character alpha
  let opaqueSource = smoothstep(0.95, 1.0, sourceColor.a);
  let bgAlpha = bgColor.a * opaqueSource;
  let bgPremult = bgColor.rgb * bgAlpha;
  let fgAlpha = select(fgColor.a * sourceColor.a, sourceColor.a, uniforms.preserveColors == 1u);
  let fgPremult = fgColor.rgb * fgAlpha;
  let outRgb = mix(bgPremult, fgPremult, charAlpha);
  let outAlpha = mix(bgAlpha, fgAlpha, charAlpha);
  
  return vec4f(outRgb, outAlpha);
}
