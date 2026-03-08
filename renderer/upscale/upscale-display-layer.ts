/**
 * Display layer: final render pass that performs sub-pixel shuffle + bicubic residual.
 * Reads from storage buffers + original input texture, outputs to a 2x resolution texture.
 */
export class UpscaleDisplayLayer {
  #pipeline: GPURenderPipeline;
  #bindGroup: GPUBindGroup;
  #label: string;

  constructor(
    device: GPUDevice,
    label: string,
    wgslCode: string,
    bindGroupEntries: GPUBindGroupEntry[],
    outputFormat: GPUTextureFormat,
  ) {
    this.#label = label;

    const shaderModule = device.createShaderModule({
      label: `${label}-shader`,
      code: wgslCode,
    });

    this.#pipeline = device.createRenderPipeline({
      label: `${label}-pipeline`,
      layout: "auto",
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format: outputFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.#bindGroup = device.createBindGroup({
      label: `${label}-bind-group`,
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: bindGroupEntries,
    });
  }

  /** Encode this render pass into the given encoder. Does NOT submit. */
  encode(encoder: GPUCommandEncoder, outputTexture: GPUTexture): void {
    const pass = encoder.beginRenderPass({
      label: this.#label,
      colorAttachments: [
        {
          view: outputTexture.createView(),
          clearValue: [0, 0, 0, 1],
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.draw(6);
    pass.end();
  }
}
