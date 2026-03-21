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

  // Per-batch staging buffers (destroyed at start of next frame)
  #pendingDestroy: GPUBuffer[] = [];

  #uniformData = new ArrayBuffer(BOX_UNIFORMS_SIZE);
  #uniformU32View = new Uint32Array(this.#uniformData);
  #uniformF32View = new Float32Array(this.#uniformData);

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

  /**
   * Encode render passes for the given boxes.
   * Batches up to 16 boxes per draw call.
   */
  /** Clean up staging buffers from the previous frame. Call at start of frame. */
  begin(): void {
    for (const buf of this.#pendingDestroy) buf.destroy();
    this.#pendingDestroy.length = 0;
  }

  render(boxes: UILayoutBox[], encoder: GPUCommandEncoder, targetView: GPUTextureView): void {
    if (boxes.length === 0) return;
    if (!this.#pipeline || !this.#bindGroupLayout) return;

    // Process in batches of MAX_BOXES
    for (let batchStart = 0; batchStart < boxes.length; batchStart += MAX_BOXES) {
      const batchEnd = Math.min(batchStart + MAX_BOXES, boxes.length);
      const batchCount = batchEnd - batchStart;

      this.#writeBoxData(boxes, batchStart, batchCount);

      // Create a fresh uniform buffer per batch to avoid clobbering
      // when render() is called multiple times per frame
      const uniformBuffer = this.#device.createBuffer({
        label: "UI box uniforms (staging)",
        size: BOX_UNIFORMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.#device.queue.writeBuffer(uniformBuffer, 0, this.#uniformData, 0, BOX_UNIFORMS_SIZE);
      this.#pendingDestroy.push(uniformBuffer);

      const bindGroup = this.#device.createBindGroup({
        layout: this.#bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
          { binding: 1, resource: { buffer: uniformBuffer } },
        ],
      });

      const pass = encoder.beginRenderPass({
        label: `UI box pass (batch ${batchStart})`,
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
      pass.draw(6, batchCount);
      pass.end();
    }
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
      if (box.background.type === "gradient") {
        const { top, bottom } = box.background;
        f32[base + 4] = top.r;
        f32[base + 5] = top.g;
        f32[base + 6] = top.b;
        f32[base + 7] = top.a;
        f32[base + 8] = bottom.r;
        f32[base + 9] = bottom.g;
        f32[base + 10] = bottom.b;
        f32[base + 11] = bottom.a;
      } else {
        const { r, g, b, a } = box.background.color;
        f32[base + 4] = r;
        f32[base + 5] = g;
        f32[base + 6] = b;
        f32[base + 7] = a;
        f32[base + 8] = r;
        f32[base + 9] = g;
        f32[base + 10] = b;
        f32[base + 11] = a;
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
    for (const buf of this.#pendingDestroy) buf.destroy();
    this.#pendingDestroy.length = 0;
    this.#pipeline = null;
    this.#bindGroupLayout = null;
  }
}
