// Loader field pass: the smooth cloud field, evaluated once per field node
// (one node every `step` dither cells) and bilinearly sampled by dither.wgsl.

struct FieldUniforms {
  fieldCenter: vec2f, // cloud centre, in cells
  fieldHalf: vec2f,   // cloud ellipse half-extents, in cells
  lobeScale: vec2f,   // lobe-space scale (keeps lobes round on wide/tall screens)
  step: f32,          // cells per node
  time: f32,          // seconds
  lobes: array<vec4f, 2>, // four lobe centres, packed xy/zw
  radius: f32,        // envelope radius (1 = fills the ellipse)
  amp: f32,           // cloud intensity
}

@group(0) @binding(0) var<uniform> u: FieldUniforms;

const MAX_DENSITY = 0.78;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn lobe(w: vec2f, c: vec2f, s: f32) -> f32 {
  let d = w - c;
  return exp(-dot(d, d) / s);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // Node (i, j) sits on cell (i, j) * step; rows run top-down like the canvas.
  let cell = floor(pos.xy) * u.step;
  let q = (cell - u.fieldCenter) / u.fieldHalf;
  let edge = 1.0 - smoothstep(u.radius * 0.4, u.radius * 1.05, length(q));
  if (edge <= 0.0) {
    return vec4f(0.0);
  }
  let p = q * u.lobeScale;
  let w = p + vec2f(
    0.16 * sin(p.y * 2.6 + u.time * 0.9) + 0.07 * sin(p.y * 5.3 - u.time * 1.4),
    0.16 * sin(p.x * 2.3 - u.time * 0.7) + 0.07 * sin(p.x * 4.9 + u.time * 1.1),
  );
  let v = lobe(w, u.lobes[0].xy, 0.16)
        + 0.85 * lobe(w, u.lobes[0].zw, 0.12)
        + 0.7 * lobe(w, u.lobes[1].xy, 0.09)
        + 0.45 * lobe(w, u.lobes[1].zw, 0.05);
  return vec4f(min(MAX_DENSITY, v * 0.8) * edge * u.amp, 0.0, 0.0, 1.0);
}
