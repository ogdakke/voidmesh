struct Uniforms { resolution: vec2f, scale: f32, intensity: f32, cellSize: f32, shape: u32, preserveColors: u32, kind: u32, paletteCount: u32, _pad0: u32, is_p3: u32, _pad2: u32, palette: array<vec4f, 16>, }
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var sourceSampler: sampler;
fn loadAtUV(uv: vec2f) -> vec4f { return textureLoad(sourceTexture, vec2u(clamp(uv, vec2f(0.0), vec2f(1.0)) * uniforms.resolution), 0); }
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn lum(c: vec3f) -> f32 { let k = select(vec3f(0.2126,0.7152,0.0722), vec3f(0.2290,0.6917,0.0793), uniforms.is_p3 != 0u); return dot(c,k); }
fn noise(p: vec2f) -> f32 { let i=floor(p); let f=fract(p); let u=f*f*(3.0-2.0*f); return mix(mix(hash(i),hash(i+vec2f(1,0)),u.x),mix(hash(i+vec2f(0,1)),hash(i+vec2f(1,1)),u.x),u.y); }
fn ridge(p: vec2f) -> f32 { let n = noise(p)+0.5*noise(p*2.03+8.1)+0.25*noise(p*4.11-3.7); return pow(1.0 - abs(fract(n*3.0)-0.5)*2.0, 5.0); }
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1); }
@fragment fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = fragCoord.xy / uniforms.resolution;
  let aspect = vec2f(uniforms.resolution.x / max(uniforms.resolution.y, 1.0), 1.0);
  let k = uniforms.kind;
  var p = uv * aspect * (uniforms.cellSize * 0.22 + 3.0) * uniforms.scale;
  if (k == 1u) { p = p * mat2x2f(1.2,0.8,-0.7,1.1); }
  if (k == 2u) { p = p * 0.7 + vec2f(0.0, sin(uv.x*8.0)*0.2); }
  if (k == 3u) { p += vec2f(noise(p*0.4), noise(p*0.4+9.0)) * 2.0; }
  let c0 = ridge(p);
  let c1 = ridge(p*1.37 + vec2f(4.2, -1.7));
  let caustic = clamp(c0 * 0.75 + c1 * 0.45, 0.0, 1.0);
  let bend = (vec2f(noise(p+2.0), noise(p-5.0))-0.5) * 0.018 * uniforms.intensity;
  let src = textureSample(sourceTexture, sourceSampler, clamp(uv + bend, vec2f(0.0), vec2f(1.0)));
  var tint = vec3f(0.8, 0.95, 1.0);
  if (k == 1u) { tint = vec3f(1.0, 0.86 + 0.14*sin(caustic*8.0), 0.72 + 0.28*cos(caustic*6.0)); }
  if (k == 2u) { tint = vec3f(0.62, 0.75, 1.0); }
  if (k == 3u) { tint = vec3f(1.0, 0.72 + 0.28*sin(p.x), 0.95 + 0.05*cos(p.y)); }
  let outRgb = src.rgb + tint * caustic * 0.42 * uniforms.intensity * src.a;
  return vec4f(outRgb, src.a);
}
