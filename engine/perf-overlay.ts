import { PerfGraphRenderer } from "../renderer/perf-graph-renderer.ts";

export interface FrameStats {
  renderTime: number;
  entityCount: number;
  renderedCount: number;
}

export type PerfOverlayMode = "raf" | "rendered";

interface FpsSeries {
  samples: Float32Array;
  index: number;
  count: number;
  lastEventTime: number;
  windowStartTime: number;
  windowFrames: number;
  liveFps: number;
  scaleMax: number;
}

interface RenderTimeStats {
  samples: Float64Array;
  index: number;
  count: number;
}

interface RecordedSample {
  index: number;
  value: number;
}

export interface PerfOverlaySnapshot {
  mode: PerfOverlayMode;
  rafFps: number;
  renderedFps: number;
  currentFps: number;
  scaleMax: number;
  sampleCount: number;
}

const SAMPLE_COUNT = 300;
const GRAPH_RENDER_INTERVAL_MS = 1000;
const TEXT_UPDATE_INTERVAL_MS = 250;
const SCALE_DECAY = 0.08;

function createSeries(): FpsSeries {
  return {
    samples: new Float32Array(SAMPLE_COUNT),
    index: 0,
    count: 0,
    lastEventTime: 0,
    windowStartTime: 0,
    windowFrames: 0,
    liveFps: 0,
    scaleMax: 60,
  };
}

function createRenderTimeStats(): RenderTimeStats {
  return {
    samples: new Float64Array(SAMPLE_COUNT),
    index: 0,
    count: 0,
  };
}

export class PerfOverlayController {
  #element: HTMLElement | null = null;
  #labelElement: HTMLSpanElement | null = null;
  #modeElement: HTMLSpanElement | null = null;
  #cpuMedianElement: HTMLSpanElement | null = null;
  #cpuP95Element: HTMLSpanElement | null = null;
  #entitiesElement: HTMLSpanElement | null = null;
  #graphCanvas: HTMLCanvasElement | null = null;
  #graphRenderer: PerfGraphRenderer | null = null;
  #device: GPUDevice | null = null;
  #canvasFormat: GPUTextureFormat | null = null;
  #canvasColorSpace: PredefinedColorSpace = "srgb";
  #visible = false;
  #mode: PerfOverlayMode = "raf";
  #raf = createSeries();
  #rendered = createSeries();
  #renderTime = createRenderTimeStats();
  #lastEntityCount = 0;
  #lastRenderedCount = 0;
  #cachedLabel = 0;
  #cachedMode = "";
  #cachedCpuMedian = "";
  #cachedCpuP95 = "";
  #cachedEntities = "";
  #lastGraphRenderTime = 0;
  #lastTextUpdateTime = 0;

  readonly #handleToggle = (): void => {
    this.#mode = this.#mode === "raf" ? "rendered" : "raf";
    const now = performance.now();
    this.#uploadCurrentGraphSeries();
    this.#updateText(now, true);
    this.#renderGraph(now, true);
  };

  readonly #handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " ") return;

    event.preventDefault();
    this.#handleToggle();
  };

  setElement(element: HTMLElement): void {
    if (this.#element === element) return;

    this.#element?.removeEventListener("click", this.#handleToggle);
    this.#element?.removeEventListener("keydown", this.#handleKeyDown);
    this.#element = element;
    this.#element.textContent = "";
    this.#element.setAttribute("role", "button");
    this.#element.setAttribute("tabindex", "0");
    this.#element.title = "Click to switch between rAF FPS and rendered FPS";
    this.#element.addEventListener("click", this.#handleToggle);
    this.#element.addEventListener("keydown", this.#handleKeyDown);

    const header = document.createElement("div");
    header.className = "perf-overlay__header";

    const label = document.createElement("span");
    label.className = "perf-overlay__fps";
    label.textContent = "0 FPS";
    label.title = "Current frames per second for the selected graph mode.";

    const mode = document.createElement("span");
    mode.className = "perf-overlay__mode";
    mode.textContent = "rAF";
    mode.title =
      "Current graph mode. Click the overlay to switch between rAF FPS and rendered FPS.";

    header.append(label, mode);

    const graphCanvas = document.createElement("canvas");
    graphCanvas.className = "perf-overlay__graph";
    graphCanvas.title =
      "FPS over one-second windows. Taller bars are faster frames; dips show slowdowns.";

    const detail = document.createElement("div");
    detail.className = "perf-overlay__detail";

    const cpuMedian = document.createElement("span");
    cpuMedian.className = "perf-overlay__stat";
    cpuMedian.textContent = "CPU 0.0ms";
    cpuMedian.title = "Median CPU render time in milliseconds.";

    const cpuP95 = document.createElement("span");
    cpuP95.className = "perf-overlay__stat";
    cpuP95.textContent = "p95 0.0ms";
    cpuP95.title = "95th percentile CPU render time in milliseconds.";

    const entities = document.createElement("span");
    entities.className = "perf-overlay__stat";
    entities.textContent = "0/0";
    entities.title = "Rendered entities / total entities.";

    detail.append(cpuMedian, cpuP95, entities);

    this.#element.append(header, graphCanvas, detail);
    this.#labelElement = label;
    this.#modeElement = mode;
    this.#cpuMedianElement = cpuMedian;
    this.#cpuP95Element = cpuP95;
    this.#entitiesElement = entities;
    this.#graphCanvas = graphCanvas;
    this.#cachedLabel = 0;
    this.#cachedMode = "";
    this.#cachedCpuMedian = "";
    this.#cachedCpuP95 = "";
    this.#cachedEntities = "";
    this.#createGraphRenderer();
  }

  setRenderer(
    device: GPUDevice | null,
    canvasFormat: GPUTextureFormat | null,
    canvasColorSpace: PredefinedColorSpace = "srgb",
  ): void {
    if (
      this.#device === device &&
      this.#canvasFormat === canvasFormat &&
      this.#canvasColorSpace === canvasColorSpace
    ) {
      return;
    }

    this.#graphRenderer?.destroy();
    this.#graphRenderer = null;
    this.#device = device;
    this.#canvasFormat = canvasFormat;
    this.#canvasColorSpace = canvasColorSpace;
    this.#createGraphRenderer();
  }

  onFrame(debugMode: boolean, timestamp = performance.now()): void {
    if (!this.#element) return;

    this.#setVisible(debugMode);
    if (!debugMode) return;

    const sample = this.#recordEvent(this.#raf, timestamp);
    if (this.#mode === "raf") this.#uploadGraphSample(sample);
    const renderedIdleSample = this.#advanceIdleWindow(this.#rendered, timestamp);
    if (this.#mode === "rendered") this.#uploadGraphSample(renderedIdleSample);
    this.#updateText(timestamp);
    this.#renderGraph(timestamp);
  }

  onRender(stats: FrameStats, debugMode: boolean, timestamp = performance.now()): void {
    if (!this.#element) return;

    this.#setVisible(debugMode);
    if (!debugMode) return;

    const sample = this.#recordEvent(this.#rendered, timestamp);
    if (this.#mode === "rendered") this.#uploadGraphSample(sample);
    this.#addRenderTimeSample(stats.renderTime);
    this.#lastEntityCount = stats.entityCount;
    this.#lastRenderedCount = stats.renderedCount;
    this.#updateText(timestamp);
    if (this.#mode === "rendered") this.#renderGraph(timestamp);
  }

  getSnapshot(): PerfOverlaySnapshot {
    const series = this.#currentSeries;
    return {
      mode: this.#mode,
      rafFps: this.#raf.liveFps,
      renderedFps: this.#rendered.liveFps,
      currentFps: series.liveFps,
      scaleMax: series.scaleMax,
      sampleCount: series.count,
    };
  }

  destroy(): void {
    this.#element?.removeEventListener("click", this.#handleToggle);
    this.#element?.removeEventListener("keydown", this.#handleKeyDown);
    this.#graphRenderer?.destroy();
    this.#graphRenderer = null;
    this.#element = null;
    this.#labelElement = null;
    this.#modeElement = null;
    this.#cpuMedianElement = null;
    this.#cpuP95Element = null;
    this.#entitiesElement = null;
    this.#graphCanvas = null;
  }

  get #currentSeries(): FpsSeries {
    return this.#mode === "raf" ? this.#raf : this.#rendered;
  }

  #createGraphRenderer(): void {
    if (!this.#graphCanvas || !this.#device || !this.#canvasFormat) return;

    try {
      this.#graphRenderer = new PerfGraphRenderer(
        this.#graphCanvas,
        this.#device,
        this.#canvasFormat,
        this.#canvasColorSpace,
      );
      this.#uploadCurrentGraphSeries();
      this.#renderGraph(performance.now(), true);
    } catch (error) {
      console.warn("[PerfOverlay] Failed to initialize WebGPU graph", error);
      this.#graphRenderer = null;
    }
  }

  #setVisible(visible: boolean): void {
    if (!this.#element || visible === this.#visible) return;

    this.#element.style.display = visible ? "grid" : "none";
    this.#visible = visible;
    if (!visible) {
      this.#resetRuntimeState();
    }
  }

  #resetRuntimeState(): void {
    this.#raf = createSeries();
    this.#rendered = createSeries();
    this.#renderTime = createRenderTimeStats();
    this.#lastEntityCount = 0;
    this.#lastRenderedCount = 0;
    this.#cachedLabel = 0;
    this.#cachedMode = "";
    this.#cachedCpuMedian = "";
    this.#cachedCpuP95 = "";
    this.#cachedEntities = "";
    this.#lastGraphRenderTime = 0;
    this.#lastTextUpdateTime = 0;
  }

  #recordEvent(series: FpsSeries, timestamp: number): RecordedSample | null {
    if (series.windowStartTime === 0) {
      series.windowStartTime = timestamp;
      series.lastEventTime = timestamp;
      return null;
    } else {
      series.windowFrames++;
    }

    series.lastEventTime = timestamp;
    return this.#advanceWindow(series, timestamp);
  }

  #advanceWindow(series: FpsSeries, timestamp: number): RecordedSample | null {
    if (series.windowStartTime === 0) return null;

    const elapsed = timestamp - series.windowStartTime;
    if (elapsed < 1000) return null;

    series.liveFps = elapsed > 0 ? (series.windowFrames * 1000) / elapsed : 0;
    series.windowFrames = 0;
    series.windowStartTime = timestamp;
    return this.#addFpsSample(series, series.liveFps);
  }

  #advanceIdleWindow(series: FpsSeries, timestamp: number): RecordedSample | null {
    if (series.lastEventTime === 0 || timestamp - series.lastEventTime < 1000) return null;
    if (series.windowStartTime === 0 || timestamp - series.windowStartTime < 1000) return null;

    series.liveFps = 0;
    series.windowFrames = 0;
    series.windowStartTime = timestamp;
    return this.#addFpsSample(series, 0);
  }

  #addFpsSample(series: FpsSeries, fps: number): RecordedSample | null {
    if (!Number.isFinite(fps) || fps < 0) return null;

    const clamped = Math.min(fps, 1000);
    const index = series.index;
    series.samples[index] = clamped;
    series.index = (series.index + 1) % SAMPLE_COUNT;
    if (series.count < SAMPLE_COUNT) series.count++;
    this.#updateScale(series);
    return { index, value: clamped };
  }

  #updateScale(series: FpsSeries): void {
    let maxSample = 0;
    for (let i = 0; i < series.count; i++) {
      maxSample = Math.max(maxSample, series.samples[i] ?? 0);
    }

    const floor = maxSample > 65 ? 120 : 60;
    const target = maxSample <= 65 ? 60 : Math.max(floor, Math.ceil((maxSample * 1.1) / 10) * 10);
    if (target >= series.scaleMax) {
      series.scaleMax = target;
      return;
    }

    series.scaleMax = Math.max(target, series.scaleMax - (series.scaleMax - target) * SCALE_DECAY);
  }

  #addRenderTimeSample(renderTime: number): void {
    this.#renderTime.samples[this.#renderTime.index] = renderTime;
    this.#renderTime.index = (this.#renderTime.index + 1) % SAMPLE_COUNT;
    if (this.#renderTime.count < SAMPLE_COUNT) this.#renderTime.count++;
  }

  #updateText(timestamp: number, force = false): void {
    if (
      !this.#labelElement ||
      !this.#modeElement ||
      !this.#cpuMedianElement ||
      !this.#cpuP95Element ||
      !this.#entitiesElement
    ) {
      return;
    }
    if (!force && timestamp - this.#lastTextUpdateTime < TEXT_UPDATE_INTERVAL_MS) return;

    const series = this.#currentSeries;
    const latestSample =
      series.count > 0 ? series.samples[(series.index - 1 + SAMPLE_COUNT) % SAMPLE_COUNT]! : 0;
    const displayFps = series.liveFps > 0 ? series.liveFps : latestSample;
    const label = Math.round(displayFps);
    const mode = this.#mode === "raf" ? "rAF" : "rendered";
    const render = this.#computeRenderStats();
    const cpuMedian = `CPU ${render.median.toFixed(1)}ms`;
    const cpuP95 = `p95 ${render.p95.toFixed(1)}ms`;
    const entities = `${this.#lastRenderedCount}/${this.#lastEntityCount}`;

    if (label !== this.#cachedLabel) {
      this.#labelElement.textContent = label.toString();
      this.#cachedLabel = label;
    }
    if (mode !== this.#cachedMode) {
      this.#modeElement.textContent = mode;
      this.#cachedMode = mode;
    }
    if (cpuMedian !== this.#cachedCpuMedian) {
      this.#cpuMedianElement.textContent = cpuMedian;
      this.#cachedCpuMedian = cpuMedian;
    }
    if (cpuP95 !== this.#cachedCpuP95) {
      this.#cpuP95Element.textContent = cpuP95;
      this.#cachedCpuP95 = cpuP95;
    }
    if (entities !== this.#cachedEntities) {
      this.#entitiesElement.textContent = entities;
      this.#cachedEntities = entities;
    }
    this.#lastTextUpdateTime = timestamp;
  }

  #uploadGraphSample(sample: RecordedSample | null): void {
    if (!sample || !this.#graphRenderer) return;

    this.#graphRenderer.writeSample(sample.index, sample.value);
  }

  #uploadCurrentGraphSeries(): void {
    if (!this.#graphRenderer) return;

    this.#graphRenderer.uploadSeries(this.#currentSeries.samples);
  }

  #renderGraph(timestamp: number, force = false): void {
    if (!this.#visible || !this.#graphRenderer) return;
    if (!force && timestamp - this.#lastGraphRenderTime < GRAPH_RENDER_INTERVAL_MS) return;

    const series = this.#currentSeries;
    this.#graphRenderer.render(series.count, series.index, series.scaleMax);
    this.#lastGraphRenderTime = timestamp;
  }

  #computeRenderStats(): { median: number; p95: number } {
    const count = this.#renderTime.count;
    if (count === 0) return { median: 0, p95: 0 };

    const filled = new Float64Array(count);
    filled.set(this.#renderTime.samples.subarray(0, count));
    filled.sort();

    return {
      median: filled[Math.floor(count * 0.5)]!,
      p95: filled[Math.floor(count * 0.95)]!,
    };
  }
}

export const perfOverlay = new PerfOverlayController();
