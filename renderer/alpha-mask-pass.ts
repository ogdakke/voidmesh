import alphaMaskShaderSource from "./alpha-mask.wgsl?raw";
import type { ExternalTextureSource } from "./shaders/shader-pass.ts";

function createExternalAlphaMaskShaderSource(source: string): string {
  const rewritten = source
    .replace(
      /@group\(0\)\s+@binding\(1\)\s+var\s+maskTexture\s*:\s*texture_2d<f32>;/,
      "@group(0) @binding(1) var maskTexture: texture_external;",
    )
    .replace(
      /textureSample\(maskTexture,\s*texSampler,\s*uv\)/g,
      "textureSampleBaseClampToEdge(maskTexture, texSampler, uv)",
    );

  if (rewritten === source || !rewritten.includes("texture_external")) {
    throw new Error("Failed to rewrite alpha mask shader source for external texture input.");
  }
  return rewritten;
}

export type AlphaMaskSource =
  | { kind: "texture"; texture: GPUTexture }
  | ({ kind: "external" } & ExternalTextureSource);

export class AlphaMaskPass {
  #device: GPUDevice;
  #pipeline: GPURenderPipeline;
  #externalPipeline: GPURenderPipeline;
  #bindGroupLayout: GPUBindGroupLayout;
  #externalBindGroupLayout: GPUBindGroupLayout;
  #sampler: GPUSampler;
  #textureViewCache = new WeakMap<GPUTexture, GPUTextureView>();

  constructor(device: GPUDevice, targetFormat: GPUTextureFormat) {
    this.#device = device;
    this.#sampler = device.createSampler({
      label: "AlphaMaskPass sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.#bindGroupLayout = device.createBindGroupLayout({
      label: "AlphaMaskPass bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    this.#externalBindGroupLayout = device.createBindGroupLayout({
      label: "AlphaMaskPass external bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          externalTexture: {},
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    const shaderModule = device.createShaderModule({
      label: "AlphaMaskPass shader",
      code: alphaMaskShaderSource,
    });
    const externalShaderModule = device.createShaderModule({
      label: "AlphaMaskPass external shader",
      code: createExternalAlphaMaskShaderSource(alphaMaskShaderSource),
    });

    this.#pipeline = this.#createPipeline(
      "AlphaMaskPass pipeline",
      shaderModule,
      this.#bindGroupLayout,
      targetFormat,
    );
    this.#externalPipeline = this.#createPipeline(
      "AlphaMaskPass external pipeline",
      externalShaderModule,
      this.#externalBindGroupLayout,
      targetFormat,
    );
  }

  #createPipeline(
    label: string,
    shaderModule: GPUShaderModule,
    bindGroupLayout: GPUBindGroupLayout,
    targetFormat: GPUTextureFormat,
  ): GPURenderPipeline {
    const pipelineLayout = this.#device.createPipelineLayout({
      label: `${label} layout`,
      bindGroupLayouts: [bindGroupLayout],
    });

    return this.#device.createRenderPipeline({
      label,
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
    effectTexture: GPUTexture,
    maskSource: AlphaMaskSource,
    outputTexture: GPUTexture,
  ): void {
    const bindGroup =
      maskSource.kind === "external"
        ? this.#device.createBindGroup({
            label: "AlphaMaskPass external bind group",
            layout: this.#externalBindGroupLayout,
            entries: [
              { binding: 0, resource: this.#getTextureView(effectTexture) },
              { binding: 1, resource: maskSource.texture },
              { binding: 2, resource: this.#sampler },
            ],
          })
        : this.#device.createBindGroup({
            label: "AlphaMaskPass bind group",
            layout: this.#bindGroupLayout,
            entries: [
              { binding: 0, resource: this.#getTextureView(effectTexture) },
              { binding: 1, resource: this.#getTextureView(maskSource.texture) },
              { binding: 2, resource: this.#sampler },
            ],
          });

    const pass = encoder.beginRenderPass({
      label:
        maskSource.kind === "external"
          ? "AlphaMaskPass external render pass"
          : "AlphaMaskPass render pass",
      colorAttachments: [
        {
          view: this.#getTextureView(outputTexture),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    pass.setPipeline(maskSource.kind === "external" ? this.#externalPipeline : this.#pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  #getTextureView(texture: GPUTexture): GPUTextureView {
    const cached = this.#textureViewCache.get(texture);
    if (cached) return cached;

    const view = texture.createView();
    this.#textureViewCache.set(texture, view);
    return view;
  }
}
