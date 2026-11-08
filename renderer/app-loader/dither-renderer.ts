/**
 * WebGL2 renderer for the initial loader: a white dither cloud on brand blue that, on
 * exit, opens from the centre in a dithered circle to reveal the app underneath.
 *
 * Two passes keep the GPU cost low:
 *  1. Field pass: the smooth cloud field (the expensive exp/sin math) is evaluated on
 *     a coarse node grid, one fragment per FIELD_STEP × FIELD_STEP cells.
 *  2. Dither pass: one fragment per dither cell bilinearly samples the field and
 *     thresholds it against an 8×8 Bayer matrix, then overlays the caption: pixel
 *     text (see pixel-font.ts) uploaded as a tiny texture only when it changes.
 * The output canvas is sized in cells and upscaled by CSS with
 * `image-rendering: pixelated`, so only the dither pass touches every cell.
 */

/** Cells per field node along each axis; the field is smooth enough to interpolate. */
const FIELD_STEP = 4;

const VERTEX_SHADER = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FIELD_SHADER = /* glsl */ `#version 300 es
precision highp float;

uniform float uStep;       // cells per node
uniform vec2 uFieldCenter; // cloud centre, in cells
uniform vec2 uFieldHalf;   // cloud ellipse half-extents, in cells
uniform vec2 uLobeScale;   // lobe-space scale (keeps lobes round on wide/tall screens)
uniform vec2 uLobes[4];    // lobe centres for this frame
uniform float uTime;       // seconds
uniform float uRadius;     // cloud envelope radius (1 = fills the ellipse)
uniform float uAmp;        // cloud intensity

out vec4 outValue;

const float MAX_DENSITY = 0.78;

float lobe(vec2 w, vec2 c, float s) {
  vec2 d = w - c;
  return exp(-dot(d, d) / s);
}

void main() {
  // Node (i, j) sits on cell (i, j) * uStep; rows run top-down in cell space.
  vec2 cell = floor(gl_FragCoord.xy) * uStep;
  vec2 q = (cell - uFieldCenter) / uFieldHalf;
  float edge = 1.0 - smoothstep(uRadius * 0.4, uRadius * 1.05, length(q));
  if (edge <= 0.0) {
    outValue = vec4(0.0);
    return;
  }
  vec2 p = q * uLobeScale;
  vec2 w = p + vec2(
    0.16 * sin(p.y * 2.6 + uTime * 0.9) + 0.07 * sin(p.y * 5.3 - uTime * 1.4),
    0.16 * sin(p.x * 2.3 - uTime * 0.7) + 0.07 * sin(p.x * 4.9 + uTime * 1.1)
  );
  float v = lobe(w, uLobes[0], 0.16)
          + 0.85 * lobe(w, uLobes[1], 0.12)
          + 0.7 * lobe(w, uLobes[2], 0.09)
          + 0.45 * lobe(w, uLobes[3], 0.05);
  outValue = vec4(min(MAX_DENSITY, v * 0.8) * edge * uAmp, 0.0, 0.0, 1.0);
}`;

const DITHER_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uField;
uniform vec2 uFieldSize;   // field texture size, in nodes
uniform float uStep;       // cells per node
uniform float uRows;
uniform vec2 uViewCenter;  // viewport centre, in cells
uniform float uViewReach;  // centre-to-corner distance, in cells
uniform float uReveal;     // 0 = covered, 1 = fully revealed
uniform vec3 uInk;
uniform vec3 uBackground;
uniform sampler2D uTextA;  // current caption (R = glyph, G = halo)
uniform sampler2D uTextB;  // next caption, dissolving in over uTextMix
uniform ivec2 uTextAOrigin;
uniform ivec2 uTextASize;
uniform ivec2 uTextBOrigin;
uniform ivec2 uTextBSize;
uniform float uTextMix;    // 0 = A, 1 = B
uniform float uTextAmp;    // caption visibility

out vec4 outColor;

const float REVEAL_BAND = 0.35;
// Share of outline cells drawn; a porous outline lets the caption sit inside the cloud.
const float OUTLINE_DENSITY = 1.0;

vec2 textAt(sampler2D tex, ivec2 origin, ivec2 size, ivec2 cell) {
  ivec2 p = cell - origin;
  if (p.x < 0 || p.y < 0 || p.x >= size.x || p.y >= size.y) return vec2(0.0);
  return texelFetch(tex, p, 0).rg;
}

float bayer8(ivec2 p) {
  int x = p.x & 7;
  int y = p.y & 7;
  int xy = x ^ y;
  int v = ((xy & 1) << 5) | ((y & 1) << 4) | ((xy & 2) << 2) | ((y & 2) << 1) | ((xy & 4) >> 1) | ((y & 4) >> 2);
  return (float(v) + 0.5) / 64.0;
}

void main() {
  ivec2 cell = ivec2(int(gl_FragCoord.x), int(uRows - gl_FragCoord.y));

  // Reveal: a dithered circle opening from the centre. The band is thresholded with
  // an offset Bayer lookup so its edge does not lock to the cloud's dither pattern.
  float d = length(vec2(cell) - uViewCenter) / uViewReach;
  float open = clamp((uReveal * (1.0 + REVEAL_BAND) - d) / REVEAL_BAND, 0.0, 1.0);
  if (open > bayer8(cell + ivec2(3, 5))) {
    outColor = vec4(0.0);
    return;
  }

  float value = texture(uField, (vec2(cell) / uStep + 0.5) / uFieldSize).r;
  vec3 color = value > bayer8(cell) ? uInk : uBackground;

  // Caption: solid white glyphs inside a thin, dithered blue outline. The glyphs never
  // change colour (so letters stay whole) while the porous outline lets the line sit
  // inside the cloud. Showing and swapping lines are dithered with offset Bayer lookups.
  if (uTextAmp > bayer8(cell + ivec2(5, 2))) {
    vec2 text = uTextMix > bayer8(cell + ivec2(6, 1))
      ? textAt(uTextB, uTextBOrigin, uTextBSize, cell)
      : textAt(uTextA, uTextAOrigin, uTextASize, cell);
    if (text.r > 0.5) color = uInk;
    else if (text.g > 0.5 && OUTLINE_DENSITY > bayer8(cell + ivec2(1, 4))) color = uBackground;
  }
  outColor = vec4(color, 1.0);
}`;

type Rgb = readonly [number, number, number];

/** Caption bitmap in cells: RG8, R = glyph, G = halo. */
export interface CaptionBitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface DitherFrame {
  fieldCenter: readonly [number, number];
  fieldHalf: readonly [number, number];
  lobeScale: readonly [number, number];
  lobes: Float32Array;
  time: number;
  radius: number;
  amp: number;
  viewCenter: readonly [number, number];
  viewReach: number;
  reveal: number;
  /** Display-P3, 0–1. */
  ink: Rgb;
  /** Display-P3, 0–1. */
  background: Rgb;
  /** Caption centre, in cells. */
  textCenter: readonly [number, number];
  /** 0 = current caption, 1 = next caption. */
  textMix: number;
  textAmp: number;
}

const FIELD_UNIFORMS = [
  "uStep",
  "uFieldCenter",
  "uFieldHalf",
  "uLobeScale",
  "uLobes",
  "uTime",
  "uRadius",
  "uAmp",
] as const;

const DITHER_UNIFORMS = [
  "uField",
  "uFieldSize",
  "uStep",
  "uRows",
  "uViewCenter",
  "uViewReach",
  "uReveal",
  "uInk",
  "uBackground",
  "uTextA",
  "uTextB",
  "uTextAOrigin",
  "uTextASize",
  "uTextBOrigin",
  "uTextBSize",
  "uTextMix",
  "uTextAmp",
] as const;

interface CaptionSlot {
  texture: WebGLTexture;
  width: number;
  height: number;
}

type Uniforms<T extends readonly string[]> = Record<T[number], WebGLUniformLocation | null>;

export class LoaderDitherRenderer {
  #gl: WebGL2RenderingContext;
  #fieldProgram: WebGLProgram;
  #ditherProgram: WebGLProgram;
  #fieldUniforms: Uniforms<typeof FIELD_UNIFORMS>;
  #ditherUniforms: Uniforms<typeof DITHER_UNIFORMS>;
  #vao: WebGLVertexArrayObject;
  #fieldTexture: WebGLTexture;
  #fieldFramebuffer: WebGLFramebuffer;
  #cols = 0;
  #rows = 0;
  #fieldCols = 0;
  #fieldRows = 0;
  #textA: CaptionSlot;
  #textB: CaptionSlot;

  constructor(canvas: OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    if (!gl) throw new Error("Loader dither renderer requires WebGL2");
    gl.drawingBufferColorSpace = "display-p3";
    this.#gl = gl;
    this.#fieldProgram = linkProgram(gl, VERTEX_SHADER, FIELD_SHADER);
    this.#ditherProgram = linkProgram(gl, VERTEX_SHADER, DITHER_SHADER);
    this.#fieldUniforms = locate(gl, this.#fieldProgram, FIELD_UNIFORMS);
    this.#ditherUniforms = locate(gl, this.#ditherProgram, DITHER_UNIFORMS);
    this.#vao = gl.createVertexArray();

    this.#fieldTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.#fieldTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.#fieldFramebuffer = gl.createFramebuffer();
    this.#textA = createCaptionSlot(gl);
    this.#textB = createCaptionSlot(gl);
  }

  /** Uploads the caption that dissolves in next (the B slot). */
  setNextCaption(bitmap: CaptionBitmap) {
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.#textB.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RG8,
      bitmap.width,
      bitmap.height,
      0,
      gl.RG,
      gl.UNSIGNED_BYTE,
      bitmap.data,
    );
    this.#textB.width = bitmap.width;
    this.#textB.height = bitmap.height;
  }

  /** Promotes the next caption to current once its dissolve completes. */
  commitCaption() {
    [this.#textA, this.#textB] = [this.#textB, this.#textA];
  }

  resize(cols: number, rows: number) {
    const gl = this.#gl;
    gl.canvas.width = cols;
    gl.canvas.height = rows;
    this.#cols = cols;
    this.#rows = rows;
    // One extra node so the last cells interpolate towards a real sample.
    this.#fieldCols = Math.ceil(cols / FIELD_STEP) + 1;
    this.#fieldRows = Math.ceil(rows / FIELD_STEP) + 1;
    gl.bindTexture(gl.TEXTURE_2D, this.#fieldTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      this.#fieldCols,
      this.#fieldRows,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fieldFramebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.#fieldTexture,
      0,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  draw(frame: DitherFrame) {
    const gl = this.#gl;
    gl.bindVertexArray(this.#vao);

    // Pass 1: coarse cloud field.
    const f = this.#fieldUniforms;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fieldFramebuffer);
    gl.viewport(0, 0, this.#fieldCols, this.#fieldRows);
    gl.useProgram(this.#fieldProgram);
    gl.uniform1f(f.uStep, FIELD_STEP);
    gl.uniform2f(f.uFieldCenter, frame.fieldCenter[0], frame.fieldCenter[1]);
    gl.uniform2f(f.uFieldHalf, frame.fieldHalf[0], frame.fieldHalf[1]);
    gl.uniform2f(f.uLobeScale, frame.lobeScale[0], frame.lobeScale[1]);
    gl.uniform2fv(f.uLobes, frame.lobes);
    gl.uniform1f(f.uTime, frame.time);
    gl.uniform1f(f.uRadius, frame.radius);
    gl.uniform1f(f.uAmp, frame.amp);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 2: per-cell dither + reveal into the canvas.
    const d = this.#ditherUniforms;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.#cols, this.#rows);
    gl.useProgram(this.#ditherProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#fieldTexture);
    gl.uniform1i(d.uField, 0);
    gl.uniform2f(d.uFieldSize, this.#fieldCols, this.#fieldRows);
    gl.uniform1f(d.uStep, FIELD_STEP);
    gl.uniform1f(d.uRows, this.#rows);
    gl.uniform2f(d.uViewCenter, frame.viewCenter[0], frame.viewCenter[1]);
    gl.uniform1f(d.uViewReach, frame.viewReach);
    gl.uniform1f(d.uReveal, frame.reveal);
    gl.uniform3f(d.uInk, frame.ink[0], frame.ink[1], frame.ink[2]);
    gl.uniform3f(d.uBackground, frame.background[0], frame.background[1], frame.background[2]);
    this.#bindCaption(1, this.#textA, d.uTextA, d.uTextAOrigin, d.uTextASize, frame.textCenter);
    this.#bindCaption(2, this.#textB, d.uTextB, d.uTextBOrigin, d.uTextBSize, frame.textCenter);
    gl.uniform1f(d.uTextMix, frame.textMix);
    gl.uniform1f(d.uTextAmp, frame.textAmp);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  #bindCaption(
    unit: number,
    slot: CaptionSlot,
    sampler: WebGLUniformLocation | null,
    origin: WebGLUniformLocation | null,
    size: WebGLUniformLocation | null,
    center: readonly [number, number],
  ) {
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, slot.texture);
    gl.uniform1i(sampler, unit);
    gl.uniform2i(
      origin,
      Math.round(center[0] - slot.width / 2),
      Math.round(center[1] - slot.height / 2),
    );
    gl.uniform2i(size, slot.width, slot.height);
  }

  dispose() {
    const gl = this.#gl;
    gl.deleteTexture(this.#textA.texture);
    gl.deleteTexture(this.#textB.texture);
    gl.deleteFramebuffer(this.#fieldFramebuffer);
    gl.deleteTexture(this.#fieldTexture);
    gl.deleteVertexArray(this.#vao);
    gl.deleteProgram(this.#fieldProgram);
    gl.deleteProgram(this.#ditherProgram);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function createCaptionSlot(gl: WebGL2RenderingContext): CaptionSlot {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, 1, 1, 0, gl.RG, gl.UNSIGNED_BYTE, new Uint8Array(2));
  return { texture, width: 0, height: 0 };
}

function locate<T extends readonly string[]>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: T,
): Uniforms<T> {
  const uniforms = {} as Uniforms<T>;
  for (const name of names) {
    uniforms[name as T[number]] = gl.getUniformLocation(program, name);
  }
  return uniforms;
}

function linkProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
  const program = gl.createProgram();
  const shaders = [
    compileShader(gl, gl.VERTEX_SHADER, vertex),
    compileShader(gl, gl.FRAGMENT_SHADER, fragment),
  ];
  for (const shader of shaders) gl.attachShader(program, shader);
  gl.linkProgram(program);
  for (const shader of shaders) {
    gl.detachShader(program, shader);
    gl.deleteShader(shader);
  }
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Loader dither program failed to link: ${log}`);
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: GLenum, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Loader dither shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Loader dither shader failed to compile: ${log}`);
  }
  return shader;
}
