import viewportLensDistortionShaderSource from "./viewport-lens-distortion.wgsl?raw";
import type { ViewportLensDistortionConfig } from "#types/canvas.ts";
export type { ViewportLensDistortionConfig } from "#types/canvas.ts";

export interface ViewportLensTarget {
  texture: GPUTexture;
  view: GPUTextureView;
}

interface ViewportLensPassOptions {
  device: GPUDevice;
  format: GPUTextureFormat;
  initialConfig: ViewportLensDistortionConfig;
}

const UNIFORM_BUFFER_SIZE_BYTES = 48;

export class ViewportLensPass {
  readonly #device: GPUDevice;
  readonly #format: GPUTextureFormat;
  readonly #pipeline: GPURenderPipeline;
  readonly #bindGroupLayout: GPUBindGroupLayout;
  readonly #uniformBuffer: GPUBuffer;
  readonly #sampler: GPUSampler;
  readonly #uniformData = new ArrayBuffer(UNIFORM_BUFFER_SIZE_BYTES);
  readonly #floatView = new Float32Array(this.#uniformData);

  #config: ViewportLensDistortionConfig;
  #darkTheme = false;
  #texture: {
    width: number;
    height: number;
    texture: GPUTexture;
    view: GPUTextureView;
    bindGroup: GPUBindGroup;
  } | null = null;

  constructor(options: ViewportLensPassOptions) {
    this.#device = options.device;
    this.#format = options.format;
    this.#config = { ...options.initialConfig };

    const shaderModule = this.#device.createShaderModule({
      label: "Viewport lens distortion shader",
      code: viewportLensDistortionShaderSource,
    });

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
      label: "Viewport lens distortion bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    this.#uniformBuffer = this.#device.createBuffer({
      label: "Viewport lens distortion uniforms",
      size: this.#uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#sampler = this.#device.createSampler({
      label: "Viewport lens distortion sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Viewport lens distortion pipeline layout",
      bindGroupLayouts: [this.#bindGroupLayout],
    });

    this.#pipeline = this.#device.createRenderPipeline({
      label: "Viewport lens distortion pipeline",
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.#format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  get config(): ViewportLensDistortionConfig {
    return this.#config;
  }

  setConfig(config: ViewportLensDistortionConfig): void {
    this.#config = { ...config };
  }

  setColorScheme(isDark: boolean): boolean {
    if (this.#darkTheme === isDark) return false;
    this.#darkTheme = isDark;
    return true;
  }

  getTarget(width: number, height: number): ViewportLensTarget | null {
    if (!this.#shouldApply()) return null;

    const cached = this.#texture;
    if (cached && cached.width === width && cached.height === height) {
      return cached;
    }

    this.#destroyTexture();
    const texture = this.#device.createTexture({
      label: `Viewport lens input (${width}x${height})`,
      size: [width, height],
      format: this.#format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC,
    });
    const view = texture.createView();
    const bindGroup = this.#device.createBindGroup({
      label: "Viewport lens distortion bind group",
      layout: this.#bindGroupLayout,
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: { buffer: this.#uniformBuffer } },
      ],
    });
    this.#texture = { width, height, texture, view, bindGroup };
    return this.#texture;
  }

  encode(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    width: number,
    height: number,
  ): boolean {
    const lensTexture = this.getTarget(width, height);
    if (!lensTexture || !this.#texture) return false;

    const lens = this.#config;
    const v = this.#floatView;
    v[0] = width;
    v[1] = height;
    v[2] = lens.strength;
    v[3] = lens.radius;
    v[4] = lens.falloff;
    v[5] = lens.dispersion;
    v[6] = lens.scale;
    v[7] = lens.reflectionIntensity;
    v[8] = lens.reflectionFocus;
    v[9] = lens.occlusion;
    v[10] = this.#darkTheme ? lens.vignetteDark : lens.vignetteLight;
    v[11] = 0;
    this.#device.queue.writeBuffer(this.#uniformBuffer, 0, this.#uniformData);

    const pass = encoder.beginRenderPass({
      label: "Viewport lens distortion pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#texture.bindGroup);
    pass.draw(3);
    pass.end();
    return true;
  }

  destroy(): void {
    this.#destroyTexture();
    this.#uniformBuffer.destroy();
  }

  #shouldApply(): boolean {
    const lens = this.#config;
    return lens.enabled && (lens.strength > 0.001 || lens.dispersion > 0.001);
  }

  #destroyTexture(): void {
    this.#texture?.texture.destroy();
    this.#texture = null;
  }
}
