import { resolveCssVarColor } from "#lib/css.ts";
import perfGraphSource from "./perf-graph.wgsl?raw";

const MAX_SAMPLES = 300;
const UNIFORM_FLOATS = 28;

type Rgba = readonly [number, number, number, number];

const FALLBACK_FOREGROUND: Rgba = [0.45, 0.57, 0.98, 1];
const FALLBACK_BACKGROUND: Rgba = [0.02, 0.02, 0.02, 1];
const FALLBACK_GRID: Rgba = [0.45, 0.45, 0.45, 0.25];
const FALLBACK_FILL: Rgba = [0.35, 0.48, 0.95, 0.5];

interface GraphColors {
  foreground: Rgba;
  background: Rgba;
  grid: Rgba;
  fill: Rgba;
}

export class PerfGraphRenderer {
  #canvas: HTMLCanvasElement;
  #device: GPUDevice;
  #context: GPUCanvasContext;
  #pipeline: GPURenderPipeline;
  #bindGroup: GPUBindGroup;
  #uniformBuffer: GPUBuffer;
  #sampleBuffer: GPUBuffer;
  #format: GPUTextureFormat;
  #colorSpace: PredefinedColorSpace;
  #sampleUpload = new Float32Array(1);
  #colors: GraphColors = {
    foreground: FALLBACK_FOREGROUND,
    background: FALLBACK_BACKGROUND,
    grid: FALLBACK_GRID,
    fill: FALLBACK_FILL,
  };
  #needsColorRefresh = true;
  #colorSchemeMedia: MediaQueryList | null = null;
  #width = 0;
  #height = 0;

  readonly #handleColorSchemeChange = (): void => {
    this.#needsColorRefresh = true;
  };

  constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    format: GPUTextureFormat,
    colorSpace: PredefinedColorSpace,
  ) {
    this.#canvas = canvas;
    this.#device = device;
    this.#format = format;
    this.#colorSpace = colorSpace;

    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new Error("Performance graph WebGPU context not available");
    }
    this.#context = context;
    this.#colorSchemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
    this.#colorSchemeMedia.addEventListener("change", this.#handleColorSchemeChange);

    const shader = device.createShaderModule({
      label: "PerfGraph shader",
      code: perfGraphSource,
    });

    const bindGroupLayout = device.createBindGroupLayout({
      label: "PerfGraph bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
      ],
    });

    this.#pipeline = device.createRenderPipeline({
      label: "PerfGraph pipeline",
      layout: device.createPipelineLayout({
        label: "PerfGraph pipeline layout",
        bindGroupLayouts: [bindGroupLayout],
      }),
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.#uniformBuffer = device.createBuffer({
      label: "PerfGraph uniforms",
      size: UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#sampleBuffer = device.createBuffer({
      label: "PerfGraph samples",
      size: MAX_SAMPLES * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.#bindGroup = device.createBindGroup({
      label: "PerfGraph bind group",
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#uniformBuffer } },
        { binding: 1, resource: { buffer: this.#sampleBuffer } },
      ],
    });
  }

  writeSample(index: number, value: number): void {
    if (index < 0 || index >= MAX_SAMPLES) return;

    this.#sampleUpload[0] = value;
    this.#device.queue.writeBuffer(
      this.#sampleBuffer,
      index * Float32Array.BYTES_PER_ELEMENT,
      this.#sampleUpload,
    );
  }

  uploadSeries(samples: Float32Array): void {
    const uploadSamples =
      samples.length === MAX_SAMPLES
        ? samples
        : samples.subarray(0, Math.min(samples.length, MAX_SAMPLES));
    this.#device.queue.writeBuffer(this.#sampleBuffer, 0, uploadSamples);
  }

  render(sampleCount: number, latestIndex: number, scaleMax: number): void {
    if (!this.#resize()) return;

    const colors = this.#readColors();
    const uniforms = new Float32Array(UNIFORM_FLOATS);
    uniforms.set([this.#width, this.#height, 0, 0], 0);
    uniforms.set([this.#width, this.#height, sampleCount, latestIndex], 4);
    uniforms.set([scaleMax, 0, 0, 0], 8);
    uniforms.set(colors.foreground, 12);
    uniforms.set(colors.background, 16);
    uniforms.set(colors.grid, 20);
    uniforms.set(colors.fill, 24);
    this.#device.queue.writeBuffer(this.#uniformBuffer, 0, uniforms);

    const texture = this.#context.getCurrentTexture();
    const encoder = this.#device.createCommandEncoder({ label: "PerfGraph encoder" });
    const pass = encoder.beginRenderPass({
      label: "PerfGraph render pass",
      colorAttachments: [
        {
          view: texture.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: {
            r: colors.background[0],
            g: colors.background[1],
            b: colors.background[2],
            a: colors.background[3],
          },
        },
      ],
    });

    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.draw(3);
    pass.end();

    this.#device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.#context.unconfigure();
    this.#uniformBuffer.destroy();
    this.#sampleBuffer.destroy();
    this.#colorSchemeMedia?.removeEventListener("change", this.#handleColorSchemeChange);
    this.#colorSchemeMedia = null;
  }

  #resize(): boolean {
    const rect = this.#canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    if (width <= 1 || height <= 1) return false;
    if (width === this.#width && height === this.#height) return true;

    this.#width = width;
    this.#height = height;
    this.#canvas.width = width;
    this.#canvas.height = height;
    this.#context.configure({
      device: this.#device,
      format: this.#format,
      colorSpace: this.#colorSpace,
      alphaMode: "premultiplied",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return true;
  }

  #readColors(): {
    foreground: Rgba;
    background: Rgba;
    grid: Rgba;
    fill: Rgba;
  } {
    if (!this.#needsColorRefresh) return this.#colors;

    this.#colors = {
      foreground: resolveRgba("--perf-graph-fg", this.#canvas, FALLBACK_FOREGROUND),
      background: resolveRgba("--perf-graph-bg", this.#canvas, FALLBACK_BACKGROUND),
      grid: resolveRgba("--perf-graph-grid", this.#canvas, FALLBACK_GRID),
      fill: resolveRgba("--perf-graph-fill", this.#canvas, FALLBACK_FILL),
    };
    this.#needsColorRefresh = false;

    return this.#colors;
  }
}

function resolveRgba(varName: string, scope: HTMLElement, fallback: Rgba): Rgba {
  const resolved = resolveCssVarColor(varName, scope);
  if (!resolved) return fallback;

  return parseCssColor(resolved) ?? resolveColorViaCanvas(resolved) ?? fallback;
}

function parseCssColor(value: string): Rgba | null {
  if (value.startsWith("rgb")) {
    return parseRgbColor(value);
  }
  if (value.startsWith("color(srgb")) {
    return parseSrgbColor(value);
  }
  return null;
}

function parseRgbColor(value: string): Rgba | null {
  const body = value.slice(value.indexOf("(") + 1, value.lastIndexOf(")")).replaceAll(",", " ");
  const [r, g, b, alpha] = body.split(/\s+\/?\s*/).filter(Boolean);
  if (!r || !g || !b) return null;

  return [
    parseRgbChannel(r),
    parseRgbChannel(g),
    parseRgbChannel(b),
    alpha ? parseAlpha(alpha) : 1,
  ];
}

function parseSrgbColor(value: string): Rgba | null {
  const body = value.slice("color(srgb".length, value.lastIndexOf(")")).trim();
  const [r, g, b, alpha] = body.split(/\s+\/?\s*/).filter(Boolean);
  if (!r || !g || !b) return null;

  return [parseAlpha(r), parseAlpha(g), parseAlpha(b), alpha ? parseAlpha(alpha) : 1];
}

let colorCanvas: HTMLCanvasElement | null = null;
let colorContext: CanvasRenderingContext2D | null = null;

function resolveColorViaCanvas(value: string): Rgba | null {
  colorCanvas ??= document.createElement("canvas");
  colorCanvas.width = 1;
  colorCanvas.height = 1;
  colorContext ??= colorCanvas.getContext("2d", { willReadFrequently: true });
  if (!colorContext) return null;

  colorContext.clearRect(0, 0, 1, 1);
  colorContext.fillStyle = value;
  colorContext.fillRect(0, 0, 1, 1);
  const color = colorContext.getImageData(0, 0, 1, 1).data;
  const r = color[0] ?? 0;
  const g = color[1] ?? 0;
  const b = color[2] ?? 0;
  const a = color[3] ?? 255;
  return [r / 255, g / 255, b / 255, a / 255];
}

function parseRgbChannel(value: string): number {
  if (value.endsWith("%")) {
    return clamp01(Number.parseFloat(value) / 100);
  }
  return clamp01(Number.parseFloat(value) / 255);
}

function parseAlpha(value: string): number {
  if (value.endsWith("%")) {
    return clamp01(Number.parseFloat(value) / 100);
  }
  return clamp01(Number.parseFloat(value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
