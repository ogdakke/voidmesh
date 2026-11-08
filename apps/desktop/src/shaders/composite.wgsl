// Canvas drawing at rune effect slots. Prepended with rune's CLIP_WGSL.
//
//   fs_entity  an entity's processed texture (sRGB-encoded, premultiplied), with its selection ring
//   fs_grid    the canvas background: a two-level dot grid that never gets too dense or sparse
//   fs_area    the colour picker's OKLCH area at hue `c.x` (x chroma 0–0.37, y lightness)
//   fs_hue     the picker's hue track
//   fs_alpha   the picker's alpha track: colour `c.yzw` over a checkerboard
//   fs_lens    canvas lensing: the canvas drawn so far (the slot's backdrop) bent at its edges like
//              a thick glass slab, with dispersion, reflection, occlusion and vignette
//   fs_dissolve a deleted entity's last image eaten by a noisy front (deletion dust; the
//              particles are dust.wgsl's), with a faint blue edge

struct Slot {
  rect: vec4f,      // quad x, y, w, h in this pass's pixels
  view: vec4f,      // pass width, height, origin x, origin y (window pixels)
  clip: vec4f,      // the slot's clip rectangle in window pixels
  fade: vec4u,      // the slot's packed soft edges and radii
  a: vec4f,         // entity: ring width px, image inset px (ring), selected, _
                    // dissolve: progress 0–1, seed, _, _
                    // grid: world at window pixel 0 (xy), world units per pixel, device scale
  b: vec4f,         // x: 1 = frame blends in sRGB, y: dark theme
  c: vec4f,         // lens: strength, radius, falloff, dispersion; picker: hue, sRGB colour
  d: vec4f,         // lens: scale, reflection intensity, reflection focus, occlusion
  e: vec4f,         // lens: vignette, _, _, _
}

var<immediate> s: Slot;

@group(0) @binding(0) var img: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;

struct V {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,   // pixels from the quad's top-left
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> V {
  var c = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let px = s.rect.xy + c[i] * s.rect.zw;
  var o: V;
  o.pos = vec4f(px.x / s.view.x * 2.0 - 1.0, 1.0 - px.y / s.view.y * 2.0, 0.0, 1.0);
  o.local = c[i] * s.rect.zw;
  return o;
}

fn to_linear(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

// Premultiplied, sRGB-encoded in; in the frame's encoding out.
fn encode(c: vec4f) -> vec4f {
  if (s.b.x == 0.0 && c.a > 0.0) {
    return vec4f(to_linear(c.rgb / c.a) * c.a, c.a);
  }
  return c;
}

const RING: vec3f = vec3f(0.231, 0.510, 0.965);

@fragment
fn fs_entity(in: V) -> @location(0) vec4f {
  let inset = s.a.y;
  let size = s.rect.zw - 2.0 * inset;
  let p = in.local - inset;
  let uv = p / size;
  // Implicit derivatives pick the mip level for the zoom.
  var c = textureSample(img, smp, clamp(uv, vec2f(0.0), vec2f(1.0)));
  // Coverage of the image rect, antialiased on its edges.
  let d = max(-p, p - size);
  let inside = clamp(0.5 - max(d.x, d.y), 0.0, 1.0);
  c *= inside;
  if (s.a.z > 0.5) {
    // The ring sits outside the image, `a.x` pixels wide.
    let outside = max(d.x, d.y);
    let ring = clamp(outside + 0.5, 0.0, 1.0) * clamp(s.a.x - outside + 0.5, 0.0, 1.0);
    c = c + vec4f(RING, 1.0) * ring * (1.0 - c.a);
  }
  return encode(c) * clip_alpha(in.pos.xy + s.view.zw, s.clip, s.fade);
}

// Must match dust.wgsl's, so particles leave as the front passes.
fn hash21(p: vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453);
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

fn fbmNoise(p: vec2f) -> f32 {
  var value = 0.0;
  var amp = 0.5;
  var pos = p;
  for (var i = 0; i < 3; i++) {
    value += amp * valueNoise(pos);
    pos *= 2.0;
    amp *= 0.5;
  }
  return value;
}

// The web's composition `disintegrate`: an FBM threshold mixed with a mostly horizontal sweep;
// pixels the front (progress × 1.25) has passed are gone, those near it fade and tint blue.
@fragment
fn fs_dissolve(in: V) -> @location(0) vec4f {
  let uv = in.local / s.rect.zw;
  let tex = textureSample(img, smp, clamp(uv, vec2f(0.0), vec2f(1.0)));
  let seed = s.a.y;
  let threshold = mix(fbmNoise(uv * 5.0 + vec2f(seed, seed * 0.7)), uv.x * 0.8 + uv.y * 0.2, 0.35);
  let edge = threshold - s.a.x * 1.25;
  if (edge < 0.0) { discard; }
  let fade = smoothstep(0.0, 0.04, edge);
  let glow = smoothstep(0.06, 0.0, edge);
  // Tint the straight colour, then premultiply again.
  var rgb = select(vec3f(0.0), tex.rgb / tex.a, tex.a > 0.0);
  rgb = vec3f(rgb.r * (1.0 - glow * 0.1), mix(rgb.g, 0.51, glow * 0.1), mix(rgb.b, 1.0, glow * 0.15));
  let a = tex.a * fade;
  return encode(vec4f(rgb * a, a)) * clip_alpha(in.pos.xy + s.view.zw, s.clip, s.fade);
}

fn dots(w: vec2f, spacing: f32, wpp: f32, r: f32) -> f32 {
  let cell = w / spacing;
  let d = (fract(cell + 0.5) - 0.5) * spacing / wpp;
  return smoothstep(r + 0.5, r - 0.5, length(d));
}

@fragment
fn fs_grid(in: V) -> @location(0) vec4f {
  let p = in.pos.xy + s.view.zw;
  let wpp = s.a.z;
  let w = s.a.xy + p * wpp;
  let zoom = 1.0 / wpp;
  let lv = log(zoom) / log(5.0);
  let level = floor(lv);
  let t = lv - level;
  let fine = 25.0 * pow(5.0, -level);
  let r = 1.5 * s.a.w * 0.5;
  let coarse = dots(w, fine * 5.0, wpp, r);
  let minor = dots(w, fine, wpp, r) * pow(t, 5.0);
  let dark = s.b.y > 0.5;
  let bg = select(vec3f(0.98), vec3f(0.023, 0.023, 0.03), dark);
  let dot = select(vec3f(0.75), vec3f(0.15), dark);
  let c = mix(bg, dot, max(coarse, minor));
  return encode(vec4f(c, 1.0)) * clip_alpha(p, s.clip, s.fade);
}

// ---------------------------------------------------------------- lens

fn lens_power(res: vec2f) -> f32 {
  let m = min(res.x, res.y);
  let max_r = min(32.0, m * 0.045);
  let r = clamp(s.c.y * m * 0.5 * 0.18, 8.0, max_r);
  return mix(24.0, 5.0, clamp((r - 8.0) / max(max_r - 8.0, 1.0), 0.0, 1.0));
}

fn se_measure(p: vec2f, half: vec2f, n: f32) -> f32 {
  let q = abs(p) / max(half, vec2f(0.0001));
  return pow(pow(q.x, n) + pow(q.y, n), 1.0 / n);
}

fn se_normal(p: vec2f, half: vec2f, n: f32) -> vec2f {
  let sg = select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0));
  let q = max(abs(p) / max(half, vec2f(0.0001)), vec2f(0.0001));
  // Scale q so its larger side is 1 before raising it to n - 1 (up to 23): near the centre the
  // raw power underflows to zero, and normalising a zero vector is NaN. The direction is the same.
  let r = q / max(q.x, q.y);
  return normalize(sg * pow(r, vec2f(n - 1.0)) / max(half, vec2f(0.0001)));
}

fn edge_mask(p: vec2f, half: vec2f, n: f32) -> f32 {
  let d = clamp(1.0 - se_measure(p, half, n), 0.0, 1.0);
  return pow(1.0 - smoothstep(0.0, s.c.y, d), s.c.z);
}

fn warped(uv: vec2f, aspect: f32, n: f32, offset: f32) -> vec2f {
  let ac = (uv - 0.5) * vec2f(aspect, 1.0);
  let half = vec2f(0.5 * aspect, 0.5);
  let edge = edge_mask(ac, half, n);
  if (edge <= 0.0001) {
    return uv;
  }
  let dir = se_normal(ac, half, n);
  let roll = edge * edge * s.c.x * 0.18;
  let stretch = edge * s.c.x * 0.08;
  let sc = (ac - dir * (roll + offset * edge * 0.0035)) / vec2f(aspect, 1.0);
  return clamp(vec2f(0.5) + sc * (1.0 - stretch * s.d.x), vec2f(0.0), vec2f(1.0));
}

// The canvas uv `uv` as a backdrop texture coordinate.
fn backdrop(uv: vec2f) -> vec4f {
  return textureSampleLevel(img, smp, (s.rect.xy + uv * s.rect.zw) / s.view.xy, 0.0);
}

@fragment
fn fs_lens(in: V) -> @location(0) vec4f {
  let res = s.rect.zw;
  let uv = in.local / res;
  let aspect = res.x / max(res.y, 1.0);
  let n = lens_power(res);
  let fc = (uv - 0.5) * vec2f(aspect, 1.0);
  let half = vec2f(0.5 * aspect, 0.5);
  let edge = edge_mask(fc, half, n);
  let disp = s.c.w * edge;
  let uvg = warped(uv, aspect, n, 0.0);
  let g = backdrop(uvg);
  var color = vec3f(backdrop(warped(uv, aspect, n, disp)).r, g.g, backdrop(warped(uv, aspect, n, -disp)).b);
  color *= 1.0 - edge * s.c.x * s.e.x;

  let n2 = se_normal(fc, half, n);
  let normal = normalize(vec3f(-n2 * edge * s.c.x * 0.75, 1.0));
  let light = normalize(vec3f(-0.38, -0.62, 0.9));
  let inward = clamp((1.0 - se_measure(fc, half, n)) / max(s.c.y, 0.0001), 0.0, 1.0);
  let shadow = 1.0 - max(dot(normal, light), 0.0);
  color *= 1.0 - clamp(s.d.w, 0.0, 1.0) * pow(1.0 - inward, 8.0) * (0.55 + shadow * 0.45) * 0.96;

  let spec = pow(max(dot(normal, light), 0.0), mix(8.0, 96.0, clamp(s.d.z, 0.0, 1.0))) * edge * edge;
  let refl = clamp(s.d.y, 0.0, 1.0) * pow(edge, 2.35) * (0.18 + spec * 0.85);
  let un = n2 / vec2f(aspect, 1.0);
  let near = (g.rgb * 0.55 + backdrop(clamp(uvg - un * edge * 0.075, vec2f(0.0), vec2f(1.0))).rgb * 0.85
    + backdrop(clamp(uvg - un * edge * 0.15, vec2f(0.0), vec2f(1.0))).rgb * 1.1
    + backdrop(clamp(uvg - un * edge * 0.3, vec2f(0.0), vec2f(1.0))).rgb * 0.75) / 3.25;
  let l = dot(near, vec3f(0.2126, 0.7152, 0.0722));
  color += near * refl * (l * 1.45 * (1.0 - smoothstep(0.62, 1.0, l) * 0.42));
  return vec4f(color, 1.0) * clip_alpha(in.pos.xy + s.view.zw, s.clip, s.fade);
}

// ------------------------------------------------------------------ colour picker

fn oklch_linear(l: f32, c: f32, h_deg: f32) -> vec3f {
  let h = radians(h_deg);
  let a = c * cos(h);
  let b = c * sin(h);
  let l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  let m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  let s_ = l - 0.0894841775 * a - 1.291485548 * b;
  let lms = vec3f(l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
  return vec3f(
    4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
    -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
    -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.707614701 * lms.z,
  );
}

fn to_gamma(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, 12.92 * c, c <= vec3f(0.0031308));
}

// An opaque sRGB-encoded colour, clipped to the slot's rounded rect.
fn picker_out(in: V, rgb: vec3f) -> vec4f {
  return encode(vec4f(rgb, 1.0)) * clip_alpha(in.pos.xy + s.view.zw, s.clip, s.fade);
}

@fragment
fn fs_area(in: V) -> @location(0) vec4f {
  let uv = in.local / s.rect.zw;
  let lin = clamp(oklch_linear(1.0 - uv.y, uv.x * 0.37, s.c.x), vec3f(0.0), vec3f(1.0));
  return picker_out(in, to_gamma(lin));
}

@fragment
fn fs_hue(in: V) -> @location(0) vec4f {
  let x = in.local.x / s.rect.z;
  let lin = clamp(oklch_linear(0.75, 0.15, x * 360.0), vec3f(0.0), vec3f(1.0));
  return picker_out(in, to_gamma(lin));
}

@fragment
fn fs_alpha(in: V) -> @location(0) vec4f {
  let x = in.local.x / s.rect.z;
  let cell = floor(in.local / max(s.rect.w * 0.5, 1.0));
  let check = select(0.8, 1.0, (i32(cell.x) + i32(cell.y)) % 2 == 0);
  return picker_out(in, mix(vec3f(check), s.c.yzw, x));
}
