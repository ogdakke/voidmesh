import { getGpuContext } from "#renderer/gpu-color-space.ts";
import shaderSource from "./color-area.wgsl?raw";

class ColorAreaGpu {
  #device: GPUDevice | null = null;
  #pipeline: GPURenderPipeline | null = null;
  #uniformBuffer: GPUBuffer | null = null;
  #bindGroup: GPUBindGroup | null = null;
  #canvasFormat: GPUTextureFormat = "bgra8unorm";
  #canvasColorSpace: PredefinedColorSpace = "srgb";
  #configuredCanvas: WeakRef<HTMLCanvasElement> | null = null;
  #ctx: GPUCanvasContext | null = null;

  /** Lazily initialize the GPU pipeline. Returns true if ready. */
  init(): boolean {
    const gpuCtx = getGpuContext();
    if (!gpuCtx) return false;

    // Device changed (e.g. after device loss/recreation) — tear down stale GPU resources
    if (this.#device && this.#device !== gpuCtx.device) {
      this.destroy();
    }

    if (this.#pipeline) return true;

    this.#device = gpuCtx.device;
    this.#canvasFormat = gpuCtx.canvasFormat;
    this.#canvasColorSpace = gpuCtx.canvasColorSpace;

    const module = this.#device.createShaderModule({ code: shaderSource });

    const bindGroupLayout = this.#device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    });

    this.#pipeline = this.#device.createRenderPipeline({
      layout: this.#device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [{ format: this.#canvasFormat }],
      },
    });

    // Uniform buffer: hue (f32) + use_p3 (f32) = 8 bytes
    this.#uniformBuffer = this.#device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#bindGroup = this.#device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.#uniformBuffer } }],
    });

    return true;
  }

  /** Render the OKLCH gradient for the given hue onto the canvas. */
  render(canvas: HTMLCanvasElement, hue: number): void {
    if (!this.init()) return;

    const device = this.#device!;
    const pipeline = this.#pipeline!;
    const uniformBuffer = this.#uniformBuffer!;
    const bindGroup = this.#bindGroup!;

    // Configure canvas context (reuse if same canvas)
    if (!this.#configuredCanvas || this.#configuredCanvas.deref() !== canvas) {
      const ctx = canvas.getContext("webgpu");
      if (!ctx) return;
      ctx.configure({
        device,
        format: this.#canvasFormat,
        colorSpace: this.#canvasColorSpace,
        alphaMode: "premultiplied",
      });
      this.#ctx = ctx;
      this.#configuredCanvas = new WeakRef(canvas);
    }

    if (!this.#ctx) return;

    // Write uniforms
    const isP3 = getGpuContext()?.canvasColorSpace === "display-p3";
    const data = new Float32Array([hue, isP3 ? 1 : 0]);
    device.queue.writeBuffer(uniformBuffer, 0, data);

    const texture = this.#ctx.getCurrentTexture();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3); // fullscreen triangle
    pass.end();

    device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.#uniformBuffer?.destroy();
    this.#uniformBuffer = null;
    this.#pipeline = null;
    this.#bindGroup = null;
    this.#ctx?.unconfigure();
    this.#ctx = null;
    this.#configuredCanvas = null;
    this.#device = null;
  }
}

/** Singleton GPU renderer for the color area gradient. */
export const colorAreaGpu = new ColorAreaGpu();
