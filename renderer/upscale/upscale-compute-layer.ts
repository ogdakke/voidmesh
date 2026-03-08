import { WORKGROUP_SIZE } from "./upscale-wgsl.ts";

/**
 * A single compute pass in the upscaling CNN.
 * Wraps a GPUComputePipeline with pre-created bind group.
 * Encodes into an existing command encoder (no per-layer submit).
 */
export class UpscaleComputeLayer {
  #pipeline: GPUComputePipeline;
  #bindGroup: GPUBindGroup;
  #workgroupsX: number;
  #workgroupsY: number;
  #label: string;

  constructor(
    device: GPUDevice,
    label: string,
    wgslCode: string,
    bindGroupEntries: GPUBindGroupEntry[],
    width: number,
    height: number,
  ) {
    this.#label = label;
    this.#workgroupsX = Math.floor(width / WORKGROUP_SIZE);
    this.#workgroupsY = Math.floor(height / WORKGROUP_SIZE);

    const shaderModule = device.createShaderModule({
      label: `${label}-shader`,
      code: wgslCode,
    });

    this.#pipeline = device.createComputePipeline({
      label: `${label}-pipeline`,
      layout: "auto",
      compute: { module: shaderModule, entryPoint: "main" },
    });

    this.#bindGroup = device.createBindGroup({
      label: `${label}-bind-group`,
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: bindGroupEntries,
    });
  }

  /** Encode this compute pass into the given encoder. Does NOT submit. */
  encode(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass({ label: this.#label });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.dispatchWorkgroups(this.#workgroupsX, this.#workgroupsY);
    pass.end();
  }
}
