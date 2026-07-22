struct Uniforms {
  resolution: vec2f,
  scale: f32,
  intensity: f32,
  cellSize: f32,
  shape: u32,
  preserveColors: u32,
  kind: u32,
  paletteCount: u32,
  _pad0: u32,
  is_p3: u32,
  _pad2: u32,
  palette: array<vec4f, 16>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;

fn loadAtUV(uv: vec2f) -> vec4f {
  return textureLoad(sourceTexture, vec2u(clamp(uv, vec2f(0.0), vec2f(1.0)) * uniforms.resolution), 0);
}

fn luminance(c: vec3f) -> f32 {
  let coeffs = select(vec3f(0.2126, 0.7152, 0.0722), vec3f(0.2290, 0.6917, 0.0793), uniforms.is_p3 != 0u);
  return dot(c, coeffs);
}

fn hash2(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + vec3f(33.33));
  return fract((p3.x + p3.y) * p3.z);
}

fn hsvToRgb(c: vec3f) -> vec3f {
  var rgb = clamp(abs((fract(c.x + vec3f(0.0, 0.6667, 0.3333)) * 6.0) - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  rgb = rgb * rgb * (3.0 - 2.0 * rgb);
  return c.z * mix(vec3f(1.0), rgb, c.y);
}

fn spectrum(phase: f32, saturation: f32) -> vec3f {
  return hsvToRgb(vec3f(fract(phase), saturation, 1.0));
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  return vec4f(positions[vertexIndex], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = fragCoord.xy / uniforms.resolution;
  let src = textureSample(sourceTexture, sourceSampler, uv);
  let pixel = 1.0 / uniforms.resolution;
  let center = uv - vec2f(0.5);

  let left = textureSample(sourceTexture, sourceSampler, clamp(uv - vec2f(pixel.x, 0.0), vec2f(0.0), vec2f(1.0)));
  let right = textureSample(sourceTexture, sourceSampler, clamp(uv + vec2f(pixel.x, 0.0), vec2f(0.0), vec2f(1.0)));
  let up = textureSample(sourceTexture, sourceSampler, clamp(uv - vec2f(0.0, pixel.y), vec2f(0.0), vec2f(1.0)));
  let down = textureSample(sourceTexture, sourceSampler, clamp(uv + vec2f(0.0, pixel.y), vec2f(0.0), vec2f(1.0)));

  let gx = luminance(right.rgb) - luminance(left.rgb);
  let gy = luminance(down.rgb) - luminance(up.rgb);
  let pseudoNormal = normalize(vec3f(gx * 8.0, gy * 8.0, 1.0));
  let lightDir = normalize(vec3f(-0.35, 0.45, 1.0));
  let facing = clamp(abs(dot(pseudoNormal, vec3f(0.0, 0.0, 1.0))), 0.0, 1.0);
  let fresnel = pow(1.0 - facing, 1.5);
  let specular = pow(max(dot(pseudoNormal, lightDir), 0.0), 5.0);

  let kind = uniforms.kind;
  let sourceLuma = luminance(src.rgb);
  let holoScale = max(16.0, uniforms.cellSize * uniforms.scale * 3.5);
  let cellUv = uv * holoScale;
  let cellId = floor(cellUv);
  let rnd = hash2(cellId);
  let rnd2 = hash2(cellId + vec2f(71.7, 19.3));
  let flake = 0.82 + 0.18 * rnd2;
  let gate = fract(rnd2 * 13.7 + facing * 6.0 + sourceLuma * 2.0);
  let sparkleAmount = select(0.55, 0.25, kind == 2u);
  let glint = smoothstep(1.0 - 0.012 * sparkleAmount, 1.0, gate) * 5.0;
  let radial = length(center) * select(1.6, 4.2, kind == 3u);

  var bandFreq = 3.0;
  var saturation = 0.8;
  var tintStrength = 0.82;
  var phase = facing * bandFreq + radial + rnd * 0.06 + sourceLuma * 0.35;

  if (kind == 1u) {
    bandFreq = 2.4;
    saturation = 0.7;
    tintStrength = 0.62;
    phase = radial * 1.2 + atan2(center.y, center.x) * 0.3 + facing * bandFreq + rnd * 0.04;
  }
  if (kind == 2u) {
    bandFreq = 1.2;
    saturation = 0.38;
    tintStrength = 0.42;
    phase = sourceLuma * 0.45 + dot(pseudoNormal.xy, vec2f(0.2, 0.4)) + rnd * 0.025;
  }
  if (kind == 3u) {
    bandFreq = 4.6;
    saturation = 0.95;
    tintStrength = 0.9;
    phase = length(center) * uniforms.cellSize * 0.32 + atan2(center.y, center.x) * 2.0 + facing * bandFreq + rnd * 0.04;
  }
  if (kind == 4u) {
    bandFreq = 3.8;
    saturation = 0.9;
    tintStrength = 1.0;
    phase = specular * 3.0 + sourceLuma * 0.65 + radial + rnd * 0.08;
  }

  let rainbow = spectrum(phase, saturation);
  let foilEnergy = (0.22 + 0.78 * fresnel) * flake;
  let emissiveHolo = rainbow * uniforms.intensity * (foilEnergy * 0.35 + glint * fresnel * 0.18);
  let tintedFoil = src.rgb * (0.28 + rainbow * 1.8);
  let laminated = mix(src.rgb, tintedFoil + emissiveHolo, clamp(tintStrength * uniforms.intensity * 0.45 + specular * 0.35, 0.0, 0.88));

  return vec4f(laminated * src.a, src.a);
}
