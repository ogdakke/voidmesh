import type { Bounds } from "#types/canvas.ts";
import shaderSource from "./wlur-invalidation-debug.wgsl?raw";

export type WlurInvalidationDebugColor = readonly [
  red: number,
  green: number,
  blue: number,
  alpha: number,
];

const INSTANCE_FLOATS = 8;
const INSTANCE_BYTES = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const INITIAL_CAPACITY = 32;

export class WlurInvalidationDebugPass {
  readonly #device: GPUDevice;
  readonly #layout: GPUBindGroupLayout;
  readonly #pipeline: GPURenderPipeline;
  readonly #viewportBuffer: GPUBuffer;
  #instanceBuffer: GPUBuffer;
  #bindGroup: GPUBindGroup;
  #capacity = INITIAL_CAPACITY;
  #instanceData = new Float32Array(INITIAL_CAPACITY * INSTANCE_FLOATS);
  #count = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, viewportBuffer: GPUBuffer) {
    this.#device = device;
    this.#viewportBuffer = viewportBuffer;
    this.#layout = device.createBindGroupLayout({
      label: "Wlur invalidation debug layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    const module = device.createShaderModule({
      label: "Wlur invalidation debug shader",
      code: shaderSource,
    });
    this.#pipeline = device.createRenderPipeline({
      label: "Wlur invalidation debug pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.#layout] }),
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
    this.#instanceBuffer = this.#createBuffer(this.#capacity);
    this.#bindGroup = this.#createBindGroup();
  }

  beginFrame(): void {
    this.#count = 0;
  }

  addBounds(bounds: Bounds, color: WlurInvalidationDebugColor): void {
    if (bounds.width <= 0 || bounds.height <= 0) return;
    this.#ensureCapacity(this.#count + 1);
    const base = this.#count * INSTANCE_FLOATS;
    this.#instanceData[base] = bounds.x;
    this.#instanceData[base + 1] = bounds.y;
    this.#instanceData[base + 2] = bounds.width;
    this.#instanceData[base + 3] = bounds.height;
    this.#instanceData[base + 4] = color[0];
    this.#instanceData[base + 5] = color[1];
    this.#instanceData[base + 6] = color[2];
    this.#instanceData[base + 7] = color[3];
    this.#count++;
  }

  encode(encoder: GPUCommandEncoder, targetView: GPUTextureView): void {
    if (this.#count === 0) return;
    this.#device.queue.writeBuffer(
      this.#instanceBuffer,
      0,
      this.#instanceData.subarray(0, this.#count * INSTANCE_FLOATS),
    );
    const pass = encoder.beginRenderPass({
      label: "Wlur invalidation debug pass",
      colorAttachments: [{ view: targetView, loadOp: "load", storeOp: "store" }],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.draw(6, this.#count);
    pass.end();
  }

  destroy(): void {
    this.#instanceBuffer.destroy();
  }

  #ensureCapacity(count: number): void {
    if (count <= this.#capacity) return;
    while (this.#capacity < count) this.#capacity *= 2;
    this.#instanceBuffer.destroy();
    this.#instanceData = new Float32Array(this.#capacity * INSTANCE_FLOATS);
    this.#instanceBuffer = this.#createBuffer(this.#capacity);
    this.#bindGroup = this.#createBindGroup();
  }

  #createBuffer(capacity: number): GPUBuffer {
    return this.#device.createBuffer({
      label: "Wlur invalidation debug rectangles",
      size: capacity * INSTANCE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  #createBindGroup(): GPUBindGroup {
    return this.#device.createBindGroup({
      label: "Wlur invalidation debug bind group",
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportBuffer } },
        { binding: 1, resource: { buffer: this.#instanceBuffer } },
      ],
    });
  }
}
