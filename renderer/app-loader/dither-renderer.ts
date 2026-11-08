import ditherShaderSource from "./dither.wgsl?raw";
import fieldShaderSource from "./dither-field.wgsl?raw";
import { loaderCaptionOrigin } from "./layout.ts";

/**
 * WebGPU renderer for the initial loader: a white dither cloud on brand blue with a
 * pixel-text caption that, on exit, opens from the centre in a dithered circle.
 *
 * Two passes keep the GPU cost low:
 *  1. Field pass (dither-field.wgsl): the smooth cloud field, the expensive exp/sin
 *     math, evaluated once per FIELD_STEP × FIELD_STEP cells into an rgba8 texture.
 *  2. Dither pass (dither.wgsl): one fragment per dither cell samples the field,
 *     thresholds it against an 8×8 Bayer matrix and overlays the caption.
 * The canvas is sized in cells and upscaled by CSS with `image-rendering: pixelated`.
 * The loader owns its own device (the app's renderer is initialising alongside it)
 * and destroys it on dispose.
 */

type Rgb = readonly [number, number, number];

/** Caption bitmap in cells: RG8, R = glyph, G = outline (see pixel-font.ts). */
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
  /** sRGB, 0–1. */
  ink: Rgb;
  /** sRGB, 0–1. */
  background: Rgb;
  /** Caption centre, in cells. */
  textCenter: readonly [number, number];
  /** 0 = current caption, 1 = next caption. */
  textMix: number;
  textAmp: number;
}

/** Cells per field node along each axis; the field is smooth enough to interpolate. */
const FIELD_STEP = 4;
const FIELD_UNIFORM_BYTES = 80;
const DITHER_UNIFORM_BYTES = 112;

interface CaptionSlot {
  texture: GPUTexture;
  width: number;
  height: number;
}

export class LoaderDitherRenderer {
  #device: GPUDevice;
  #context: GPUCanvasContext;
  #canvas: OffscreenCanvas;
  #fieldPipeline: GPURenderPipeline;
  #ditherPipeline: GPURenderPipeline;
  #sampler: GPUSampler;
  #fieldUniforms: GPUBuffer;
  #ditherUniforms: GPUBuffer;
  #fieldData = new Float32Array(FIELD_UNIFORM_BYTES / 4);
  #ditherData = new Float32Array(DITHER_UNIFORM_BYTES / 4);
  #ditherInts = new Int32Array(this.#ditherData.buffer);
  #fieldBindGroup: GPUBindGroup;
  #ditherBindGroup: GPUBindGroup | null = null;
  #fieldTexture: GPUTexture | null = null;
  #fieldView: GPUTextureView | null = null;
  #textA: CaptionSlot;
  #textB: CaptionSlot;
  #fieldCols = 1;
  #fieldRows = 1;

  static async create(canvas: OffscreenCanvas) {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
    if (!adapter) throw new Error("Loader dither renderer: no WebGPU adapter");
    const device = await adapter.requestDevice();
    return new LoaderDitherRenderer(canvas, device);
  }

  constructor(canvas: OffscreenCanvas, device: GPUDevice) {
    this.#canvas = canvas;
    this.#device = device;
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Loader dither renderer: no WebGPU canvas context");
    this.#context = context;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "premultiplied", colorSpace: "srgb" });

    const fieldModule = device.createShaderModule({ code: fieldShaderSource });
    const ditherModule = device.createShaderModule({ code: ditherShaderSource });
    this.#fieldPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: fieldModule, entryPoint: "vs" },
      fragment: { module: fieldModule, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
    });
    this.#ditherPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: ditherModule, entryPoint: "vs" },
      fragment: { module: ditherModule, entryPoint: "fs", targets: [{ format }] },
    });
    this.#sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.#fieldUniforms = device.createBuffer({
      size: FIELD_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#ditherUniforms = device.createBuffer({
      size: DITHER_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#fieldBindGroup = device.createBindGroup({
      layout: this.#fieldPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.#fieldUniforms } }],
    });
    this.#textA = this.#createCaption(1, 1, new Uint8Array(2));
    this.#textB = this.#createCaption(1, 1, new Uint8Array(2));
  }

  resize(cols: number, rows: number) {
    this.#canvas.width = cols;
    this.#canvas.height = rows;
    // One extra node so the last cells interpolate towards a real sample.
    this.#fieldCols = Math.ceil(cols / FIELD_STEP) + 1;
    this.#fieldRows = Math.ceil(rows / FIELD_STEP) + 1;
    this.#fieldTexture?.destroy();
    this.#fieldTexture = this.#device.createTexture({
      size: [this.#fieldCols, this.#fieldRows],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#fieldView = this.#fieldTexture.createView();
    this.#ditherBindGroup = null;
  }

  /** Uploads the caption that dissolves in next (the B slot). */
  setNextCaption(bitmap: CaptionBitmap) {
    this.#textB.texture.destroy();
    this.#textB = this.#createCaption(bitmap.width, bitmap.height, bitmap.data);
    this.#ditherBindGroup = null;
  }

  /** Promotes the next caption to current once its dissolve completes. */
  commitCaption() {
    [this.#textA, this.#textB] = [this.#textB, this.#textA];
    this.#ditherBindGroup = null;
  }

  draw(frame: DitherFrame) {
    if (!this.#fieldView) return;
    const device = this.#device;

    const f = this.#fieldData;
    f.set(frame.fieldCenter, 0);
    f.set(frame.fieldHalf, 2);
    f.set(frame.lobeScale, 4);
    f[6] = FIELD_STEP;
    f[7] = frame.time;
    f.set(frame.lobes, 8);
    f[16] = frame.radius;
    f[17] = frame.amp;
    device.queue.writeBuffer(this.#fieldUniforms, 0, this.#fieldData);

    const d = this.#ditherData;
    const di = this.#ditherInts;
    d.set(frame.ink, 0);
    d.set(frame.background, 4);
    d.set(frame.viewCenter, 8);
    d[10] = this.#fieldCols;
    d[11] = this.#fieldRows;
    writeCaptionPlacement(di, 12, this.#textA, frame.textCenter);
    writeCaptionPlacement(di, 16, this.#textB, frame.textCenter);
    d[20] = FIELD_STEP;
    d[21] = frame.viewReach;
    d[22] = frame.reveal;
    d[23] = frame.textMix;
    d[24] = frame.textAmp;
    device.queue.writeBuffer(this.#ditherUniforms, 0, this.#ditherData);

    this.#ditherBindGroup ??= device.createBindGroup({
      layout: this.#ditherPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#ditherUniforms } },
        { binding: 1, resource: this.#fieldView },
        { binding: 2, resource: this.#sampler },
        { binding: 3, resource: this.#textA.texture.createView() },
        { binding: 4, resource: this.#textB.texture.createView() },
      ],
    });

    const encoder = device.createCommandEncoder();
    const fieldPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.#fieldView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 0],
        },
      ],
    });
    fieldPass.setPipeline(this.#fieldPipeline);
    fieldPass.setBindGroup(0, this.#fieldBindGroup);
    fieldPass.draw(3);
    fieldPass.end();

    const ditherPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.#context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 0],
        },
      ],
    });
    ditherPass.setPipeline(this.#ditherPipeline);
    ditherPass.setBindGroup(0, this.#ditherBindGroup);
    ditherPass.draw(3);
    ditherPass.end();
    device.queue.submit([encoder.finish()]);
  }

  dispose() {
    this.#fieldTexture?.destroy();
    this.#textA.texture.destroy();
    this.#textB.texture.destroy();
    this.#fieldUniforms.destroy();
    this.#ditherUniforms.destroy();
    this.#context.unconfigure();
    this.#device.destroy();
  }

  #createCaption(width: number, height: number, data: Uint8Array): CaptionSlot {
    const texture = this.#device.createTexture({
      size: [width, height],
      format: "rg8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#device.queue.writeTexture(
      { texture },
      data,
      { bytesPerRow: width * 2 },
      { width, height },
    );
    return { texture, width, height };
  }
}

function writeCaptionPlacement(
  target: Int32Array,
  offset: number,
  slot: CaptionSlot,
  center: readonly [number, number],
) {
  const [x, y] = loaderCaptionOrigin(center, slot);
  target[offset] = x;
  target[offset + 1] = y;
  target[offset + 2] = slot.width;
  target[offset + 3] = slot.height;
}
