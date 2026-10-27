import { ByteBudgetCache } from "./byte-budget-cache.ts";
import shader from "./opaque-texture-proof.wgsl?raw";

/** GPU-only, exact opacity proof shared by immutable uploaded texture identity. */
export class OpaqueTextureProof {
  readonly layout: GPUBindGroupLayout;
  readonly #device: GPUDevice;
  #pipeline: GPUComputePipeline | null = null;
  readonly #descriptor: GPUComputePipelineDescriptor;
  readonly #cache = new ByteBudgetCache(256 * 1024);
  readonly #entries = new Map<GPUTexture, { key: string; buffer: GPUBuffer }>();
  readonly #initial = new Uint32Array([1]);
  #nextKey = 0;
  #proofs = 0;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    const computeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.#descriptor = {
      label: "Exact texture opacity proof",
      layout: device.createPipelineLayout({ bindGroupLayouts: [computeLayout] }),
      compute: {
        module: device.createShaderModule({ label: "Texture opacity proof", code: shader }),
        entryPoint: "proveOpacity",
      },
    };
  }

  async initialize(): Promise<void> {
    this.#pipeline = await this.#device.createComputePipelineAsync(this.#descriptor);
  }

  get(texture: GPUTexture, encoder: GPUCommandEncoder) {
    const cached = this.#entries.get(texture);
    if (cached) {
      this.#cache.markUsed(cached.key);
      return cached;
    }
    this.#pipeline ??= this.#device.createComputePipeline(this.#descriptor);
    const buffer = this.#device.createBuffer({
      label: "Immutable texture opacity",
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.#device.queue.writeBuffer(buffer, 0, this.#initial);
    const computeGroup = this.#device.createBindGroup({
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: { buffer } },
      ],
    });
    const pass = encoder.beginComputePass({ label: "Prove immutable texture opacity" });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, computeGroup);
    pass.dispatchWorkgroups(Math.ceil(texture.width / 16), Math.ceil(texture.height / 16));
    pass.end();
    const key = String(this.#nextKey++);
    const entry = { key, buffer };
    this.#entries.set(texture, entry);
    // Charge a conservative allocation granule, not just the four payload bytes.
    this.#cache.register(key, 256, () => {
      this.#entries.delete(texture);
      buffer.destroy();
    });
    this.#proofs++;
    return entry;
  }
  endFrame(): void {
    this.#cache.endFrame();
  }
  find(texture: GPUTexture): GPUBuffer | undefined {
    const entry = this.#entries.get(texture);
    if (entry) this.#cache.markUsed(entry.key);
    return entry?.buffer;
  }
  getStats() {
    return { ...this.#cache.getStats(), proofs: this.#proofs, bufferBytes: this.#entries.size * 4 };
  }
  destroy(): void {
    this.#cache.destroy();
  }
}
