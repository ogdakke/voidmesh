import copyPassSource from "./copy-pass.wgsl?raw";

/**
 * Simple full-screen copy pass that samples a texture and writes to a
 * target of a (possibly different) format. The GPU handles format
 * conversion automatically during the render pass.
 *
 * Used by the export pipeline (rgba16float → rgba8unorm) and by the
 * showOriginal passthrough (rgba8unorm → rgba16float).
 */
export class CopyPass {
  #device: GPUDevice;
  #pipeline: GPURenderPipeline;
  #bindGroupLayout: GPUBindGroupLayout;
  #sampler: GPUSampler;
  #sourceBindings = new WeakMap<GPUTexture, { view: GPUTextureView; bindGroup: GPUBindGroup }>();
  #destinationViews = new WeakMap<GPUTexture, GPUTextureView>();

  constructor(device: GPUDevice, targetFormat: GPUTextureFormat = "rgba8unorm") {
    this.#device = device;

    this.#sampler = device.createSampler({
      label: "CopyPass sampler",
      magFilter: "linear",
      minFilter: "linear",
    });

    this.#bindGroupLayout = device.createBindGroupLayout({
      label: "CopyPass bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    const shaderModule = device.createShaderModule({
      label: "CopyPass shader",
      code: copyPassSource,
    });

    const pipelineLayout = device.createPipelineLayout({
      label: "CopyPass pipeline layout",
      bindGroupLayouts: [this.#bindGroupLayout],
    });

    this.#pipeline = device.createRenderPipeline({
      label: "CopyPass pipeline",
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: targetFormat }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  encode(
    encoder: GPUCommandEncoder,
    source: GPUTexture,
    destination: GPUTexture | GPUTextureView,
  ): void {
    let destinationView: GPUTextureView;
    if ("createView" in destination) {
      const cached = this.#destinationViews.get(destination);
      if (cached) {
        destinationView = cached;
      } else {
        destinationView = destination.createView();
        this.#destinationViews.set(destination, destinationView);
      }
    } else {
      destinationView = destination;
    }

    let sourceBinding = this.#sourceBindings.get(source);
    if (!sourceBinding) {
      const view = source.createView();
      sourceBinding = {
        view,
        bindGroup: this.#device.createBindGroup({
          label: "CopyPass bind group",
          layout: this.#bindGroupLayout,
          entries: [
            { binding: 0, resource: view },
            { binding: 1, resource: this.#sampler },
          ],
        }),
      };
      this.#sourceBindings.set(source, sourceBinding);
    }

    const pass = encoder.beginRenderPass({
      label: "CopyPass render pass",
      colorAttachments: [
        {
          view: destinationView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, sourceBinding.bindGroup);
    pass.draw(3);
    pass.end();
  }

  /**
   * Copy source texture (rgba16float) to destination texture (rgba8unorm).
   * Values are clamped to [0,1] automatically by the GPU format conversion.
   */
  execute(source: GPUTexture, destination: GPUTexture): void {
    const encoder = this.#device.createCommandEncoder({
      label: "CopyPass encoder",
    });

    this.encode(encoder, source, destination);

    this.#device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.#sourceBindings = new WeakMap();
    this.#destinationViews = new WeakMap();
  }
}
