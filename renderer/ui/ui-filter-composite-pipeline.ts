import shaderSource from "./ui-filter-composite.wgsl?raw";

export class UIFilterCompositePipeline {
  #device: GPUDevice;
  #format: GPUTextureFormat;
  #viewportUniformBuffer: GPUBuffer;

  #pipeline: GPURenderPipeline | null = null;
  #bindGroupLayout: GPUBindGroupLayout | null = null;
  #sampler: GPUSampler | null = null;
  #uniformSlots: GPUBuffer[] = [];
  #slotCursor = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, viewportUniformBuffer: GPUBuffer) {
    this.#device = device;
    this.#format = format;
    this.#viewportUniformBuffer = viewportUniformBuffer;
  }

  initialize(): void {
    const shaderModule = this.#device.createShaderModule({
      label: "UI filter composite shader",
      code: shaderSource,
    });

    this.#sampler = this.#device.createSampler({
      label: "UI filter composite sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
      label: "UI filter composite bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
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

    this.#pipeline = this.#device.createRenderPipeline({
      label: "UI filter composite pipeline",
      layout: this.#device.createPipelineLayout({
        label: "UI filter composite pipeline layout",
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
            format: this.#format,
            blend: {
              color: {
                srcFactor: "one",
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
      primitive: { topology: "triangle-list" },
    });
  }

  begin(): void {
    this.#slotCursor = 0;
  }

  #getUniformBuffer(index: number): GPUBuffer {
    const existing = this.#uniformSlots[index];
    if (existing) return existing;

    const buffer = this.#device.createBuffer({
      label: `UI filter composite uniforms ${index}`,
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#uniformSlots.push(buffer);
    return buffer;
  }

  render(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    sourceTexture: GPUTexture,
    rect: { x: number; y: number; width: number; height: number },
    clipRadius: number,
    clipToRoundedRect: boolean,
  ): void {
    if (!this.#pipeline || !this.#bindGroupLayout || !this.#sampler) {
      return;
    }

    const uniformBuffer = this.#getUniformBuffer(this.#slotCursor++);
    const uniformData = new Float32Array([
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      clipRadius,
      clipToRoundedRect ? 1 : 0,
      0,
      0,
    ]);
    this.#device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const bindGroup = this.#device.createBindGroup({
      label: "UI filter composite bind group",
      layout: this.#bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: sourceTexture.createView() },
        { binding: 3, resource: this.#sampler },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: "UI filter composite pass",
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

  destroy(): void {
    for (const buffer of this.#uniformSlots) {
      buffer.destroy();
    }
    this.#uniformSlots.length = 0;
    this.#pipeline = null;
    this.#bindGroupLayout = null;
    this.#sampler = null;
  }
}
