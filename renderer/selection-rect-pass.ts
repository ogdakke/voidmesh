import { config } from "#config";
import type { Bounds, RGBA, Viewport } from "#types/canvas.ts";
import selectionRectShaderSource from "./selection-rect.wgsl?raw";

type SelectionRectStyle = {
  borderColor: RGBA;
  backgroundColor: RGBA;
  borderWidth: number;
};

type SelectionRectItem = {
  bounds: Bounds;
  config: SelectionRectStyle;
};

export class SelectionRectPass {
  readonly #device: GPUDevice;
  #pipeline: GPURenderPipeline | null = null;
  #uniformBuffer: GPUBuffer | null = null;
  #bindGroup: GPUBindGroup | null = null;
  #uniformData = new ArrayBuffer(288);
  #floatView = new Float32Array(this.#uniformData);
  #selectionRectConfig = config.selectionRectangle.light;
  #multiSelectBoundingBoxConfig = config.multiSelectBoundingBox.light;

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat) {
    this.#device = device;
    this.#initialize(canvasFormat);
  }

  setConfig(
    selectionRect: typeof config.selectionRectangle.light,
    multiSelectBox: typeof config.multiSelectBoundingBox.light,
  ): void {
    this.#selectionRectConfig = selectionRect;
    this.#multiSelectBoundingBoxConfig = multiSelectBox;
  }

  encode({
    encoder,
    targetView,
    viewport,
    width,
    height,
    dragSelectBounds,
    multiSelectBounds,
  }: {
    encoder: GPUCommandEncoder;
    targetView: GPUTextureView;
    viewport: Viewport;
    width: number;
    height: number;
    dragSelectBounds: Bounds | null;
    multiSelectBounds: Bounds | null;
  }): void {
    const rects: SelectionRectItem[] = [];

    if (dragSelectBounds) {
      rects.push({
        bounds: dragSelectBounds,
        config: this.#selectionRectConfig,
      });
    }

    if (multiSelectBounds) {
      rects.push({
        bounds: multiSelectBounds,
        config: this.#multiSelectBoundingBoxConfig,
      });
    }

    if (rects.length === 0) return;

    this.#updateUniforms(rects, viewport, width, height);
    this.#device.queue.writeBuffer(this.#uniformBuffer!, 0, this.#uniformData);

    const selectionRectPass = encoder.beginRenderPass({
      label: "Selection rectangles render pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "load", // Preserve previous content
          storeOp: "store",
        },
      ],
    });

    selectionRectPass.setPipeline(this.#pipeline!);
    selectionRectPass.setBindGroup(0, this.#bindGroup!);
    selectionRectPass.draw(3); // Fullscreen triangle
    selectionRectPass.end();
  }

  destroy(): void {
    this.#uniformBuffer?.destroy();
    this.#uniformBuffer = null;
    this.#pipeline = null;
    this.#bindGroup = null;
  }

  #initialize(canvasFormat: GPUTextureFormat): void {
    const shaderModule = this.#device.createShaderModule({
      label: "Selection rect shader",
      code: selectionRectShaderSource,
    });

    const bindGroupLayout = this.#device.createBindGroupLayout({
      label: "Selection rect bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    this.#uniformBuffer = this.#device.createBuffer({
      label: "Selection rect uniforms",
      size: 288,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#bindGroup = this.#device.createBindGroup({
      label: "Selection rect bind group",
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.#uniformBuffer } }],
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Selection rect pipeline layout",
      bindGroupLayouts: [bindGroupLayout],
    });

    this.#pipeline = this.#device.createRenderPipeline({
      label: "Selection rect pipeline",
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
            format: canvasFormat,
            blend: {
              color: {
                srcFactor: "src-alpha",
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

  /** Update selection rectangle uniforms with multiple rectangles */
  #updateUniforms(
    rects: SelectionRectItem[],
    viewport: Viewport,
    width: number,
    height: number,
  ): void {
    const v = this.#floatView;

    // Header layout (32 bytes = 8 floats):
    // resolution(8) + offset(8) + zoom(4) + rectCount(4) + padding(8)
    v[0] = width;
    v[1] = height;
    v[2] = viewport.offset.x;
    v[3] = viewport.offset.y;
    v[4] = viewport.zoom;
    v[5] = Math.min(rects.length, 4); // rectCount (max 4)
    v[6] = 0; // padding
    v[7] = 0; // padding

    // Write each RectData (64 bytes = 16 floats each)
    // RectData[i] starts at float index 8 + (i * 16)
    const maxRects = Math.min(rects.length, 4);
    for (let i = 0; i < maxRects; i++) {
      const rect = rects[i]!;
      const fillColor = rect.config.backgroundColor;
      const borderColor = rect.config.borderColor;
      const base = 8 + i * 16;

      // rect: vec4f (x, y, width, height)
      v[base + 0] = rect.bounds.x;
      v[base + 1] = rect.bounds.y;
      v[base + 2] = rect.bounds.width;
      v[base + 3] = rect.bounds.height;
      // fillColor: vec4f (straight alpha — shader handles blending)
      v[base + 4] = fillColor[0];
      v[base + 5] = fillColor[1];
      v[base + 6] = fillColor[2];
      v[base + 7] = fillColor[3];
      // borderColor: vec4f (straight alpha — shader handles blending)
      v[base + 8] = borderColor[0];
      v[base + 9] = borderColor[1];
      v[base + 10] = borderColor[2];
      v[base + 11] = borderColor[3];
      // borderWidth: vec4f (only .x used, rest padding)
      v[base + 12] = rect.config.borderWidth;
      v[base + 13] = 0;
      v[base + 14] = 0;
      v[base + 15] = 0;
    }

    // Zero out unused rect slots
    for (let i = maxRects; i < 4; i++) {
      const base = 8 + i * 16;
      for (let j = 0; j < 16; j++) {
        v[base + j] = 0;
      }
    }
  }
}
