/**
 * WGSL template generators for Anime4K CNN compute layers.
 *
 * Resolution is baked into shaders as constants (buffer index = y * WIDTH + x).
 * This matches the WebSR approach — pipelines must be recreated if resolution changes.
 */

const WORKGROUP_SIZE = 8;

function inputBindings(bufferCount: number, firstIsTexture: boolean): string {
  const lines: string[] = [];
  for (let i = 0; i < bufferCount; i++) {
    if (i === 0 && firstIsTexture) {
      lines.push(`@group(0) @binding(${i}) var inputTexture0: texture_2d<f32>;`);
    } else {
      lines.push(
        `@group(0) @binding(${i}) var<storage, read_write> inputBuffer${i}: array<vec4f>;`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Conv3x4: First layer. Texture input → buffer output.
 * 9 mat4x4f kernels (3x3 spatial, 4-in → 4-out channels) + vec4f bias.
 */
export function generateConv3x4(width: number): string {
  return `
${inputBindings(1, true)}
@group(0) @binding(1) var<uniform> kernel_offsets: array<vec4f, 9>;
@group(0) @binding(2) var<uniform> kernels: array<mat4x4f, 9>;
@group(0) @binding(3) var<uniform> bias: vec4f;
@group(0) @binding(4) var<storage, read_write> outputBuffer: array<vec4f>;

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE}) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x;
  let y = id.y;
  let idx = y * ${width}u + x;
  var result = vec4f(0.0);
  let coord = vec2<i32>(i32(x), i32(y));

  for (var k = 0u; k < 9; k++) {
    let offset = vec2<i32>(kernel_offsets[k].xy);
    result += kernels[k] * textureLoad(inputTexture0, coord + offset, 0);
  }

  result += bias;
  outputBuffer[idx] = result;
}`;
}

/**
 * Conv8x4: Buffer → buffer with dual ReLU.
 * 1 input buffer, 18 mat4x4f kernels (9 positive + 9 negative) + vec4f bias.
 */
export function generateConv8x4(width: number): string {
  return `
${inputBindings(1, false)}
@group(0) @binding(1) var<uniform> kernel_offsets: array<vec4f, 9>;
@group(0) @binding(2) var<uniform> kernels: array<mat4x4f, 18>;
@group(0) @binding(3) var<uniform> bias: vec4f;
@group(0) @binding(4) var<storage, read_write> outputBuffer: array<vec4f>;

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE}) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x;
  let y = id.y;
  let idx = y * ${width}u + x;
  var result = vec4f(0.0);
  let coord = vec2<i32>(i32(x), i32(y));

  for (var k = 0u; k < 9; k++) {
    let pixel_loc = coord + vec2<i32>(kernel_offsets[k].xy);
    let buff_ind = u32(pixel_loc.y) * ${width}u + u32(pixel_loc.x);
    let pix_val = inputBuffer0[buff_ind];

    result += kernels[k] * max(pix_val, vec4f(0.0));
    result += kernels[k + 9] * max(-1.0 * pix_val, vec4f(0.0));
  }

  result += bias;
  outputBuffer[idx] = result;
}`;
}

/**
 * Conv16x4: 2 input buffers → buffer with dual ReLU.
 * 36 mat4x4f kernels (9 pos buf0 + 9 pos buf1 + 9 neg buf0 + 9 neg buf1) + vec4f bias.
 */
export function generateConv16x4(width: number): string {
  return `
${inputBindings(2, false)}
@group(0) @binding(2) var<uniform> kernel_offsets: array<vec4f, 9>;
@group(0) @binding(3) var<uniform> kernels: array<mat4x4f, 36>;
@group(0) @binding(4) var<uniform> bias: vec4f;
@group(0) @binding(5) var<storage, read_write> outputBuffer: array<vec4f>;

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE}) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x;
  let y = id.y;
  let idx = y * ${width}u + x;
  var result = vec4f(0.0);
  let coord = vec2<i32>(i32(x), i32(y));

  for (var k = 0u; k < 9; k++) {
    let pixel_loc = coord + vec2<i32>(kernel_offsets[k].xy);
    let buff_ind = u32(pixel_loc.y) * ${width}u + u32(pixel_loc.x);

    let pix_val0 = inputBuffer0[buff_ind];
    let pix_val1 = inputBuffer1[buff_ind];

    result += kernels[k] * max(pix_val0, vec4f(0.0));
    result += kernels[k + 9] * max(pix_val1, vec4f(0.0));
    result += kernels[k + 18] * max(-1.0 * pix_val0, vec4f(0.0));
    result += kernels[k + 27] * max(-1.0 * pix_val1, vec4f(0.0));
  }

  result += bias;
  outputBuffer[idx] = result;
}`;
}

/**
 * Conv56x4: 7 input buffers → buffer. Element-wise (no spatial conv), dual ReLU.
 * 14 mat4x4f kernels (7 positive + 7 negative) + vec4f bias.
 */
export function generateConv56x4(width: number): string {
  // Generate unrolled buffer reads for all 7 inputs
  let readBuffers = "";
  for (let i = 0; i < 7; i++) {
    readBuffers += `
    let pixel_val${i} = inputBuffer${i}[buff_ind];
    result += kernels[${2 * i}] * max(pixel_val${i}, vec4f(0.0));
    result += kernels[${2 * i + 1}] * max(-1.0 * pixel_val${i}, vec4f(0.0));`;
  }

  return `
${inputBindings(7, false)}
@group(0) @binding(7) var<uniform> kernels: array<mat4x4f, 14>;
@group(0) @binding(8) var<uniform> bias: vec4f;
@group(0) @binding(9) var<storage, read_write> outputBuffer: array<vec4f>;

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE}) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x;
  let y = id.y;
  var result = vec4f(0.0);
  let coord = vec2<i32>(i32(x), i32(y));
  let buff_ind = u32(coord.y) * ${width}u + u32(coord.x);
${readBuffers}

  result += bias;
  outputBuffer[buff_ind] = result;
}`;
}

/**
 * Conv112x4: 7 input buffers → buffer. Split kernel (first/second half), dual ReLU.
 * 28 mat4x4f kernels. `first` selects even/odd kernel indices.
 */
export function generateConv112x4(width: number, first: boolean): string {
  let readBuffers = "";
  for (let i = 0; i < 7; i++) {
    if (first) {
      readBuffers += `
    let pixel_val${i} = inputBuffer${i}[buff_ind];
    result += kernels[${4 * i}] * max(pixel_val${i}, vec4f(0.0));
    result += kernels[${4 * i + 2}] * max(-1.0 * pixel_val${i}, vec4f(0.0));`;
    } else {
      readBuffers += `
    let pixel_val${i} = inputBuffer${i}[buff_ind];
    result += kernels[${4 * i + 1}] * max(pixel_val${i}, vec4f(0.0));
    result += kernels[${4 * i + 3}] * max(-1.0 * pixel_val${i}, vec4f(0.0));`;
    }
  }

  return `
${inputBindings(7, false)}
@group(0) @binding(7) var<uniform> kernels: array<mat4x4f, 28>;
@group(0) @binding(8) var<storage, read_write> outputBuffer: array<vec4f>;

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE}) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x;
  let y = id.y;
  var result = vec4f(0.0);
  let coord = vec2<i32>(i32(x), i32(y));
  let buff_ind = u32(coord.y) * ${width}u + u32(coord.x);
${readBuffers}

  outputBuffer[buff_ind] = result;
}`;
}

/**
 * Concat2: Element-wise addition of 2 buffers + bias.
 */
export function generateConcat2(width: number): string {
  return `
${inputBindings(2, false)}
@group(0) @binding(2) var<uniform> bias: vec4f;
@group(0) @binding(3) var<storage, read_write> outputBuffer: array<vec4f>;

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE}) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x;
  let y = id.y;
  let coord = vec2<i32>(i32(x), i32(y));
  let buff_ind = u32(coord.y) * ${width}u + u32(coord.x);

  outputBuffer[buff_ind] = inputBuffer0[buff_ind] + inputBuffer1[buff_ind] + bias;
}`;
}

/**
 * Display shader: Sub-pixel shuffle + bicubic residual.
 * Reads from 1 or 3 storage buffers + original input texture.
 * Output is 2x the input resolution.
 */
export function generateDisplay(width: number, height: number, channels: 1 | 3): string {
  const vertexShader = `
struct VertexShaderOutput {
  @builtin(position) position: vec4f,
  @location(0) tex_coord: vec2f,
};

@vertex fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexShaderOutput {
  let pos = array(
    vec2f(-1.0, -1.0),
    vec2f(1.0, -1.0),
    vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0),
    vec2f(1.0, -1.0),
    vec2f(1.0, 1.0),
  );

  var output: VertexShaderOutput;
  let xy = pos[vertexIndex];
  output.position = vec4f(xy, 0.0, 1.0);
  output.tex_coord = xy * 0.5 + 0.5;
  output.tex_coord.y = -1.0 * output.tex_coord.y + 1.0;
  return output;
}`;

  if (channels === 1) {
    return `${vertexShader}

@group(0) @binding(0) var<storage, read_write> inputBuffer0: array<vec4f>;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var ourSampler: sampler;

@fragment fn fragmentMain(input: VertexShaderOutput) -> @location(0) vec4f {
  let x = ${width}.0 * input.tex_coord.x;
  let y = ${height}.0 * input.tex_coord.y;

  let y2 = u32(floor(y));
  let x2 = u32(floor(x));
  let i = y2 * ${width}u + x2;

  let x_floor = u32(fract(x) * 2.0);
  let y_floor = u32(fract(y) * 2.0);
  let c_index: u32 = x_floor + y_floor * 2;

  let value = inputBuffer0[i][c_index];
  let bicubic = textureSample(inputTexture, ourSampler, input.tex_coord);

  return bicubic + vec4f(value);
}`;
  }

  // 3-channel display (M and L models)
  return `${vertexShader}

@group(0) @binding(0) var<storage, read_write> inputBuffer0: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> inputBuffer1: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> inputBuffer2: array<vec4f>;
@group(0) @binding(3) var inputTexture: texture_2d<f32>;
@group(0) @binding(4) var ourSampler: sampler;

@fragment fn fragmentMain(input: VertexShaderOutput) -> @location(0) vec4f {
  let x = ${width}.0 * input.tex_coord.x;
  let y = ${height}.0 * input.tex_coord.y;

  let y2 = u32(floor(y));
  let x2 = u32(floor(x));
  let i = y2 * ${width}u + x2;

  let x_floor = u32(fract(x) * 2.0);
  let y_floor = u32(fract(y) * 2.0);
  let c_index: u32 = x_floor + y_floor * 2;

  let value0 = inputBuffer0[i][c_index];
  let value1 = inputBuffer1[i][c_index];
  let value2 = inputBuffer2[i][c_index];

  let bicubic = textureSample(inputTexture, ourSampler, input.tex_coord);

  return bicubic + vec4f(value0, value1, value2, value2);
}`;
}

export { WORKGROUP_SIZE };
