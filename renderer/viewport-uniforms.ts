import { config } from "#config";
import { getViewportMatrix } from "#lib/canvas-math.ts";
import type { Viewport } from "#types/canvas.ts";

export class ViewportUniforms {
  readonly #device: GPUDevice;
  readonly #buffer: GPUBuffer;
  readonly #data = new ArrayBuffer(config.rendering.viewportUniformSize);
  readonly #floatView = new Float32Array(this.#data);

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#buffer = this.#device.createBuffer({
      label: "Viewport uniforms",
      size: config.rendering.viewportUniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  get buffer(): GPUBuffer {
    return this.#buffer;
  }

  update(viewport: Viewport, width: number, height: number): void {
    const matrix = getViewportMatrix(viewport, width, height);

    // Copy matrix rows (3x4 layout for alignment)
    for (let i = 0; i < 12; i++) {
      this.#floatView[i] = matrix[i]!;
    }
    // resolution
    this.#floatView[12] = width;
    this.#floatView[13] = height;
    // zoom level (for screen-space border calculation)
    this.#floatView[14] = viewport.zoom;
    // padding
    this.#floatView[15] = 0;

    this.#device.queue.writeBuffer(this.#buffer, 0, this.#data);
  }

  destroy(): void {
    this.#buffer.destroy();
  }
}
