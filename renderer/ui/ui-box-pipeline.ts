import type { UILayoutBox } from "./ui-layout.ts";
import shaderSource from "./ui-box.wgsl?raw";

const MAX_BOXES = 16;

// BoxUniforms layout:
// boxCount (u32) + 3x u32 padding = 16 bytes
// boxes: MAX_BOXES × BoxData (5 × vec4f = 80 bytes) = 1280 bytes
// Total: 1296 bytes
const BOX_UNIFORMS_SIZE = 16 + MAX_BOXES * 80;

export class UIBoxPipeline {
  #device: GPUDevice;
  #canvasFormat: GPUTextureFormat;
  #viewportUniformBuffer: GPUBuffer;

  #pipeline: GPURenderPipeline | null = null;
  #bindGroupLayout: GPUBindGroupLayout | null = null;
  #uniformSlots: Array<{
    buffer: GPUBuffer;
    bindGroup: GPUBindGroup;
  }> = [];

  #uniformData = new ArrayBuffer(BOX_UNIFORMS_SIZE);
  #uniformU32View = new Uint32Array(this.#uniformData);
  #uniformF32View = new Float32Array(this.#uniformData);
  #slotCursor = 0;

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat, viewportUniformBuffer: GPUBuffer) {
    this.#device = device;
    this.#canvasFormat = canvasFormat;
    this.#viewportUniformBuffer = viewportUniformBuffer;
  }

  initialize(): void {
    const device = this.#device;

    const shaderModule = device.createShaderModule({
      label: "UI box shader",
      code: shaderSource,
    });

    this.#bindGroupLayout = device.createBindGroupLayout({
      label: "UI box bind group layout",
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

    const pipelineLayout = device.createPipelineLayout({
      label: "UI box pipeline layout",
      bindGroupLayouts: [this.#bindGroupLayout],
    });

    this.#pipeline = device.createRenderPipeline({
      label: "UI box pipeline",
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

  /** Clean up staging buffers from the previous frame. Call at start of frame. */
  begin(): void {
    this.#slotCursor = 0;
  }

  render(boxes: UILayoutBox[], pass: GPURenderPassEncoder): void {
    if (boxes.length === 0) return;
    if (!this.#pipeline || !this.#bindGroupLayout) return;

    pass.setPipeline(this.#pipeline);

    for (let batchStart = 0; batchStart < boxes.length; batchStart += MAX_BOXES) {
      const batchEnd = Math.min(batchStart + MAX_BOXES, boxes.length);
      const batchCount = batchEnd - batchStart;

      this.#writeBoxData(boxes, batchStart, batchCount);

      const slot = this.#getUniformSlot(this.#slotCursor);
      this.#slotCursor++;
      this.#device.queue.writeBuffer(slot.buffer, 0, this.#uniformData, 0, BOX_UNIFORMS_SIZE);
      pass.setBindGroup(0, slot.bindGroup);
      pass.draw(6, batchCount);
    }
  }

  #getUniformSlot(index: number): { buffer: GPUBuffer; bindGroup: GPUBindGroup } {
    const existing = this.#uniformSlots[index];
    if (existing) return existing;

    const buffer = this.#device.createBuffer({
      label: "UI box uniforms",
      size: BOX_UNIFORMS_SIZE,
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

  #writeBoxData(boxes: UILayoutBox[], offset: number, count: number): void {
    const u32 = this.#uniformU32View;
    const f32 = this.#uniformF32View;

    // Header: boxCount + padding (16 bytes = 4 u32s)
    u32[0] = count;
    u32[1] = 0;
    u32[2] = 0;
    u32[3] = 0;

    // Each BoxData is 80 bytes = 20 floats
    for (let i = 0; i < count; i++) {
      const box = boxes[offset + i]!;
      const base = 4 + i * 20; // 4 floats header + 20 floats per box

      // rect: x, y, width, height
      f32[base] = box.x;
      f32[base + 1] = box.y;
      f32[base + 2] = box.width;
      f32[base + 3] = box.height;

      // topColor / bottomColor based on background type
      if (box.background?.type === "gradient") {
        const { top, bottom } = box.background;
        f32[base + 4] = top.r;
        f32[base + 5] = top.g;
        f32[base + 6] = top.b;
        f32[base + 7] = top.a;
        f32[base + 8] = bottom.r;
        f32[base + 9] = bottom.g;
        f32[base + 10] = bottom.b;
        f32[base + 11] = bottom.a;
      } else if (box.background?.type === "solid") {
        const { r, g, b, a } = box.background.color;
        f32[base + 4] = r;
        f32[base + 5] = g;
        f32[base + 6] = b;
        f32[base + 7] = a;
        f32[base + 8] = r;
        f32[base + 9] = g;
        f32[base + 10] = b;
        f32[base + 11] = a;
      } else {
        f32[base + 4] = 0;
        f32[base + 5] = 0;
        f32[base + 6] = 0;
        f32[base + 7] = 0;
        f32[base + 8] = 0;
        f32[base + 9] = 0;
        f32[base + 10] = 0;
        f32[base + 11] = 0;
      }

      // borderColor
      f32[base + 12] = box.borderColor.r;
      f32[base + 13] = box.borderColor.g;
      f32[base + 14] = box.borderColor.b;
      f32[base + 15] = box.borderColor.a;

      // params: borderRadius, borderWidth, opacity, unused
      f32[base + 16] = box.borderRadius;
      f32[base + 17] = box.borderWidth;
      f32[base + 18] = box.opacity;
      f32[base + 19] = 0;
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
