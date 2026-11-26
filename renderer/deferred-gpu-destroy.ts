type Destroy = () => void;

/** How long a destroy requested while no frame is being rendered waits for one. */
const IDLE_FLUSH_DELAY_MS = 250;

/**
 * Holds `destroy()` calls on a device's textures and buffers until the GPU has finished every
 * command buffer submitted before them.
 *
 * WebGPU allows destroying a resource right after the submission that uses it. On iOS WebKit
 * that has ended in a GPU read page fault during zooms, when LOD textures are replaced while
 * frames that sample them are still in flight; WebKit then ends its GPU process and the device
 * is lost. Waiting for `onSubmittedWorkDone` costs a few frames of memory and removes the
 * window. This wraps the device once, so every renderer subsystem is covered.
 */
export class DeferredGpuDestroy {
  readonly #queue: GPUQueue;
  #pending: Destroy[] = [];
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(device: GPUDevice) {
    this.#queue = device.queue;
    const createTexture = device.createTexture.bind(device);
    const createBuffer = device.createBuffer.bind(device);
    device.createTexture = (descriptor) => this.#defer(createTexture(descriptor));
    device.createBuffer = (descriptor) => this.#defer(createBuffer(descriptor));
  }

  /** Call after each `queue.submit`: what was destroyed so far goes once that work is done. */
  afterSubmit(): void {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (this.#pending.length === 0) return;
    const batch = this.#pending;
    this.#pending = [];
    const run = (): void => {
      for (const destroy of batch) destroy();
    };
    // A lost device rejects; its resources are gone either way.
    this.#queue.onSubmittedWorkDone().then(run, run);
  }

  /** Stop deferring: later destroys, such as renderer shutdown, apply at once. */
  dispose(): void {
    this.#disposed = true;
    this.afterSubmit();
  }

  #defer<T extends GPUTexture | GPUBuffer>(resource: T): T {
    const destroy = resource.destroy.bind(resource);
    resource.destroy = () => {
      if (this.#disposed) {
        destroy();
        return;
      }
      this.#pending.push(destroy);
      // Without a frame to follow, nothing would release it.
      this.#idleTimer ??= setTimeout(() => {
        this.#idleTimer = null;
        this.afterSubmit();
      }, IDLE_FLUSH_DELAY_MS);
    };
    return resource;
  }
}
