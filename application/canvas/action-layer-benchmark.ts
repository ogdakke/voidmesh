import type { FrameStats, PerformanceFrameObserver } from "#engine";
import type { Point } from "#types/canvas.ts";

export interface ActionLayerBenchmarkConfig {
  targetFps: number;
  warmupMs: number;
  baselineMs: number;
  cycles: number;
  longPressDelayMs: number;
  activeMs: number;
  recoveryGapMs: number;
  recoveryMs: number;
}

export interface ActionLayerBenchmarkWorkload {
  selectedEntityIds: string[];
  entityCount: number;
  visibleEntityCount: number;
  selectedEntityCount: number;
  imageCount: number;
  svgCount: number;
  videoCount: number;
  playingVideoCount: number;
  gifCount: number;
  playingGifCount: number;
}

export interface ActionLayerBenchmarkEnvironment {
  benchmarkLabel: string | null;
  url: string;
  userAgent: string;
  hardwareConcurrency: number | null;
  devicePixelRatio: number;
  viewportCssWidth: number;
  viewportCssHeight: number;
  displayP3: boolean;
  documentVisible: boolean;
}

export interface DistributionSummary {
  count: number;
  min: number;
  median: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface BenchmarkCadenceSummary {
  frameCount: number;
  fps: number;
  intervalMs: DistributionSummary;
  overBudgetPercent: number;
  missedRefreshPercent: number;
}

export interface BenchmarkRenderSummary extends BenchmarkCadenceSummary {
  cpuRenderMs: DistributionSummary;
  phasesMs: {
    setup: DistributionSummary;
    prepare: DistributionSummary;
    batchAdmission: DistributionSummary;
    spatialQuery: DistributionSummary;
    visibleEntityPreparation: DistributionSummary;
    encode: DistributionSummary;
    submit: DistributionSummary;
  };
  entityCount: number;
  renderedCount: number;
}

export interface ActionLayerBenchmarkPhaseResult {
  durationMs: number;
  raf: BenchmarkCadenceSummary;
  rendered: BenchmarkRenderSummary;
  raw: {
    rafIntervalsMs: number[];
    renderedIntervalsMs: number[];
    cpuRenderMs: number[];
  };
}

export interface ActionLayerBenchmarkResult {
  schemaVersion: 1;
  scenario: "action-layer-long-press-current-canvas";
  runId: string;
  recordedAt: string;
  config: ActionLayerBenchmarkConfig;
  environment: ActionLayerBenchmarkEnvironment;
  workload: ActionLayerBenchmarkWorkload;
  phases: {
    baseline: ActionLayerBenchmarkPhaseResult;
    toggling: ActionLayerBenchmarkPhaseResult;
    recovery: ActionLayerBenchmarkPhaseResult;
  };
  resources: {
    before: unknown;
    after: unknown;
  };
  validity: {
    accepted: boolean;
    reasons: string[];
    cadenceStability: {
      recoveryToBaselineRenderedFps: number;
      recoveryToBaselineRafP95: number;
      stable: boolean;
    };
  };
}

interface RecordedRenderSample {
  timestamp: number;
  stats: FrameStats;
}

interface PhaseSamples {
  startedAt: number;
  endedAt: number;
  rafTimestamps: number[];
  renderSamples: RecordedRenderSample[];
}

export interface ActionLayerBenchmarkDependencies {
  now(): number;
  wait(durationMs: number, signal: AbortSignal): Promise<void>;
  observeFrames(observer: PerformanceFrameObserver): () => void;
  getSelectedEntityIds(): ReadonlySet<string>;
  getTouchOrigin(): Point | null;
  getWorkload(): ActionLayerBenchmarkWorkload;
  getEnvironment(): ActionLayerBenchmarkEnvironment;
  getResourceStats(): unknown;
  getActiveActionLayerEntityIds(): ReadonlySet<string> | null;
  press(touchOrigin: Point, eventTime: number): void;
  release(eventTime: number): void;
  reset(): void;
}

export interface ActionLayerBenchmarkService {
  run(): Promise<ActionLayerBenchmarkResult>;
  cancel(): void;
  readonly running: boolean;
}

export const DEFAULT_ACTION_LAYER_BENCHMARK_CONFIG: ActionLayerBenchmarkConfig = {
  targetFps: 120,
  warmupMs: 2500,
  baselineMs: 3000,
  cycles: 120,
  longPressDelayMs: 400,
  activeMs: 209,
  recoveryGapMs: 0,
  recoveryMs: 3000,
};

const EMPTY_DISTRIBUTION: DistributionSummary = {
  count: 0,
  min: 0,
  median: 0,
  p95: 0,
  p99: 0,
  max: 0,
  mean: 0,
};

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)]!;
}

export function summarizeDistribution(values: readonly number[]): DistributionSummary {
  if (values.length === 0) return { ...EMPTY_DISTRIBUTION };
  const sorted = [...values].sort((a, b) => a - b);
  let total = 0;
  for (const value of sorted) total += value;
  return {
    count: sorted.length,
    min: round(sorted[0]!),
    median: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted[sorted.length - 1]!),
    mean: round(total / sorted.length),
  };
}

function intervals(timestamps: readonly number[]): number[] {
  const result: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const interval = timestamps[i]! - timestamps[i - 1]!;
    if (Number.isFinite(interval) && interval >= 0) result.push(round(interval));
  }
  return result;
}

function cadenceSummary(
  timestamps: readonly number[],
  durationMs: number,
  targetFps: number,
): BenchmarkCadenceSummary {
  const frameIntervals = intervals(timestamps);
  const budgetMs = 1000 / targetFps;
  let overBudget = 0;
  let missedRefresh = 0;
  for (const interval of frameIntervals) {
    if (interval > budgetMs) overBudget++;
    if (interval > budgetMs * 1.5) missedRefresh++;
  }
  return {
    frameCount: timestamps.length,
    fps: durationMs > 0 ? round((timestamps.length * 1000) / durationMs) : 0,
    intervalMs: summarizeDistribution(frameIntervals),
    overBudgetPercent:
      frameIntervals.length > 0 ? round((overBudget / frameIntervals.length) * 100) : 0,
    missedRefreshPercent:
      frameIntervals.length > 0 ? round((missedRefresh / frameIntervals.length) * 100) : 0,
  };
}

function copyFrameStats(stats: FrameStats): FrameStats {
  return {
    renderTime: stats.renderTime,
    entityCount: stats.entityCount,
    renderedCount: stats.renderedCount,
    phases: stats.phases ? { ...stats.phases } : undefined,
  };
}

function summarizePhase(samples: PhaseSamples, targetFps: number): ActionLayerBenchmarkPhaseResult {
  const durationMs = Math.max(0, samples.endedAt - samples.startedAt);
  const renderTimestamps = samples.renderSamples.map((sample) => sample.timestamp);
  const cpuRenderMs = samples.renderSamples.map((sample) => sample.stats.renderTime);
  const phaseValues = (key: keyof NonNullable<FrameStats["phases"]>) =>
    samples.renderSamples.flatMap((sample) => {
      const phases = sample.stats.phases;
      return phases ? [phases[key]] : [];
    });
  const lastStats = samples.renderSamples.at(-1)?.stats;
  return {
    durationMs: round(durationMs),
    raf: cadenceSummary(samples.rafTimestamps, durationMs, targetFps),
    rendered: {
      ...cadenceSummary(renderTimestamps, durationMs, targetFps),
      cpuRenderMs: summarizeDistribution(cpuRenderMs),
      phasesMs: {
        setup: summarizeDistribution(phaseValues("setupMs")),
        prepare: summarizeDistribution(phaseValues("prepareMs")),
        batchAdmission: summarizeDistribution(phaseValues("batchAdmissionMs")),
        spatialQuery: summarizeDistribution(phaseValues("spatialQueryMs")),
        visibleEntityPreparation: summarizeDistribution(phaseValues("visibleEntityPreparationMs")),
        encode: summarizeDistribution(phaseValues("encodeMs")),
        submit: summarizeDistribution(phaseValues("submitMs")),
      },
      entityCount: lastStats?.entityCount ?? 0,
      renderedCount: lastStats?.renderedCount ?? 0,
    },
    raw: {
      rafIntervalsMs: intervals(samples.rafTimestamps),
      renderedIntervalsMs: intervals(renderTimestamps),
      cpuRenderMs: cpuRenderMs.map((value) => round(value)),
    },
  };
}

function createPhase(now: number): PhaseSamples {
  return { startedAt: now, endedAt: now, rafTimestamps: [], renderSamples: [] };
}

function waitWithSignal(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      window.clearTimeout(timeoutId);
      reject(signal.reason);
    };
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, durationMs);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export function createActionLayerBenchmarkService(
  dependencies: Omit<ActionLayerBenchmarkDependencies, "wait"> & {
    wait?: ActionLayerBenchmarkDependencies["wait"];
  },
  config: ActionLayerBenchmarkConfig = DEFAULT_ACTION_LAYER_BENCHMARK_CONFIG,
): ActionLayerBenchmarkService {
  const deps: ActionLayerBenchmarkDependencies = {
    ...dependencies,
    wait: dependencies.wait ?? waitWithSignal,
  };
  let controller: AbortController | null = null;

  return {
    get running() {
      return controller !== null;
    },
    cancel() {
      controller?.abort(new DOMException("Benchmark cancelled", "AbortError"));
    },
    async run() {
      if (controller) throw new Error("The action-layer benchmark is already running");
      const selectedEntityIds = new Set(deps.getSelectedEntityIds());
      if (selectedEntityIds.size === 0) {
        throw new Error("Select the entity or entities to benchmark before starting");
      }
      const touchOrigin = deps.getTouchOrigin();
      if (!touchOrigin) {
        throw new Error(
          "Long-press the target once at the exact test point, release it, then start the benchmark",
        );
      }

      controller = new AbortController();
      const signal = controller.signal;
      const workload = deps.getWorkload();
      const environment = deps.getEnvironment();
      const phases = {
        baseline: createPhase(0),
        toggling: createPhase(0),
        recovery: createPhase(0),
      };
      let activePhase: PhaseSamples | null = null;
      const stopObserving = deps.observeFrames({
        onAnimationFrame(timestamp) {
          activePhase?.rafTimestamps.push(timestamp);
        },
        onRender(stats, timestamp) {
          activePhase?.renderSamples.push({ timestamp, stats: copyFrameStats(stats) });
        },
      });

      const recordFor = async (phase: PhaseSamples, durationMs: number) => {
        phase.startedAt = deps.now();
        activePhase = phase;
        await deps.wait(durationMs, signal);
        phase.endedAt = deps.now();
        activePhase = null;
      };

      try {
        deps.reset();
        await deps.wait(config.warmupMs, signal);
        const resourcesBefore = deps.getResourceStats();
        await recordFor(phases.baseline, config.baselineMs);

        phases.toggling.startedAt = deps.now();
        activePhase = phases.toggling;
        for (let cycle = 0; cycle < config.cycles; cycle++) {
          deps.press(touchOrigin, deps.now());
          await deps.wait(config.longPressDelayMs, signal);
          const activeEntityIds = deps.getActiveActionLayerEntityIds();
          if (!activeEntityIds || !setsEqual(activeEntityIds, selectedEntityIds)) {
            throw new Error(
              "The recorded press point did not activate the selected benchmark target",
            );
          }
          await deps.wait(config.activeMs, signal);
          deps.release(deps.now());
          if (config.recoveryGapMs > 0) await deps.wait(config.recoveryGapMs, signal);
        }
        phases.toggling.endedAt = deps.now();
        activePhase = null;

        await recordFor(phases.recovery, config.recoveryMs);
        const resourcesAfter = deps.getResourceStats();
        const environmentAfter = deps.getEnvironment();
        const summarized = {
          baseline: summarizePhase(phases.baseline, config.targetFps),
          toggling: summarizePhase(phases.toggling, config.targetFps),
          recovery: summarizePhase(phases.recovery, config.targetFps),
        };
        const baselineFps = summarized.baseline.rendered.fps;
        const recoveryFps = summarized.recovery.rendered.fps;
        const baselineRafP95 = summarized.baseline.raf.intervalMs.p95;
        const recoveryRafP95 = summarized.recovery.raf.intervalMs.p95;
        const fpsRatio = baselineFps > 0 ? recoveryFps / baselineFps : 0;
        const rafP95Ratio = baselineRafP95 > 0 ? recoveryRafP95 / baselineRafP95 : 0;
        const stable = fpsRatio >= 0.9 && rafP95Ratio <= 1.2;
        const reasons: string[] = [];
        if (!environment.documentVisible) reasons.push("The document was not visible at start");
        if (!environmentAfter.documentVisible) reasons.push("The document was not visible at end");
        if (summarized.baseline.rendered.frameCount < 30) {
          reasons.push("Baseline produced fewer than 30 rendered frames");
        }
        if (summarized.toggling.rendered.frameCount < 30) {
          reasons.push("Toggle phase produced fewer than 30 rendered frames");
        }
        if (summarized.baseline.raf.fps < config.targetFps * 0.9) {
          reasons.push(
            `Observed rAF cadence was below the ${config.targetFps} FPS benchmark target`,
          );
        }
        if (!stable) reasons.push("Recovery cadence drifted more than the stability limit");

        return {
          schemaVersion: 1,
          scenario: "action-layer-long-press-current-canvas",
          runId: crypto.randomUUID(),
          recordedAt: new Date().toISOString(),
          config,
          environment: environmentAfter,
          workload,
          phases: summarized,
          resources: { before: resourcesBefore, after: resourcesAfter },
          validity: {
            accepted: reasons.length === 0,
            reasons,
            cadenceStability: {
              recoveryToBaselineRenderedFps: round(fpsRatio),
              recoveryToBaselineRafP95: round(rafP95Ratio),
              stable,
            },
          },
        } satisfies ActionLayerBenchmarkResult;
      } finally {
        activePhase = null;
        stopObserving();
        deps.reset();
        controller = null;
      }
    },
  };
}
