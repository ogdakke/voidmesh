const externalTextureCopyShaderSource = `
@group(0) @binding(0) var sourceTexture: texture_external;
@group(0) @binding(1) var sourceSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let uv = vec2f(f32((vertexIndex << 1u) & 2u), f32(vertexIndex & 2u));
  var out: VertexOutput;
  out.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(uv.x, 1.0 - uv.y);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let color = textureSampleBaseClampToEdge(sourceTexture, sourceSampler, in.uv);
  return color;
}
`;

export class ExternalTextureCopyPass {
  #device: GPUDevice;
  #pipeline: GPURenderPipeline;
  #bindGroupLayout: GPUBindGroupLayout;
  #sampler: GPUSampler;
  #textureViewCache = new WeakMap<GPUTexture, GPUTextureView>();

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.#device = device;
    this.#bindGroupLayout = device.createBindGroupLayout({
      label: "External texture copy bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          externalTexture: {},
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });
    this.#sampler = device.createSampler({
      label: "External texture copy sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    const shaderModule = device.createShaderModule({
      label: "External texture copy shader",
      code: externalTextureCopyShaderSource,
    });
    const pipelineLayout = device.createPipelineLayout({
      label: "External texture copy pipeline layout",
      bindGroupLayouts: [this.#bindGroupLayout],
    });
    this.#pipeline = device.createRenderPipeline({
      label: "External texture copy pipeline",
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  encode(encoder: GPUCommandEncoder, source: GPUExternalTexture, destination: GPUTexture): void {
    const bindGroup = this.#device.createBindGroup({
      label: "External texture copy bind group",
      layout: this.#bindGroupLayout,
      entries: [
        { binding: 0, resource: source },
        { binding: 1, resource: this.#sampler },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: "External texture copy pass",
      colorAttachments: [
        {
          view: this.#getTextureView(destination),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(this.#pipeline);
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
