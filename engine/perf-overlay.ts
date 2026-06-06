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
}

const RING_SIZE = 300; // 5 seconds at 60fps

class PerfOverlayController {
  #element: HTMLElement | null = null;
  #cachedText = "";
  #visible = false;

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

  setElement(element: HTMLElement): void {
    this.#element = element;
  }

  /**
   * Record a frame sample and optionally update the overlay.
   * Called by the game loop after every rendered frame.
   */
  tick(stats: FrameStats, debugMode: boolean): void {
    if (!this.#element) return;

    // Toggle visibility
    if (debugMode !== this.#visible) {
      this.#element.style.display = debugMode ? "block" : "none";
      this.#visible = debugMode;
      if (!debugMode) {
        this.#lastTickTime = 0;
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

    // Update text at ~2Hz
    this.#framesSinceUpdate++;
    if (this.#framesSinceUpdate < 30) return;
    this.#framesSinceUpdate = 0;

    const render = this.#computePercentiles(this.#renderSamples, this.#renderCount);
    const frame = this.#computePercentiles(this.#fpsSamples, this.#fpsCount);
    const fps = frame.median > 0 ? Math.round(1000 / frame.median) : 0;

    const text = `${fps} fps | cpu ${render.median.toFixed(1)}ms med | ${render.p95.toFixed(1)}ms p95 | ${this.#lastRenderedCount}/${this.#lastEntityCount} entities`;

    if (text !== this.#cachedText) {
      this.#element.textContent = text;
      this.#cachedText = text;
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
