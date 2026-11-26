// Voidmesh processing passes, all in media pixel space (the processed texture's own pixels).
// One uniform block serves every pass; each entry point reads the fields it needs.
//
//   fs_adjust  source → brightness, contrast, saturation (straight alpha)
//   fs_down    dual-Kawase downsample (blur)
//   fs_up      dual-Kawase upsample (blur)
//   fs_effect  the entity's shader (premultiplied out)
//   fs_bright  bloom's soft-threshold extract (then down/up like the blur)
//   fs_post    chromatic aberration, bloom and grain (premultiplied in and out)
//
// Values are sRGB-encoded, as the web app's canvas textures hold them.

struct P {
  res: vec2f,          // output size of this pass in pixels
  scale: f32,
  intensity: f32,
  cell: f32,           // size × pixel scale
  shape: u32,          // 0 circle, 1 square, 2 vertical rect
  preserve: u32,
  kind: u32,           // effect sub-kind (dither pattern, ascii set, glass kind, glitch kind)
  pcount: u32,
  effect: u32,         // 0 original, 1 halftone, 2 blobs, 3 melt, 4 dithering, 5 ascii, 6 glass, 7 glitch
  flags: u32,          // bit0 ascii invert, bit1 glitch palette quantize
  time: f32,
  x: vec4f,            // effect extras: blobs (eagerness), glass (angle, caustic, frostiness, highlight),
                       // glitch (angle)
  y: vec4f,            // glass (dispersion, flow), bloom (threshold, softness)
  adj: vec4f,          // brightness, contrast, saturation, _
  post: vec4f,         // grain size, grain intensity, chromatic offset, bloom intensity
  blur: vec4f,         // kawase offset, source mip level (adjust pass), source texel size (zw)
  flow: array<vec4f, 3>, // flowing glass: the turbulence octaves' phases (8), the wave drifts (2)
  origin: vec4f,       // this pass's output region in its target (xy); a mip pass's source region (zw)
  k: vec4f,            // render pixels per media pixel (x)
}

var<immediate> u: P;
// The effect's palette: a buffer per palette, made once (`Pipes::palette`).
struct Pal { c: array<vec4f, 16> }
@group(0) @binding(4) var<uniform> pal: Pal;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
// The ASCII glyph atlas in the effect pass, the bloom texture in the post pass.
@group(0) @binding(3) var aux: texture_2d<f32>;

@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn tex(uv: vec2f) -> vec4f {
  return textureSampleLevel(src, smp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
}

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn premul(c: vec4f) -> vec4f {
  return vec4f(c.rgb * c.a, c.a);
}

// ---------------------------------------------------------------- adjustments

fn rgb_to_hsl(c: vec3f) -> vec3f {
  let mx = max(max(c.r, c.g), c.b);
  let mn = min(min(c.r, c.g), c.b);
  let l = (mx + mn) * 0.5;
  if (mx == mn) { return vec3f(0.0, 0.0, l); }
  let d = mx - mn;
  let s = select(d / (mx + mn), d / (2.0 - mx - mn), l > 0.5);
  var h: f32;
  if (mx == c.r) { h = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b); }
  else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  return vec3f(h / 6.0, s, l);
}

fn hue_to_rgb(p: f32, q: f32, t0: f32) -> f32 {
  var t = t0;
  if (t < 0.0) { t += 1.0; }
  if (t > 1.0) { t -= 1.0; }
  if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
  if (t < 0.5) { return q; }
  if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
  return p;
}

fn hsl_to_rgb(h: vec3f) -> vec3f {
  if (h.y == 0.0) { return vec3f(h.z); }
  let q = select(h.z + h.y - h.z * h.y, h.z * (1.0 + h.y), h.z < 0.5);
  let p = 2.0 * h.z - q;
  return vec3f(hue_to_rgb(p, q, h.x + 1.0 / 3.0), hue_to_rgb(p, q, h.x), hue_to_rgb(p, q, h.x - 1.0 / 3.0));
}

@fragment
fn fs_adjust(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let fc = vec4f(at.xy - u.origin.xy, at.zw);
  // The source's mip level for this pass's scale (`blur.y`): a preview LOD smaller than the
  // media reads a filtered level rather than skipping texels.
  let s = textureSampleLevel(src, smp, clamp(fc.xy / u.res, vec2f(0.0), vec2f(1.0)), u.blur.y);
  var c = s.rgb;
  c = clamp(c + (u.adj.x - 0.5) * 2.0, vec3f(0.0), vec3f(1.0));
  c = clamp((c - 0.5) * (u.adj.y * 2.0) + 0.5, vec3f(0.0), vec3f(1.0));
  if (u.adj.z != 0.5) {
    let h = rgb_to_hsl(c);
    c = hsl_to_rgb(vec3f(h.x, clamp(h.y * u.adj.z * 2.0, 0.0, 1.0), h.z));
  }
  return vec4f(c, s.a);
}

// ---------------------------------------------------------------- dual Kawase blur

@fragment
fn fs_down(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let fc = vec4f(at.xy - u.origin.xy, at.zw);
  let uv = fc.xy / u.res;
  let h = u.blur.zw * 0.5 * (1.0 + u.blur.x);
  var sum = tex(uv) * 4.0;
  sum += tex(uv - h);
  sum += tex(uv + h);
  sum += tex(uv + vec2f(h.x, -h.y));
  sum += tex(uv - vec2f(h.x, -h.y));
  return sum / 8.0;
}

@fragment
fn fs_up(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let fc = vec4f(at.xy - u.origin.xy, at.zw);
  let uv = fc.xy / u.res;
  let h = u.blur.zw * 0.5 * (1.0 + u.blur.x);
  var sum = tex(uv + vec2f(-h.x * 2.0, 0.0));
  sum += tex(uv + vec2f(-h.x, h.y)) * 2.0;
  sum += tex(uv + vec2f(0.0, h.y * 2.0));
  sum += tex(uv + vec2f(h.x, h.y)) * 2.0;
  sum += tex(uv + vec2f(h.x * 2.0, 0.0));
  sum += tex(uv + vec2f(h.x, -h.y)) * 2.0;
  sum += tex(uv + vec2f(0.0, -h.y * 2.0));
  sum += tex(uv + vec2f(-h.x, -h.y)) * 2.0;
  return sum / 12.0;
}

// ---------------------------------------------------------------- mip chain

@fragment
fn fs_mip(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let fc = vec4f(at.xy - u.origin.xy, at.zw);
  // Sampling the level above at the centre of this texel's 2×2 block averages it.
  let above = (u.origin.zw + fc.xy * 2.0) / vec2f(textureDimensions(src, 0));
  return textureSampleLevel(src, smp, above, 0.0);
}

// A region of the source (origin.zw, blur.xy texels) box-filtered into this draw's region of the
// target (origin.xy, res): each output pixel the mean of an 8×8 grid of bilinear taps over its
// footprint (`process::shrink`).
@fragment
fn fs_shrink(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(src, 0));
  let r = u.blur.xy / u.res;
  let base = u.origin.zw + (at.xy - u.origin.xy - 0.5) * r;
  let lo = u.origin.zw + 0.5;
  let hi = u.origin.zw + u.blur.xy - 0.5;
  var acc = vec4f(0.0);
  for (var j = 0u; j < 8u; j++) {
    for (var i = 0u; i < 8u; i++) {
      let p = clamp(base + (vec2f(f32(i), f32(j)) + 0.5) / 8.0 * r, lo, hi);
      acc += textureSampleLevel(src, smp, p / dims, 0.0);
    }
  }
  return acc / 64.0;
}

// ---------------------------------------------------------------- bloom extract

@fragment
fn fs_bright(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let fc = vec4f(at.xy - u.origin.xy, at.zw);
  let c = tex(fc.xy / u.res);
  let b = max(max(c.r, c.g), c.b);
  let knee = max(u.y.z * u.y.w, 1e-4);
  var soft = clamp(b - u.y.z + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  let k = max(soft, b - u.y.z) / max(b, 1e-4);
  return vec4f(c.rgb * max(k, 0.0), 0.0);
}

// ---------------------------------------------------------------- shared effect helpers

fn intensity_curve(v: f32) -> f32 {
  if (u.intensity == 1.0) { return v; }
  return pow(max(v, 0.0), max(u.intensity, 0.01));
}

// The palette colour (skipping the background at 0) whose luminance is closest.
fn palette_by_luminance(lum_target: f32) -> vec3f {
  var best = pal.c[1].rgb;
  var bd = 1e10;
  for (var i = 1u; i < u.pcount; i++) {
    let d = abs(luminance(pal.c[i].rgb) - lum_target);
    if (d < bd) { bd = d; best = pal.c[i].rgb; }
  }
  return best;
}

fn palette_nearest(c: vec3f) -> vec3f {
  var best = pal.c[0].rgb;
  var bd = 1e10;
  for (var i = 0u; i < u.pcount; i++) {
    let d = c - pal.c[i].rgb;
    let dd = dot(d, d);
    if (dd < bd) { bd = dd; best = pal.c[i].rgb; }
  }
  return best;
}

// Foreground colour for the halftone-like shaders.
fn shape_color(source: vec4f) -> vec4f {
  if (u.preserve == 1u) { return vec4f(source.rgb, 1.0); }
  if (u.pcount > 2u) { return vec4f(palette_by_luminance(luminance(source.rgb)), 1.0); }
  return pal.c[1];
}

// Background under a shape, then the shape over it with coverage `a` (premultiplied out).
fn over_background(shape: vec4f, a: f32, source_alpha: f32) -> vec4f {
  let bg = pal.c[0];
  let bg_a = bg.a * smoothstep(0.95, 1.0, source_alpha);
  return vec4f(mix(bg.rgb * bg_a, shape.rgb * shape.a, a), mix(bg_a, shape.a, a));
}

fn shape_alpha(d: vec2f, r: f32) -> f32 {
  if (u.shape == 0u) { return smoothstep(r + 0.5, r - 0.5, length(d)); }
  if (u.shape == 1u) { return smoothstep(r + 0.5, r - 0.5, max(abs(d.x), abs(d.y))); }
  return smoothstep(0.5, -0.5, max(abs(d.x) - r * 0.3, abs(d.y) - r));
}

fn cell_center(p: vec2f) -> vec2f {
  return (floor(p / u.cell) + 0.5) * u.cell;
}

// ---------------------------------------------------------------- halftone

fn halftone(p: vec2f) -> vec4f {
  let c = cell_center(p);
  let s = tex(c / u.res);
  let b = intensity_curve(luminance(s.rgb));
  let ink = select(s.a * (1.0 - b), s.a * b, u.preserve == 1u);
  let a = shape_alpha(p - c, ink * u.cell * 0.5 * u.scale);
  var col = shape_color(s);
  if (u.preserve == 1u) { col = s; }
  return over_background(col, a, s.a);
}

// ---------------------------------------------------------------- blobs

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

fn blob_amount(s: vec4f) -> f32 {
  let b = pow(max(luminance(s.rgb), 0.0), max(u.intensity, 0.01));
  return select(s.a * (1.0 - b), s.a * b, u.preserve == 1u);
}

fn sd_dot(p: vec2f, c: vec2f, r: f32) -> f32 {
  if (u.shape == 0u) { return length(p - c) - r; }
  var half = vec2f(r);
  if (u.shape == 2u) { half = vec2f(r * 0.3, r); }
  let d = abs(p - c) - half;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

fn row_offset(row: f32) -> f32 {
  return select(0.0, 0.5, u32(abs(row)) % 2u == 1u);
}

fn hex_cell(p: vec2f) -> vec2f {
  let rh = u.cell * 0.866;
  let row = floor(p.y / rh);
  return vec2f(floor((p.x - row_offset(row) * u.cell) / u.cell), row);
}

fn hex_center(c: vec2f) -> vec2f {
  let rh = u.cell * 0.866;
  return vec2f((c.x + 0.5 + row_offset(c.y)) * u.cell, (c.y + 0.5) * rh);
}

fn blobs(p: vec2f) -> vec4f {
  let cur = hex_cell(p);
  let max_r = u.cell * 0.75 * u.scale;
  let k = u.x.x * u.cell * 1.5;
  let reach = max_r + k + 2.0;
  let rx = select(1, 2, reach > u.cell * 1.05);
  let ry = select(1, 2, reach > u.cell * 0.866 * 1.05);

  let cc = hex_center(cur);
  let cs = tex(cc / u.res);
  var md = sd_dot(p, cc, sqrt(blob_amount(cs)) * max_r);
  var closest = md;
  var color = cs;
  for (var i = 0u; i < 25u; i++) {
    let dy = i32(i / 5u) - 2;
    let dx = i32(i % 5u) - 2;
    if ((dx == 0 && dy == 0) || abs(dx) > rx || abs(dy) > ry) { continue; }
    let nc = hex_center(cur + vec2f(f32(dx), f32(dy)));
    if (nc.x < 0.0 || nc.y < 0.0 || nc.x > u.res.x || nc.y > u.res.y) { continue; }
    let delta = abs(p - nc);
    if (delta.x > reach || delta.y > reach) { continue; }
    let s = tex(nc / u.res);
    let r = sqrt(blob_amount(s)) * max_r;
    if (r <= 0.5) { continue; }
    let d = sd_dot(p, nc, r);
    if (d < closest) { closest = d; color = s; }
    md = select(min(md, d), smin(md, d, k), k > 0.001);
  }
  // One output pixel is one unit here, so a fixed one-pixel ramp anti-aliases the edge.
  let a = smoothstep(0.75, -0.75, md);
  var col = shape_color(color);
  return over_background(col, a, color.a);
}

// ---------------------------------------------------------------- melt

fn density(s: vec4f) -> f32 {
  let l = luminance(s.rgb);
  let alpha_only = 1.0 - smoothstep(0.95, 1.0, s.a);
  return max(l, s.a * (1.0 - l) * alpha_only);
}

fn melt(p: vec2f) -> vec4f {
  let base_y = floor(p.y / u.cell);
  let cx = floor(p.x / u.cell);
  var best_a = 0.0;
  var best = vec4f(0.0);
  for (var dy = 0; dy >= -10; dy--) {
    let c = vec2f((cx + 0.5) * u.cell, (base_y + f32(dy) + 0.5) * u.cell);
    let uv = c / u.res;
    let s = tex(uv);
    let l = density(s);
    let m = vec2f(c.x, c.y + l * u.cell * 2.0 * u.intensity);
    let a = select(0.0, shape_alpha(p - m, l * u.cell * 0.5 * u.scale), uv.y >= 0.0 && uv.y <= 1.0);
    if (a > best_a) { best_a = a; best = s; }
  }
  let base_alpha = tex(p / u.res).a;
  var col = shape_color(best);
  if (u.preserve == 1u) { col = best; }
  return over_background(col, best_a, base_alpha);
}

// ---------------------------------------------------------------- dithering

fn bayer2(p: vec2u) -> f32 {
  let m = array<f32, 4>(0.0, 2.0, 3.0, 1.0);
  return (m[(p.y % 2u) * 2u + p.x % 2u] + 0.5) / 4.0;
}

fn bayer4(p: vec2u) -> f32 {
  let m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[(p.y % 4u) * 4u + p.x % 4u] + 0.5) / 16.0;
}

fn bayer8(p: vec2u) -> f32 {
  let m = array<f32, 64>(
    0.0, 32.0, 8.0, 40.0, 2.0, 34.0, 10.0, 42.0,
    48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
    12.0, 44.0, 4.0, 36.0, 14.0, 46.0, 6.0, 38.0,
    60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
    3.0, 35.0, 11.0, 43.0, 1.0, 33.0, 9.0, 41.0,
    51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
    15.0, 47.0, 7.0, 39.0, 13.0, 45.0, 5.0, 37.0,
    63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0);
  return (m[(p.y % 8u) * 8u + p.x % 8u] + 0.5) / 64.0;
}

fn white_noise(p: vec2u) -> f32 {
  var s = (p.x * 1597334673u) ^ (p.y * 3812015801u);
  s = s * 1664525u + 1013904223u;
  s = s ^ (s >> 16u);
  s = s * 1664525u + 1013904223u;
  return f32(s) / 4294967295.0;
}

fn threshold(p: vec2f) -> f32 {
  let sp = p / max(u.scale, 0.1);
  let ip = vec2u(sp);
  switch (u.kind) {
    case 0u: { return bayer2(ip); }
    case 1u: { return bayer4(ip); }
    case 3u: { return white_noise(ip); }
    case 4u: { let f = floor(sp); return fract(52.9829189 * fract(0.06711056 * f.x + 0.00583715 * f.y)); }
    default: { return bayer8(ip); }
  }
}

fn dithering(p: vec2f) -> vec4f {
  var sp = p;
  if (u.cell > 1.0) { sp = cell_center(p); }
  let s = tex(sp / u.res);
  let t = threshold(p);
  if (u.preserve == 1u) {
    let c = vec3f(intensity_curve(s.r), intensity_curve(s.g), intensity_curve(s.b));
    return premul(vec4f(step(vec3f(t), c), step(t, s.a)));
  }
  let coverage = step(t, s.a);
  if (u.pcount > 2u) {
    let c = vec3f(intensity_curve(s.r), intensity_curve(s.g), intensity_curve(s.b));
    let l = luminance(c);
    var lo = pal.c[0];
    var hi = pal.c[0];
    var lo_l = -0.01;
    var hi_l = 1.01;
    for (var i = 0u; i < u.pcount; i++) {
      let pl = luminance(pal.c[i].rgb);
      if (pl <= l && pl > lo_l) { lo_l = pl; lo = pal.c[i]; }
      if (pl >= l && pl < hi_l) { hi_l = pl; hi = pal.c[i]; }
    }
    var f = 0.0;
    if (hi_l > lo_l) { f = (l - lo_l) / (hi_l - lo_l); }
    let o = mix(lo, hi, step(t, f));
    return premul(vec4f(o.rgb, o.a * coverage));
  }
  let g = intensity_curve(luminance(s.rgb));
  let o = mix(pal.c[0], pal.c[1], step(t, g));
  return premul(vec4f(o.rgb, o.a * coverage));
}

// ---------------------------------------------------------------- ascii (MSDF atlas)

const ATLAS: vec2f = vec2f(264.0, 318.0);
const GLYPH: vec2f = vec2f(33.0, 53.0);
const GLYPHS: array<vec2i, 49> = array<vec2i, 49>(
  vec2i(-1, -1), vec2i(0, 1), vec2i(0, 2), vec2i(7, 0), vec2i(2, 2), vec2i(5, 0), vec2i(4, 0), vec2i(1, 0),
  vec2i(2, 0), vec2i(3, 2), vec2i(4, 3), vec2i(7, 3), vec2i(6, 4), vec2i(5, 3), vec2i(3, 5), vec2i(6, 2),
  vec2i(0, 5), vec2i(2, 5), vec2i(4, 5), vec2i(1, 3), vec2i(6, 1), vec2i(5, 4), vec2i(4, 1), vec2i(0, 3),
  vec2i(4, 2), vec2i(3, 1), vec2i(2, 3), vec2i(2, 4), vec2i(6, 3), vec2i(7, 2), vec2i(3, 3), vec2i(7, 4),
  vec2i(4, 4), vec2i(5, 1), vec2i(1, 4), vec2i(5, 2), vec2i(7, 1), vec2i(3, 4), vec2i(1, 5), vec2i(0, 4),
  vec2i(3, 0), vec2i(1, 1), vec2i(2, 1), vec2i(6, 0), vec2i(1, 2), vec2i(0, 0), vec2i(5, 5), vec2i(7, 5),
  vec2i(6, 5));

fn glyph_index(b: f32) -> u32 {
  var n = 10u;
  if (u.kind == 1u) { n = 49u; } else if (u.kind == 2u) { n = 2u; } else if (u.kind == 3u) { n = 6u; }
  let level = u32(clamp(b * f32(n), 0.0, f32(n - 1u)));
  if (u.kind == 2u) { return 41u + level; }
  if (u.kind == 3u) {
    let m = array<u32, 6>(0u, 1u, 3u, 5u, 6u, 7u);
    return m[level];
  }
  return level;
}

fn median3(r: f32, g: f32, b: f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

fn glyph_alpha(i: u32, cell_uv: vec2f) -> f32 {
  let pos = GLYPHS[i];
  let suv = (cell_uv - 0.5) / u.scale + 0.5;
  let c = clamp(suv, vec2f(0.001), vec2f(0.999));
  let auv = (vec2f(pos) * GLYPH + c * GLYPH) / ATLAS;
  let m = textureSampleLevel(aux, smp, auv, 0.0);
  let d = median3(m.r, m.g, m.b);
  let px = 4.0 * u.cell / (GLYPH.y * u.scale);
  let e = 0.5 / max(px, 1.0);
  let a = smoothstep(0.5 - e, 0.5 + e, d);
  let inside = all(suv >= vec2f(0.0)) && all(suv <= vec2f(1.0)) && pos.x >= 0;
  return select(0.0, a, inside);
}

fn ascii(p: vec2f) -> vec4f {
  let c = cell_center(p);
  let s = tex(c / u.res);
  var b = pow(max(density(s), 0.0), max(u.intensity, 0.01));
  if ((u.flags & 1u) != 0u) { b = 1.0 - b; }
  let a = glyph_alpha(glyph_index(b), fract(p / u.cell));
  var fg = shape_color(s);
  if (u.preserve == 1u) { fg = s; }
  let bg = pal.c[0];
  let bg_a = bg.a * smoothstep(0.95, 1.0, s.a);
  let fg_a = select(fg.a * s.a, s.a, u.preserve == 1u);
  return vec4f(mix(bg.rgb * bg_a, fg.rgb * fg_a, a), mix(bg_a, fg_a, a));
}

// ---------------------------------------------------------------- glass

const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318530;

fn split_sample(uv: vec2f, disp: vec2f) -> vec4f {
  let l = length(disp);
  let dir = select(vec2f(1.0, 0.0), disp / l, l > 1e-6);
  let chroma = dir * u.y.x * u.scale * 0.004;
  let base = tex(uv + disp);
  return vec4f(tex(uv + disp + chroma).r, base.g, tex(uv + disp - chroma).b, base.a);
}

fn glass_fluted(p: vec2f) -> vec4f {
  let uv = p / u.res;
  let ang = u.x.x * PI / 180.0;
  let ca = cos(ang);
  let sa = sin(ang);
  let c = p - u.res * 0.5;
  let freq = TAU / max(u.cell, 1.0);
  let phase = (c.x * ca + c.y * sa) * freq;
  let ridge = cos(phase);
  let edge = tanh(2.0 * sin(phase));
  let refr = -edge * u.intensity * u.scale * 0.015;
  let s = split_sample(uv, vec2f(refr * ca, refr * sa));
  // The caustic from the ridges' slope per media pixel, as the native render has it.
  let jac = 1.0 + 2.0 * cos(phase) * (1.0 - edge * edge) * freq * u.k.x * u.intensity * u.scale * 0.5;
  let caustic = mix(1.0, clamp(1.0 / sqrt(jac * jac + 0.04), 0.7, 5.0), u.x.y);
  let fresnel = pow(1.0 - abs(ridge), 5.0) * 0.003 * u.scale;
  return premul(vec4f(clamp(s.rgb * caustic + fresnel, vec3f(0.0), vec3f(1.0)), s.a));
}

fn hash2(p: vec2f) -> vec2f {
  let k = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(k) * 43758.5453) * 2.0 - 1.0;
}

fn glass_frosted(p: vec2f) -> vec4f {
  let uv = p / u.res;
  let cs = max(u.cell, 1.0);
  let cell = floor(p / cs);
  var d1 = 1e10;
  var d2 = 1e10;
  var nearest = vec2f(0.0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let n = cell + vec2f(f32(dx), f32(dy));
      let pt = (n + 0.5 + hash2(n) * 0.4) * cs;
      let d = distance(p, pt);
      if (d < d1) { d2 = d1; d1 = d; nearest = pt; } else if (d < d2) { d2 = d; }
    }
  }
  let to_c = nearest - p;
  let tl = length(to_c);
  let dir = select(vec2f(0.0), to_c / tl, tl > 0.001);
  let t = clamp(d1 / max((d1 + d2) * 0.5, 1.0), 0.0, 1.0);
  let dome = smoothstep(0.0, 0.45, t) * smoothstep(1.0, 0.45, t);
  let disp = dir * dome * u.intensity * u.scale * 0.02;
  let dl = length(disp);
  let ddir = select(vec2f(1.0, 0.0), disp / dl, dl > 1e-6);
  let chroma = ddir * u.y.x * u.scale * 0.004;
  let frost = u.x.z * cs / max(u.res.x, u.res.y) * 0.5;
  let disk = array<vec2f, 8>(
    vec2f(-0.613, 0.617), vec2f(0.170, -0.040), vec2f(-0.299, -0.615), vec2f(0.729, -0.312),
    vec2f(0.015, 0.453), vec2f(-0.727, 0.087), vec2f(0.409, 0.629), vec2f(0.247, -0.756));
  var acc = vec4f(0.0);
  for (var i = 0u; i < 8u; i++) {
    let o = disk[i] * frost;
    let g = tex(uv + disp + o);
    acc += vec4f(tex(uv + disp + chroma + o).r, g.g, tex(uv + disp - chroma + o).b, g.a);
  }
  let s = acc * 0.125;
  let edge = 1.0 - smoothstep(0.0, cs * 0.03, d2 - d1);
  let hl = edge * u.x.w * 0.12 * luminance(s.rgb);
  let caustic = 1.0 + (1.0 - t * t) * 0.008 * u.scale;
  return premul(vec4f(clamp(s.rgb * caustic + hl, vec3f(0.0), vec3f(1.0)), s.a));
}

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn turbulence(p0: vec2f, time: f32) -> vec2f {
  var p = p0;
  var freq = 2.0;
  var r0 = vec2f(0.6, 0.8);
  var r1 = vec2f(-0.8, 0.6);
  // Each octave's phase (time, index and its drifting offset) is the same for every pixel: the
  // CPU works it out once (`flowing_constants`).
  for (var i = 0u; i < 8u; i++) {
    let ry = r0.y * p.x + r1.y * p.y;
    p += 0.7 * r0 * sin(freq * ry + u.flow[i / 4u][i % 4u]) / freq;
    let n0 = r0 * 0.6 + r1 * 0.8;
    let n1 = r0 * -0.8 + r1 * 0.6;
    r0 = n0;
    r1 = n1;
    freq *= 1.4;
  }
  return p;
}

fn glass_flowing(p: vec2f) -> vec4f {
  let uv = p / u.res;
  // The wave field in media pixels: its slopes set the refraction (in uv) and its curvature
  // the caustics, so worked out per render pixel they'd grow as the preview shrinks.
  let k = u.k.x;
  let wl = max(u.cell, 1.0) / k;
  let freq = TAU / wl;
  let amp = u.scale;
  let flow = u.y.y;
  let time = u.time;
  let pos = turbulence(uv, time) * u.res / k;

  let yf = freq * 0.3;
  let ymod = sin(pos.y * yf) * wl * 0.15 * flow;
  let drift = u.flow[2].x / k;
  let pp = (pos.x + ymod + drift) * freq;
  let ap = time * 0.11 + pos.x * 0.001;
  let am = 1.0 + 0.1 * sin(ap);
  let adx = amp * 0.0001 * cos(ap);
  let pa = amp * am;
  let dpy = cos(pos.y * yf) * yf * wl * 0.15 * flow * freq;
  let d2py = -sin(pos.y * yf) * yf * yf * wl * 0.15 * flow * freq;
  let gx1 = -sin(pp) * pa * freq;
  let gy1 = -sin(pp) * pa * dpy;
  let xx1 = -(cos(pp) * freq * pa + sin(pp) * adx) * freq;
  let yy1 = -pa * (cos(pp) * dpy * dpy + sin(pp) * d2py);

  let f2 = freq * 1.61803398;
  let ymod2 = sin(pos.y * yf * 1.61803398) * wl * 0.08 * flow;
  let drift2 = u.flow[2].y / k;
  let sp = (pos.x + ymod2 + drift2) * f2;
  let sa = amp * 0.35;
  let dsy = cos(pos.y * yf * 1.61803398) * yf * 1.61803398 * wl * 0.08 * flow * f2;
  let d2sy = -sin(pos.y * yf * 1.61803398) * pow(yf * 1.61803398, 2.0) * wl * 0.08 * flow * f2;
  let gx2 = -sin(sp) * sa * f2;
  let gy2 = -sin(sp) * sa * dsy;
  let xx2 = -cos(sp) * sa * f2 * f2;
  let yy2 = -sa * (cos(sp) * dsy * dsy + sin(sp) * d2sy);

  let cp = pos.y * freq * 0.7;
  let ca = amp * 0.2 * flow;
  let gy3 = -sin(cp) * ca * freq * 0.7;
  let yy3 = -cos(cp) * ca * pow(freq * 0.7, 2.0);

  let height = cos(pp) * pa + cos(sp) * sa + cos(cp) * ca;
  let grad = vec2f(gx1 + gx2, gy1 + gy2 + gy3);
  let rs = u.intensity * 0.015;
  let gm = length(grad);
  let gd = select(vec2f(0.0), grad / gm, gm > 1e-6);
  let nf = max(freq * amp, 0.001);
  let disp = -gd * tanh(2.0 * gm / nf) * nf * rs;
  let s = split_sample(uv, disp);
  let jac = (1.0 - (xx1 + xx2) * rs) * (1.0 - (yy1 + yy2 + yy3) * rs);
  let caustic = mix(1.0, clamp(1.0 / sqrt(jac * jac + 0.04), 0.7, 5.0), clamp(u.intensity * 0.3, 0.0, 1.0));
  let nh = abs(height) / max(amp * 1.55, 0.01);
  let fresnel = pow(1.0 - clamp(nh, 0.0, 1.0), 5.0) * 0.005 * amp;
  return premul(vec4f(clamp(s.rgb * caustic + fresnel, vec3f(0.0), vec3f(1.0)), s.a));
}

// ---------------------------------------------------------------- glitch

fn h11(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x *= x + 33.33;
  x *= x + x;
  return fract(x);
}

fn h31(p: vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn h21(p: vec2f) -> f32 {
  return h31(vec3f(p.x, p.y, p.x));
}

fn glitch(p: vec2f) -> vec4f {
  let uv = p / u.res;
  let ang = u.x.x * PI / 180.0;
  let dir = vec2f(cos(ang), sin(ang));
  var c: vec4f;
  if (u.kind == 0u) {
    let shift = u.intensity * u.cell / u.res * dir;
    c = vec4f(tex(uv + shift).r, tex(uv - shift * 0.5).g, tex(uv + shift * 0.3).b, tex(uv).a);
  } else if (u.kind == 1u) {
    let band = floor(uv.y * u.res.y / max(u.cell, 1.0));
    let h = h21(vec2f(band, 0.0));
    let th = 1.0 - u.intensity * 0.6;
    let strength = select(0.0, (h - th) / max(1.0 - th, 0.001), h > th);
    let disp = step(th, h) * (h21(vec2f(band + 100.0, 0.0)) - 0.5) * 2.0 * strength * u.scale * 0.15;
    let jitter = h11(band * 7.31) * 0.002 * u.intensity;
    c = tex(vec2f(uv.x + disp + jitter, uv.y));
  } else if (u.kind == 2u) {
    let bc = floor(uv * u.res / max(u.cell, 1.0));
    let h = h31(vec3f(bc, 0.0));
    let th = 1.0 - u.intensity * 0.4;
    let strength = select(0.0, (h - th) / max(1.0 - th, 0.001), h > th);
    let dh = vec2f(h31(vec3f(bc + 50.0, 0.0)) - 0.5, h31(vec3f(bc + 150.0, 0.0)) - 0.5);
    c = mix(tex(uv), tex(uv + dh * u.scale * 0.3 * strength), strength);
    let chh = h31(vec3f(bc + 250.0, 0.0));
    let swap = step(0.7, chh) * step(th, h);
    let ch = u32(chh * 9.0) % 3u;
    var sw = vec4f(c.b, c.g, c.r, c.a);
    if (ch == 0u) { sw = vec4f(c.g, c.r, c.b, c.a); } else if (ch == 1u) { sw = vec4f(c.r, c.b, c.g, c.a); }
    c = mix(c, sw, swap);
  } else {
    let len = u.cell * u.scale / u.res;
    let s = tex(uv);
    var acc = s.rgb;
    var tw = 1.0;
    for (var i = 1u; i <= 16u; i++) {
      let w = 1.0 - f32(i) / 17.0;
      acc += tex(uv - dir * len / 16.0 * f32(i)).rgb * w;
      tw += w;
    }
    let th = 1.0 - u.intensity * 0.8;
    c = vec4f(mix(s.rgb, acc / tw, smoothstep(th, th + 0.2, luminance(s.rgb))), s.a);
  }
  if ((u.flags & 2u) != 0u && u.pcount >= 2u) {
    c = vec4f(palette_nearest(c.rgb), c.a);
  }
  return premul(c);
}

@fragment
fn fs_effect(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let fc = vec4f(at.xy - u.origin.xy, at.zw);
  let p = fc.xy;
  // EFFECT_ID: `u.effect`, or the one effect a specialised pipeline compiles (`Pipes::effect`).
  switch (EFFECT_ID) {
    case 1u: { return halftone(p); }
    case 2u: { return blobs(p); }
    case 3u: { return melt(p); }
    case 4u: { return dithering(p); }
    case 5u: { return ascii(p); }
    case 6u: {
      if (u.kind == 1u) { return glass_frosted(p); }
      if (u.kind == 2u) { return glass_flowing(p); }
      return glass_fluted(p);
    }
    case 7u: { return glitch(p); }
    default: { return premul(tex(p / u.res)); }
  }
}

// ---------------------------------------------------------------- post-process

fn grain_hash(p: vec2f) -> f32 {
  var q = fract(vec3f(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

@fragment
fn fs_post(@builtin(position) at: vec4f) -> @location(0) vec4f {
  let fc = vec4f(at.xy - u.origin.xy, at.zw);
  let uv = fc.xy / u.res;
  let base = tex(uv);
  var rgb = base.rgb;
  if (u.post.z > 0.0) {
    let to_c = uv - vec2f(0.5);
    let d = length(to_c);
    let dir = select(vec2f(0.0), to_c / d, d > 1e-6);
    let off = u.post.z / u.res * d * 2.0;
    rgb = vec3f(tex(uv + dir * off).r, base.g, tex(uv - dir * off).b);
  }
  if (u.post.w > 0.0) {
    rgb += textureSampleLevel(aux, smp, uv, 0.0).rgb * u.post.w * base.a;
  }
  if (u.post.y > 0.0) {
    let cell = floor(uv * u.res / max(u.post.x, 1.0));
    let n = grain_hash(cell + vec2f(u.time * 100.0, u.time * 73.0));
    rgb += vec3f((n - 0.5) * u.post.y) * base.a;
  }
  return vec4f(clamp(rgb, vec3f(0.0), vec3f(base.a)), base.a);
}
