import type { UILayoutLine } from "./ui-layout.ts";
import shaderSource from "./ui-line.wgsl?raw";

const MAX_SEGMENTS = 64;
const SEGMENT_UNIFORMS_SIZE = 16 + MAX_SEGMENTS * 48;

function encodeCap(cap: UILayoutLine["startCap"]): number {
  switch (cap) {
    case "butt":
      return 0;
    case "square":
      return 2;
    case "round":
    default:
      return 1;
  }
}

export class UILinePipeline {
  #device: GPUDevice;
  #canvasFormat: GPUTextureFormat;
  #viewportUniformBuffer: GPUBuffer;

  #pipeline: GPURenderPipeline | null = null;
  #bindGroupLayout: GPUBindGroupLayout | null = null;
  #uniformSlots: Array<{
    buffer: GPUBuffer;
    bindGroup: GPUBindGroup;
  }> = [];

  #uniformData = new ArrayBuffer(SEGMENT_UNIFORMS_SIZE);
  #uniformU32View = new Uint32Array(this.#uniformData);
  #uniformF32View = new Float32Array(this.#uniformData);
  #slotCursor = 0;

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat, viewportUniformBuffer: GPUBuffer) {
    this.#device = device;
    this.#canvasFormat = canvasFormat;
    this.#viewportUniformBuffer = viewportUniformBuffer;
  }

  initialize(): void {
    const shaderModule = this.#device.createShaderModule({
      label: "UI line shader",
      code: shaderSource,
    });

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
      label: "UI line bind group layout",
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
      ],
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "UI line pipeline layout",
      bindGroupLayouts: [this.#bindGroupLayout],
    });

    this.#pipeline = this.#device.createRenderPipeline({
      label: "UI line pipeline",
      layout: pipelineLayout,
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
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  begin(): void {
    this.#slotCursor = 0;
  }

  render(lines: UILayoutLine[], pass: GPURenderPassEncoder): void {
    if (lines.length === 0) return;
    if (!this.#pipeline || !this.#bindGroupLayout) return;

    pass.setPipeline(this.#pipeline);

    for (let batchStart = 0; batchStart < lines.length; batchStart += MAX_SEGMENTS) {
      const batchEnd = Math.min(batchStart + MAX_SEGMENTS, lines.length);
      const batchCount = batchEnd - batchStart;

      this.#writeLineData(lines, batchStart, batchCount);

      const slot = this.#getUniformSlot(this.#slotCursor);
      this.#slotCursor++;
      this.#device.queue.writeBuffer(slot.buffer, 0, this.#uniformData, 0, SEGMENT_UNIFORMS_SIZE);
      pass.setBindGroup(0, slot.bindGroup);
      pass.draw(6, batchCount);
    }
  }

  #getUniformSlot(index: number): { buffer: GPUBuffer; bindGroup: GPUBindGroup } {
    const existing = this.#uniformSlots[index];
    if (existing) return existing;

    const buffer = this.#device.createBuffer({
      label: "UI line uniforms",
      size: SEGMENT_UNIFORMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = this.#device.createBindGroup({
      layout: this.#bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
        { binding: 1, resource: { buffer } },
      ],
    });
    const slot = { buffer, bindGroup };
    this.#uniformSlots.push(slot);
    return slot;
  }

  #writeLineData(lines: UILayoutLine[], offset: number, count: number): void {
    const u32 = this.#uniformU32View;
    const f32 = this.#uniformF32View;

    u32[0] = count;
    u32[1] = 0;
    u32[2] = 0;
    u32[3] = 0;

    for (let i = 0; i < count; i++) {
      const line = lines[offset + i]!;
      const base = 4 + i * 12;

      f32[base] = line.startX;
      f32[base + 1] = line.startY;
      f32[base + 2] = line.endX;
      f32[base + 3] = line.endY;

      f32[base + 4] = line.stroke.r;
      f32[base + 5] = line.stroke.g;
      f32[base + 6] = line.stroke.b;
      f32[base + 7] = line.stroke.a * line.opacity;

      f32[base + 8] = line.strokeWidth * 0.5;
      f32[base + 9] = encodeCap(line.startCap);
      f32[base + 10] = encodeCap(line.endCap);
      f32[base + 11] = 0;
    }
  }

  destroy(): void {
    for (let i = 0; i < this.#uniformSlots.length; i++) {
      this.#uniformSlots[i]!.buffer.destroy();
    }
    this.#uniformSlots.length = 0;
    this.#pipeline = null;
    this.#bindGroupLayout = null;
  }
}
