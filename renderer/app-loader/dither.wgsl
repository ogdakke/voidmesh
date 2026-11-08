// Loader dither pass: one fragment per dither cell. Thresholds the interpolated
// cloud field against an 8×8 Bayer matrix, overlays the pixel-text caption, and
// carves the exit reveal.

struct DitherUniforms {
  ink: vec4f,         // rgb, sRGB
  background: vec4f,  // rgb, sRGB
  viewCenter: vec2f,  // viewport centre, in cells
  fieldSize: vec2f,   // field texture size, in nodes
  textAOrigin: vec2i, // current caption
  textASize: vec2i,
  textBOrigin: vec2i, // next caption, dissolving in over textMix
  textBSize: vec2i,
  step: f32,          // cells per field node
  viewReach: f32,     // centre-to-corner distance, in cells
  reveal: f32,        // 0 = covered, 1 = fully revealed
  textMix: f32,       // 0 = A, 1 = B
  textAmp: f32,       // caption visibility
}

@group(0) @binding(0) var<uniform> u: DitherUniforms;
@group(0) @binding(1) var fieldTexture: texture_2d<f32>;
@group(0) @binding(2) var fieldSampler: sampler;
@group(0) @binding(3) var textA: texture_2d<f32>; // R = glyph, G = outline
@group(0) @binding(4) var textB: texture_2d<f32>;

const REVEAL_BAND = 0.35;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn bayer8(p: vec2i) -> f32 {
  let x = p.x & 7;
  let y = p.y & 7;
  let xy = x ^ y;
  let v = ((xy & 1) << 5u) | ((y & 1) << 4u) | ((xy & 2) << 2u) | ((y & 2) << 1u)
        | ((xy & 4) >> 1u) | ((y & 4) >> 2u);
  return (f32(v) + 0.5) / 64.0;
}

fn textAt(tex: texture_2d<f32>, origin: vec2i, size: vec2i, cell: vec2i) -> vec2f {
  let p = cell - origin;
  if (any(p < vec2i(0)) || any(p >= size)) {
    return vec2f(0.0);
  }
  return textureLoad(tex, p, 0).rg;
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let cell = vec2i(floor(pos.xy));

  // Reveal: a dithered circle opening from the centre. The band uses an offset
  // Bayer lookup so its edge does not lock to the cloud's dither pattern.
  let d = length(vec2f(cell) - u.viewCenter) / u.viewReach;
  let open = clamp((u.reveal * (1.0 + REVEAL_BAND) - d) / REVEAL_BAND, 0.0, 1.0);
  if (open > bayer8(cell + vec2i(3, 5))) {
    return vec4f(0.0);
  }

  // textureSampleLevel, not textureSample: this runs after non-uniform control flow.
  let uv = (vec2f(cell) / u.step + 0.5) / u.fieldSize;
  let value = textureSampleLevel(fieldTexture, fieldSampler, uv, 0.0).r;
  var color = select(u.background.rgb, u.ink.rgb, value > bayer8(cell));

  // Caption: solid white glyphs inside a solid one-cell blue outline. Showing and
  // swapping lines are dithered with offset Bayer lookups.
  if (u.textAmp > bayer8(cell + vec2i(5, 2))) {
    var text = textAt(textA, u.textAOrigin, u.textASize, cell);
    if (u.textMix > bayer8(cell + vec2i(6, 1))) {
      text = textAt(textB, u.textBOrigin, u.textBSize, cell);
    }
    if (text.r > 0.5) {
      color = u.ink.rgb;
    } else if (text.g > 0.5) {
      color = u.background.rgb;
    }
  }
  return vec4f(color, 1.0);
}
