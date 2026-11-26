/** Delays before each consecutive recovery attempt after a GPU device loss. */
const RECOVERY_DELAYS_MS = [250, 1_000, 3_000] as const;

/**
 * A renderer that stays alive this long after recovering counts as healthy: the next loss starts
 * a fresh retry budget. A loss inside the window is treated as part of the same crash loop, so a
 * scene that reliably exhausts GPU memory stops retrying instead of crashing forever.
 */
const STABLE_RENDERER_MS = 10_000;

/** Thrown when the browser exposes no usable WebGPU adapter. */
export class WebGpuUnavailableError extends Error {
  constructor() {
    super("WebGPU adapter not available");
    this.name = "WebGpuUnavailableError";
  }
}

/** Raised when an initialized GPU device is lost (driver reset, GPU process crash, OOM kill). */
export class GpuDeviceLostError extends Error {
  readonly reason: GPUDeviceLostReason;

  constructor(reason: GPUDeviceLostReason, message: string) {
    super(message ? `GPU device lost (${reason}): ${message}` : `GPU device lost (${reason})`);
    this.name = "GpuDeviceLostError";
    this.reason = reason;
  }
}

/** Bounded retry policy for recreating the GPU device after it is lost. */
export class GpuDeviceRecovery {
  #consecutiveAttempts = 0;
  #readyAt: number | null = null;

  /** Record a successfully initialized renderer. */
  markReady(now: number): void {
    this.#readyAt = now;
  }

  /** Delay before the next recovery attempt, or `null` once the retry budget is spent. */
  nextAttemptDelay(now: number): number | null {
    if (this.#readyAt !== null && now - this.#readyAt >= STABLE_RENDERER_MS) {
      this.#consecutiveAttempts = 0;
    }
    this.#readyAt = null;

    const delay = RECOVERY_DELAYS_MS[this.#consecutiveAttempts];
    if (delay === undefined) return null;
    this.#consecutiveAttempts++;
    return delay;
  }

  /** Start a fresh retry budget, e.g. after the user asks to try again. */
  reset(): void {
    this.#consecutiveAttempts = 0;
    this.#readyAt = null;
  }
}
