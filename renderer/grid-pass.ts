import { config, type GridConfig } from "#config";
import { calculateGridLevel } from "#lib/canvas-math.ts";
import type { Viewport } from "#types/canvas.ts";
import dotGridShaderSource from "./dot-grid.wgsl?raw";

export class GridPass {
  readonly #device: GPUDevice;
  #pipeline: GPURenderPipeline | null = null;
  #uniformBuffer: GPUBuffer | null = null;
  #bindGroup: GPUBindGroup | null = null;
  #uniformData = new ArrayBuffer(config.rendering.gridUniformSize);
  #floatView = new Float32Array(this.#uniformData);
  #config: GridConfig = config.rendering.grid.default;
  #uniformsDirty = true;
  #offsetX = Number.NaN;
  #offsetY = Number.NaN;
  #zoom = Number.NaN;
  #width = Number.NaN;
  #height = Number.NaN;
  #devicePixelRatio = Number.NaN;

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat) {
    this.#device = device;
    this.#initialize(canvasFormat);
  }

  setConfig(configUpdate: Partial<GridConfig>): void {
    this.#config = { ...this.#config, ...configUpdate };
    this.#uniformsDirty = true;
  }

  encode({
    encoder,
    targetView,
    viewport,
    width,
    height,
  }: {
    encoder: GPUCommandEncoder;
    targetView: GPUTextureView;
    viewport: Viewport;
    width: number;
    height: number;
  }): void {
    this.#writeUniformsIfChanged(viewport, width, height);

    const gridPass = encoder.beginRenderPass({
      label: "Grid render pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    gridPass.setPipeline(this.#pipeline!);
    gridPass.setBindGroup(0, this.#bindGroup!);
    gridPass.draw(3);
    gridPass.end();
  }

  #writeUniformsIfChanged(viewport: Viewport, width: number, height: number): void {
    const devicePixelRatio = window.devicePixelRatio || 1;
    if (
      !this.#uniformsDirty &&
      viewport.offset.x === this.#offsetX &&
      viewport.offset.y === this.#offsetY &&
      viewport.zoom === this.#zoom &&
      width === this.#width &&
      height === this.#height &&
      devicePixelRatio === this.#devicePixelRatio
    ) {
      return;
    }

    this.#updateUniforms(viewport, width, height, devicePixelRatio);
    this.#device.queue.writeBuffer(this.#uniformBuffer!, 0, this.#uniformData);
    this.#uniformsDirty = false;
    this.#offsetX = viewport.offset.x;
    this.#offsetY = viewport.offset.y;
    this.#zoom = viewport.zoom;
    this.#width = width;
    this.#height = height;
    this.#devicePixelRatio = devicePixelRatio;
  }

  destroy(): void {
    this.#uniformBuffer?.destroy();
    this.#uniformBuffer = null;
    this.#pipeline = null;
    this.#bindGroup = null;
  }

  #initialize(canvasFormat: GPUTextureFormat): void {
    const shaderModule = this.#device.createShaderModule({
      label: "Dot grid shader",
      code: dotGridShaderSource,
    });

    const bindGroupLayout = this.#device.createBindGroupLayout({
      label: "Grid bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    this.#uniformBuffer = this.#device.createBuffer({
      label: "Grid uniforms",
      size: config.rendering.gridUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#bindGroup = this.#device.createBindGroup({
      label: "Grid bind group",
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.#uniformBuffer } }],
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Grid pipeline layout",
      bindGroupLayouts: [bindGroupLayout],
    });

    this.#pipeline = this.#device.createRenderPipeline({
      label: "Grid pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: canvasFormat }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  #updateUniforms(
    viewport: Viewport,
    width: number,
    height: number,
    devicePixelRatio: number,
  ): void {
    const gridConfig = this.#config;

    // Multi-level grid: compute fine grid size and crossfade factor
    const { fineGridSize, fadeFactor } = calculateGridLevel(gridConfig.gridSize, viewport.zoom);

    // Scale dot size by DPR so it's in physical pixels (matching fragCoord space)
    const effectiveDotSize = Math.max(1.0, gridConfig.dotSize) * devicePixelRatio;

    // Layout: resolution(8) + offset(8) + zoom(4) + fineGridSize(4) + dotSize(4) + fadeFactor(4) + bgColor(16) + dotColor(16)
    this.#floatView[0] = width;
    this.#floatView[1] = height;
    this.#floatView[2] = viewport.offset.x;
    this.#floatView[3] = viewport.offset.y;
    this.#floatView[4] = viewport.zoom;
    this.#floatView[5] = fineGridSize;
    this.#floatView[6] = effectiveDotSize;
    this.#floatView[7] = fadeFactor;
    this.#floatView[8] = gridConfig.backgroundColor[0];
    this.#floatView[9] = gridConfig.backgroundColor[1];
    this.#floatView[10] = gridConfig.backgroundColor[2];
    this.#floatView[11] = gridConfig.backgroundColor[3];
    this.#floatView[12] = gridConfig.dotColor[0];
    this.#floatView[13] = gridConfig.dotColor[1];
    this.#floatView[14] = gridConfig.dotColor[2];
    this.#floatView[15] = gridConfig.dotColor[3];
  }
}
