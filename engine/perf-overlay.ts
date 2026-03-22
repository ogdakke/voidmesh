/**
 * Performance overlay controller.
 * Displays FPS (real frame rate), render time, and entity stats when debug mode is active.
 * Follows the same singleton + cached-DOM-writes pattern as EntityLabelController.
 *
 * Updates text at ~2Hz (every 30 rendered frames) to avoid layout thrash.
 */

export interface FrameStats {
  renderTime: number;
  entityCount: number;
  renderedCount: number;
  gpuSupported?: boolean;
  gpuTime?: number;
  gpuGridTime?: number;
  gpuEntityTime?: number;
  gpuWlurTime?: number;
  gpuActionLayerBlurTime?: number;
  gpuActionLayerSharpTime?: number;
  gpuSelectionTime?: number;
}

export interface PerfOverlaySnapshot {
  fps: number;
  renderMedianMs: number;
  renderP95Ms: number;
  entityCount: number;
  renderedCount: number;
  sampleCount: number;
  text: string;
}

const RING_SIZE = 300; // 5 seconds at 60fps
const EMPTY_SNAPSHOT: PerfOverlaySnapshot = {
  fps: 0,
  renderMedianMs: 0,
  renderP95Ms: 0,
  entityCount: 0,
  renderedCount: 0,
  sampleCount: 0,
  text: "",
};

class PerfOverlayController {
  #element: HTMLElement | null = null;
  #cachedText = "";
  #visible = false;
  #snapshot: PerfOverlaySnapshot = EMPTY_SNAPSHOT;

  // Ring buffer for render time samples (CPU-side submission cost)
  #renderSamples = new Float64Array(RING_SIZE);
  #renderIndex = 0;
  #renderCount = 0;

  // FPS tracking via actual frame-to-frame intervals
  #lastTickTime = 0;
  #fpsSamples = new Float64Array(RING_SIZE);
  #fpsIndex = 0;
  #fpsCount = 0;

  // Throttle DOM updates (~2Hz at 60fps)
  #framesSinceUpdate = 0;
  #lastEntityCount = 0;
  #lastRenderedCount = 0;
  #gpuSamples = new Float64Array(RING_SIZE);
  #gpuIndex = 0;
  #gpuCount = 0;
  #lastGpuStats: Pick<
    FrameStats,
    | "gpuSupported"
    | "gpuTime"
    | "gpuGridTime"
    | "gpuEntityTime"
    | "gpuWlurTime"
    | "gpuActionLayerBlurTime"
    | "gpuActionLayerSharpTime"
    | "gpuSelectionTime"
  > = {
    gpuSupported: false,
    gpuTime: 0,
    gpuGridTime: 0,
    gpuEntityTime: 0,
    gpuWlurTime: 0,
    gpuActionLayerBlurTime: 0,
    gpuActionLayerSharpTime: 0,
    gpuSelectionTime: 0,
  };

  setElement(element: HTMLElement): void {
    this.#element = element;
  }

  getSnapshot(): PerfOverlaySnapshot {
    return this.#snapshot;
  }

  /**
   * Record a frame sample and optionally update the overlay.
   * Called by the game loop after every rendered frame.
   */
  tick(stats: FrameStats, debugMode: boolean): void {
    // Toggle visibility
    if (debugMode !== this.#visible) {
      this.#element?.style.setProperty("display", debugMode ? "block" : "none");
      this.#visible = debugMode;
      if (!debugMode) {
        this.#reset();
        return;
      }
    }
    if (!debugMode) return;

    const now = performance.now();

    // Record render time sample
    this.#renderSamples[this.#renderIndex] = stats.renderTime;
    this.#renderIndex = (this.#renderIndex + 1) % RING_SIZE;
    if (this.#renderCount < RING_SIZE) this.#renderCount++;

    // Record frame interval for real FPS
    if (this.#lastTickTime > 0) {
      const frameInterval = now - this.#lastTickTime;
      this.#fpsSamples[this.#fpsIndex] = frameInterval;
      this.#fpsIndex = (this.#fpsIndex + 1) % RING_SIZE;
      if (this.#fpsCount < RING_SIZE) this.#fpsCount++;
    }
    this.#lastTickTime = now;

    this.#lastEntityCount = stats.entityCount;
    this.#lastRenderedCount = stats.renderedCount;
    this.#lastGpuStats = {
      gpuSupported: stats.gpuSupported ?? false,
      gpuTime: stats.gpuTime ?? 0,
      gpuGridTime: stats.gpuGridTime ?? 0,
      gpuEntityTime: stats.gpuEntityTime ?? 0,
      gpuWlurTime: stats.gpuWlurTime ?? 0,
      gpuActionLayerBlurTime: stats.gpuActionLayerBlurTime ?? 0,
      gpuActionLayerSharpTime: stats.gpuActionLayerSharpTime ?? 0,
      gpuSelectionTime: stats.gpuSelectionTime ?? 0,
    };
    if (stats.gpuSupported && (stats.gpuTime ?? 0) > 0) {
      this.#gpuSamples[this.#gpuIndex] = stats.gpuTime!;
      this.#gpuIndex = (this.#gpuIndex + 1) % RING_SIZE;
      if (this.#gpuCount < RING_SIZE) this.#gpuCount++;
    }

    // Update text and summary at ~2Hz
    this.#framesSinceUpdate++;
    if (this.#framesSinceUpdate < 30 && this.#snapshot.sampleCount > 0) return;
    this.#framesSinceUpdate = 0;

    const render = this.#computePercentiles(this.#renderSamples, this.#renderCount);
    const frame = this.#computePercentiles(this.#fpsSamples, this.#fpsCount);
    const gpu = this.#computePercentiles(this.#gpuSamples, this.#gpuCount);
    const fps = frame.median > 0 ? Math.round(1000 / frame.median) : 0;
    const gpuText = this.#lastGpuStats.gpuSupported
      ? ` | gpu ${gpu.median.toFixed(1)}ms med | ent ${this.#lastGpuStats.gpuEntityTime?.toFixed(1) ?? "0.0"} | wlur ${this.#lastGpuStats.gpuWlurTime?.toFixed(1) ?? "0.0"} | act ${this.#lastGpuStats.gpuActionLayerBlurTime?.toFixed(1) ?? "0.0"}`
      : "";

    const text = `${fps} fps | cpu ${render.median.toFixed(1)}ms med | ${render.p95.toFixed(1)}ms p95${gpuText} | ${this.#lastRenderedCount}/${this.#lastEntityCount} entities`;
    this.#snapshot = {
      fps,
      renderMedianMs: render.median,
      renderP95Ms: render.p95,
      entityCount: this.#lastEntityCount,
      renderedCount: this.#lastRenderedCount,
      sampleCount: this.#renderCount,
      text,
    };

    if (this.#element && text !== this.#cachedText) {
      this.#element.textContent = text;
      this.#cachedText = text;
    }
  }

  #reset(): void {
    this.#cachedText = "";
    this.#framesSinceUpdate = 0;
    this.#lastTickTime = 0;
    this.#renderIndex = 0;
    this.#renderCount = 0;
    this.#fpsIndex = 0;
    this.#fpsCount = 0;
    this.#lastEntityCount = 0;
    this.#lastRenderedCount = 0;
    this.#snapshot = EMPTY_SNAPSHOT;
    if (this.#element) {
      this.#element.textContent = "";
    }
  }

  #computePercentiles(ring: Float64Array, count: number): { median: number; p95: number } {
    if (count === 0) return { median: 0, p95: 0 };

    const filled = new Float64Array(count);
    filled.set(ring.subarray(0, count));
    filled.sort();

    return {
      median: filled[Math.floor(count * 0.5)]!,
      p95: filled[Math.floor(count * 0.95)]!,
    };
  }
}

export const perfOverlay = new PerfOverlayController();
