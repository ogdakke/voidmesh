struct Uniforms {
  hue: f32,
  use_p3: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

// Fullscreen triangle (3 vertices cover the entire screen)
@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var out: VertexOutput;
  let x = f32(i32(vi & 1u)) * 4.0 - 1.0;
  let y = f32(i32(vi >> 1u)) * 4.0 - 1.0;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return out;
}

// OKLab ↔ LMS (Björn Ottosson)
fn oklch_to_oklab(l: f32, c: f32, h_deg: f32) -> vec3f {
  let h = h_deg * 3.14159265 / 180.0;
  return vec3f(l, c * cos(h), c * sin(h));
}

fn oklab_to_lms(L: f32, a: f32, b: f32) -> vec3f {
  let l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  let m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  let s_ = L - 0.0894841775 * a - 1.291485548 * b;
  return vec3f(l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
}

// LMS → linear sRGB
fn lms_to_linear_srgb(lms: vec3f) -> vec3f {
  return vec3f(
    4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
    -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
    -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.707614701 * lms.z,
  );
}

// LMS → linear Display-P3
fn lms_to_linear_p3(lms: vec3f) -> vec3f {
  return vec3f(
    3.1277455454 * lms.x - 2.2571357909 * lms.y + 0.1293902455 * lms.z,
    -1.0910086139 * lms.x + 2.0133420547 * lms.y + 0.0776665591 * lms.z,
    -0.0260256887 * lms.x - 0.3541460076 * lms.y + 1.3801716964 * lms.z,
  );
}

// sRGB OETF (linear → gamma)
fn linear_to_gamma(c: f32) -> f32 {
  return select(1.055 * pow(c, 1.0 / 2.4) - 0.055, 12.92 * c, c <= 0.0031308);
}

// Check if OKLCH color is within sRGB gamut
fn is_in_srgb(l: f32, c: f32, h_deg: f32) -> bool {
  let lab = oklch_to_oklab(l, c, h_deg);
  let lms = oklab_to_lms(lab.x, lab.y, lab.z);
  let rgb = lms_to_linear_srgb(lms);
  let lo = min(rgb.x, min(rgb.y, rgb.z));
  let hi = max(rgb.x, max(rgb.y, rgb.z));
  return lo >= 0.0 && hi <= 1.0;
}

// Binary search for the max sRGB chroma at a given lightness and hue
fn srgb_boundary_chroma(l: f32, h_deg: f32) -> f32 {
  var lo = 0.0;
  var hi = 0.37;
  for (var i = 0; i < 16; i++) {
    let mid = (lo + hi) * 0.5;
    if (is_in_srgb(l, mid, h_deg)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) * 0.5;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let l = 1.0 - in.uv.y; // top = lightness 1, bottom = 0
  let c = in.uv.x * 0.37; // left = chroma 0, right = 0.37

  let lab = oklch_to_oklab(l, c, uniforms.hue);
  let lms = oklab_to_lms(lab.x, lab.y, lab.z);

  var rgb_lin: vec3f;
  if (uniforms.use_p3 > 0.5) {
    rgb_lin = lms_to_linear_p3(lms);
  } else {
    rgb_lin = lms_to_linear_srgb(lms);
  }

  // Hard clamp to gamut (no binary search needed for preview)
  rgb_lin = clamp(rgb_lin, vec3f(0.0), vec3f(1.0));

  var rgb = vec3f(
    linear_to_gamma(rgb_lin.x),
    linear_to_gamma(rgb_lin.y),
    linear_to_gamma(rgb_lin.z),
  );

  // sRGB gamut boundary line (P3 mode only)
  if (uniforms.use_p3 > 0.5) {
    let bc = srgb_boundary_chroma(l, uniforms.hue);
    let signed_dist = c - bc;
    let fw = fwidth(signed_dist);
    let line = 1.0 - smoothstep(0.0, fw * 1.5, abs(signed_dist));
    rgb = mix(rgb, vec3f(1.0), line * 0.7);
  }

  return vec4f(rgb, 1.0);
}
