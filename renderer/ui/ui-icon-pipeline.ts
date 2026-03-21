import type { UILayoutIcon } from "./ui-layout.ts";
import type { UIIconCache } from "./ui-icon-cache.ts";
import shaderSource from "./ui-icon.wgsl?raw";

export class UIIconPipeline {
  #device: GPUDevice;
  #pipeline!: GPURenderPipeline;
  #bindGroupLayout!: GPUBindGroupLayout;
  #sampler!: GPUSampler;
  #uniformArrayBuffer: ArrayBuffer = new ArrayBuffer(32); // 2 x vec4f = 32 bytes
  #uniformFloats: Float32Array = new Float32Array(this.#uniformArrayBuffer);
  #viewportUniformBuffer: GPUBuffer;
  #canvasFormat: GPUTextureFormat;

  // Per-icon staging buffers (destroyed at start of next frame)
  #pendingDestroy: GPUBuffer[] = [];

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat, viewportUniformBuffer: GPUBuffer) {
    this.#device = device;
    this.#canvasFormat = canvasFormat;
    this.#viewportUniformBuffer = viewportUniformBuffer;
  }

  initialize(): void {
    this.#sampler = this.#device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    const shaderModule = this.#device.createShaderModule({
      code: shaderSource,
    });

    this.#pipeline = this.#device.createRenderPipeline({
      layout: this.#device.createPipelineLayout({
        bindGroupLayouts: [this.#bindGroupLayout],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.#canvasFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  /** Clean up staging buffers from the previous frame. Call at start of frame. */
  begin(): void {
    for (const buf of this.#pendingDestroy) buf.destroy();
    this.#pendingDestroy.length = 0;
  }

  /**
   * Render icons. One draw call per icon.
   * Skips icons whose textures aren't cached yet.
   */
  render(
    icons: UILayoutIcon[],
    iconCache: UIIconCache,
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
  ): void {
    for (const icon of icons) {
      const texture = iconCache.get(icon.svg);
      if (!texture) {
        iconCache.preload(icon.svg);
        continue;
      }

      // Write icon uniforms: rect + tint
      this.#uniformFloats[0] = icon.x;
      this.#uniformFloats[1] = icon.y;
      this.#uniformFloats[2] = icon.width;
      this.#uniformFloats[3] = icon.height;
      this.#uniformFloats[4] = icon.tint.r;
      this.#uniformFloats[5] = icon.tint.g;
      this.#uniformFloats[6] = icon.tint.b;
      this.#uniformFloats[7] = icon.tint.a * icon.opacity;

      // Fresh buffer per icon to avoid clobbering (same pattern as UIBoxPipeline)
      const uniformBuffer = this.#device.createBuffer({
        label: "UI icon uniforms (staging)",
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.#device.queue.writeBuffer(uniformBuffer, 0, this.#uniformArrayBuffer);
      this.#pendingDestroy.push(uniformBuffer);

      const bindGroup = this.#device.createBindGroup({
        layout: this.#bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
          { binding: 1, resource: { buffer: uniformBuffer } },
          { binding: 2, resource: texture.createView() },
          { binding: 3, resource: this.#sampler },
        ],
      });

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: targetView,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });

      pass.setPipeline(this.#pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
      pass.end();
    }
  }

  destroy(): void {
    for (const buf of this.#pendingDestroy) buf.destroy();
    this.#pendingDestroy.length = 0;
  }
}
