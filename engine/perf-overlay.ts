/**
 * Performance overlay controller.
 * Collects FPS history plus render-time percentiles while debug mode is active.
 */

export interface FrameStats {
  renderTime: number;
  entityCount: number;
  renderedCount: number;
}

export interface PerfOverlaySnapshot {
  fps: number;
  fpsLow1: number;
  frameWorstMs: number;
  fpsHistory: number[];
  renderMedianMs: number;
  renderP95Ms: number;
  entityCount: number;
  renderedCount: number;
  sampleCount: number;
  text: string;
}

const RING_SIZE = 300; // 5 seconds at 60fps
const SNAPSHOT_INTERVAL_MS = 120;
const EMPTY_SNAPSHOT: PerfOverlaySnapshot = {
  fps: 0,
  fpsLow1: 0,
  frameWorstMs: 0,
  fpsHistory: [],
  renderMedianMs: 0,
  renderP95Ms: 0,
  entityCount: 0,
  renderedCount: 0,
  sampleCount: 0,
  text: "",
};

class PerfOverlayController {
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

  #lastSnapshotTime = 0;
  #lastEntityCount = 0;
  #lastRenderedCount = 0;

  getSnapshot(): PerfOverlaySnapshot {
    return this.#snapshot;
  }

  /**
   * Record a frame sample and optionally update the overlay.
   * Called by the game loop after every rendered frame.
   */
  tick(stats: FrameStats, debugMode: boolean): void {
    if (!debugMode) {
      if (this.#visible) this.#reset();
      this.#visible = false;
      return;
    }
    this.#visible = true;

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

    if (this.#snapshot.sampleCount > 0 && now - this.#lastSnapshotTime < SNAPSHOT_INTERVAL_MS) {
      return;
    }
    this.#lastSnapshotTime = now;

    const render = this.#computePercentiles(this.#renderSamples, this.#renderCount);
    const frame = this.#computeFrameStats(this.#fpsSamples, this.#fpsCount);
    const fps = frame.medianMs > 0 ? Math.round(1000 / frame.medianMs) : 0;
    const fpsLow1 = frame.p99Ms > 0 ? Math.round(1000 / frame.p99Ms) : 0;
    const { history: fpsHistory } = this.#extractRecentFpsHistory(120);

    const text = `${fps} fps | ${render.median.toFixed(1)}ms med | ${render.p95.toFixed(1)}ms p95 | ${this.#lastRenderedCount}/${this.#lastEntityCount} entities`;
    this.#snapshot = {
      fps,
      fpsLow1,
      frameWorstMs: frame.maxMs,
      fpsHistory,
      renderMedianMs: render.median,
      renderP95Ms: render.p95,
      entityCount: this.#lastEntityCount,
      renderedCount: this.#lastRenderedCount,
      sampleCount: this.#renderCount,
      text,
    };
  }

  #reset(): void {
    this.#lastTickTime = 0;
    this.#lastSnapshotTime = 0;
    this.#renderIndex = 0;
    this.#renderCount = 0;
    this.#fpsIndex = 0;
    this.#fpsCount = 0;
    this.#lastEntityCount = 0;
    this.#lastRenderedCount = 0;
    this.#snapshot = EMPTY_SNAPSHOT;
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

  #computeFrameStats(
    ring: Float64Array,
    count: number,
  ): { medianMs: number; p99Ms: number; maxMs: number } {
    if (count === 0) return { medianMs: 0, p99Ms: 0, maxMs: 0 };

    const filled = new Float64Array(count);
    filled.set(ring.subarray(0, count));
    filled.sort();

    return {
      medianMs: filled[Math.floor(count * 0.5)]!,
      p99Ms: filled[Math.floor(count * 0.99)]!,
      maxMs: filled[count - 1]!,
    };
  }

  #extractRecentFpsHistory(maxPoints: number): { history: number[] } {
    if (this.#fpsCount === 0) return { history: [] };

    const rawPoints = this.#fpsCount;
    const start = this.#fpsCount === RING_SIZE ? this.#fpsIndex : 0;
    const recent = new Array<number>(rawPoints);

    for (let i = 0; i < rawPoints; i++) {
      const ringIndex = (start + i) % RING_SIZE;
      const frameInterval = this.#fpsSamples[ringIndex]!;
      const fps = frameInterval > 0 ? 1000 / frameInterval : 0;
      recent[i] = fps;
    }

    if (recent.length <= maxPoints) {
      return { history: recent };
    }

    const bucketSize = recent.length / maxPoints;
    const history = new Array<number>(maxPoints);

    for (let i = 0; i < maxPoints; i++) {
      const bucketStart = Math.floor(i * bucketSize);
      const bucketEnd = Math.max(bucketStart + 1, Math.floor((i + 1) * bucketSize));
      let total = 0;
      let count = 0;

      for (let j = bucketStart; j < bucketEnd && j < recent.length; j++) {
        total += recent[j]!;
        count++;
      }

      history[i] = count > 0 ? total / count : 0;
    }

    return { history };
  }
}

export const perfOverlay = new PerfOverlayController();
