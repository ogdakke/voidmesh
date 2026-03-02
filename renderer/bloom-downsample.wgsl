// Bloom Downsample Shader
// Based on Call of Duty: Advanced Warfare technique (Siggraph 2014)
// 
// This shader performs progressive downsampling using a 13-tap filter pattern
// designed to eliminate pulsating artifacts and temporal stability issues.
// The filter samples 36 texels via bilinear filtering.

struct DownsampleUniforms {
  src_resolution: vec2f,  // Source texture resolution
  mip_level: u32,         // Current mip level (0 = first downsample)
  use_threshold: u32,     // Whether to apply threshold (1 = yes, 0 = no)
  threshold: f32,         // Brightness threshold (0-1)
  soft_knee: f32,         // Soft knee for smooth threshold transition
  is_p3: u32,
  _pad1: f32,
}

@group(0) @binding(0) var<uniform> uniforms: DownsampleUniforms;
@group(0) @binding(1) var src_texture: texture_2d<f32>;
@group(0) @binding(2) var src_sampler: sampler;

// Vertex shader - fullscreen triangle
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  return vec4f(positions[vertex_index], 0.0, 1.0);
}

// Convert to sRGB for luma calculation (Karis average)
fn to_srgb(v: vec3f) -> vec3f {
  return pow(v, vec3f(1.0 / 2.2));
}

// Calculate luminance from RGB using color-space-appropriate coefficients
fn luminance(col: vec3f) -> f32 {
  let coeffs = select(vec3f(0.2126, 0.7152, 0.0722), vec3f(0.2290, 0.6917, 0.0793), uniforms.is_p3 != 0u);
  return dot(col, coeffs);
}

// Karis average - prevents fireflies (overly bright subpixels)
// Formula: 1 / (1 + luma)
fn karis_average(col: vec3f) -> f32 {
  let luma = luminance(to_srgb(col)) * 0.25;
  return 1.0 / (1.0 + luma);
}

// Soft threshold with knee - smoothly transitions around threshold
// This creates a more natural bloom falloff rather than hard cutoff
fn soft_threshold(color: vec3f, threshold: f32, knee: f32) -> vec3f {
  let brightness = max(color.r, max(color.g, color.b));
  
  // Soft knee calculation (from Unity's bloom implementation)
  // knee controls how soft the transition is (0 = hard, 1 = very soft)
  let soft = brightness - threshold + knee;
  let soft_clamped = clamp(soft, 0.0, 2.0 * knee);
  let soft_factor = soft_clamped * soft_clamped / (4.0 * knee + 0.00001);
  
  // Contribution is either from soft knee region or above threshold
  let contribution = max(soft_factor, brightness - threshold);
  let contribution_clamped = max(contribution, 0.0);
  
  // Scale color by contribution factor
  // Avoid division by zero
  if (brightness > 0.0001) {
    return color * (contribution_clamped / brightness);
  }
  return vec3f(0.0);
}

@fragment
fn fs_main(@builtin(position) frag_coord: vec4f) -> @location(0) vec4f {
  let texel_size = 1.0 / uniforms.src_resolution;
  let uv = frag_coord.xy * texel_size * 2.0; // *2 because we're at half resolution
  
  let x = texel_size.x;
  let y = texel_size.y;
  
  // 13-tap sample pattern:
  // a - b - c
  // - j - k -
  // d - e - f
  // - l - m -
  // g - h - i
  // ('e' is the current texel center)
  
  let a = textureSample(src_texture, src_sampler, uv + vec2f(-2.0*x,  2.0*y)).rgb;
  let b = textureSample(src_texture, src_sampler, uv + vec2f( 0.0,    2.0*y)).rgb;
  let c = textureSample(src_texture, src_sampler, uv + vec2f( 2.0*x,  2.0*y)).rgb;
  
  let d = textureSample(src_texture, src_sampler, uv + vec2f(-2.0*x,  0.0)).rgb;
  let e = textureSample(src_texture, src_sampler, uv + vec2f( 0.0,    0.0)).rgb;
  let f = textureSample(src_texture, src_sampler, uv + vec2f( 2.0*x,  0.0)).rgb;
  
  let g = textureSample(src_texture, src_sampler, uv + vec2f(-2.0*x, -2.0*y)).rgb;
  let h = textureSample(src_texture, src_sampler, uv + vec2f( 0.0,   -2.0*y)).rgb;
  let i = textureSample(src_texture, src_sampler, uv + vec2f( 2.0*x, -2.0*y)).rgb;
  
  let j = textureSample(src_texture, src_sampler, uv + vec2f(-x,  y)).rgb;
  let k = textureSample(src_texture, src_sampler, uv + vec2f( x,  y)).rgb;
  let l = textureSample(src_texture, src_sampler, uv + vec2f(-x, -y)).rgb;
  let m = textureSample(src_texture, src_sampler, uv + vec2f( x, -y)).rgb;
  
  var downsample: vec3f;
  
  // Apply weighted distribution:
  // The pattern creates 5 overlapping sample regions:
  // - 4 corner regions (a,b,d,e), (b,c,e,f), (d,e,g,h), (e,f,h,i) each with 0.125 weight
  // - 1 center region (j,k,l,m) with 0.5 weight
  // 
  // To preserve energy with the overlapping samples, weights are adjusted:
  // 0.125*5 + 0.03125*4 + 0.0625*4 = 1.0
  
  if (uniforms.mip_level == 0u) {
    // First mip: Apply threshold extraction and Karis average
    
    // Apply soft threshold to extract bright areas (if enabled)
    var ta = a; var tb = b; var tc = c;
    var td = d; var te = e; var tf = f;
    var tg = g; var th = h; var ti = i;
    var tj = j; var tk = k; var tl = l; var tm = m;
    
    if (uniforms.use_threshold == 1u) {
      let thresh = uniforms.threshold;
      let knee = uniforms.soft_knee;
      ta = soft_threshold(a, thresh, knee);
      tb = soft_threshold(b, thresh, knee);
      tc = soft_threshold(c, thresh, knee);
      td = soft_threshold(d, thresh, knee);
      te = soft_threshold(e, thresh, knee);
      tf = soft_threshold(f, thresh, knee);
      tg = soft_threshold(g, thresh, knee);
      th = soft_threshold(h, thresh, knee);
      ti = soft_threshold(i, thresh, knee);
      tj = soft_threshold(j, thresh, knee);
      tk = soft_threshold(k, thresh, knee);
      tl = soft_threshold(l, thresh, knee);
      tm = soft_threshold(m, thresh, knee);
    }
    
    // Group samples into 5 regions and weight by their Karis factor
    var groups: array<vec3f, 5>;
    groups[0] = (ta + tb + td + te) * (0.125 / 4.0);
    groups[1] = (tb + tc + te + tf) * (0.125 / 4.0);
    groups[2] = (td + te + tg + th) * (0.125 / 4.0);
    groups[3] = (te + tf + th + ti) * (0.125 / 4.0);
    groups[4] = (tj + tk + tl + tm) * (0.5 / 4.0);
    
    groups[0] *= karis_average(groups[0]);
    groups[1] *= karis_average(groups[1]);
    groups[2] *= karis_average(groups[2]);
    groups[3] *= karis_average(groups[3]);
    groups[4] *= karis_average(groups[4]);
    
    downsample = groups[0] + groups[1] + groups[2] + groups[3] + groups[4];
  } else {
    // Subsequent mips: Standard weighted average
    downsample = e * 0.125;
    downsample += (a + c + g + i) * 0.03125;
    downsample += (b + d + f + h) * 0.0625;
    downsample += (j + k + l + m) * 0.125;
  }
  
  // Clamp to small positive value to prevent black box artifacts
  // (multiplications with 0 propagate through the mip chain)
  downsample = max(downsample, vec3f(0.0001));
  
  return vec4f(downsample, 1.0);
}
