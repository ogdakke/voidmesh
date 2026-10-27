import { describe, expect, test } from "vitest";
import {
  createActionLayerBenchmarkService,
  summarizeDistribution,
  type ActionLayerBenchmarkConfig,
} from "#application/canvas/action-layer-benchmark.ts";
import type { PerformanceFrameObserver } from "#engine";

describe("action-layer benchmark", () => {
  test("summarizes distributions without mutating the samples", () => {
    const values = [8, 2, 4, 6];

    expect(summarizeDistribution(values)).toEqual({
      count: 4,
      min: 2,
      median: 4,
      p95: 8,
      p99: 8,
      max: 8,
      mean: 5,
    });
    expect(values).toEqual([8, 2, 4, 6]);
  });

  test("records baseline, toggle, and recovery from the same frame observer", async () => {
    let now = 0;
    let observer: PerformanceFrameObserver | null = null;
    let activations = 0;
    let dismissals = 0;
    let active = false;
    const instrumentationStates: boolean[] = [];
    const config: ActionLayerBenchmarkConfig = {
      targetFps: 120,
      warmupMs: 20,
      baselineMs: 40,
      cycles: 2,
      longPressDelayMs: 20,
      activeMs: 20,
      recoveryGapMs: 20,
      recoveryMs: 40,
    };
    const service = createActionLayerBenchmarkService(
      {
        now: () => now,
        wait: async (durationMs, signal) => {
          if (signal.aborted) throw signal.reason;
          const end = now + durationMs;
          while (now + 10 <= end) {
            now += 10;
            observer?.onAnimationFrame(now);
            observer?.onRender(
              {
                renderTime: 3,
                entityCount: 60,
                renderedCount: 20,
                phases: {
                  setupMs: 0.1,
                  prepareMs: 0.5,
                  batchAdmissionMs: 0.1,
                  spatialQueryMs: 0.1,
                  visibleEntityPreparationMs: 0.3,
                  encodeMs: 1.5,
                  submitMs: 0.2,
                  frameSetupMs: 0.1,
                  swapchainAcquireMs: 0.1,
                  gridMs: 0.1,
                  sceneCompositionMs: 0.2,
                  actionBlurMs: 0.4,
                  sharpRestoreMs: 0.2,
                  actionForegroundMs: 0.2,
                  auxiliaryOverlaysMs: 0.1,
                  lensMs: 0.1,
                  wlurMs: 0.3,
                },
              },
              now + 3,
            );
          }
        },
        observeFrames: (nextObserver) => {
          observer = nextObserver;
          return () => {
            observer = null;
          };
        },
        getSelectedEntityIds: () => new Set(["entity-1"]),
        getTouchOrigin: () => ({ x: 100, y: 200 }),
        getWorkload: () => ({
          selectedEntityIds: ["entity-1"],
          entityCount: 60,
          visibleEntityCount: 20,
          selectedEntityCount: 1,
          imageCount: 57,
          svgCount: 0,
          videoCount: 2,
          playingVideoCount: 2,
          gifCount: 1,
          playingGifCount: 1,
        }),
        getEnvironment: () => ({
          benchmarkLabel: "test",
          url: "https://example.test/?benchmark=overlap",
          userAgent: "test",
          hardwareConcurrency: 6,
          devicePixelRatio: 3,
          viewportCssWidth: 390,
          viewportCssHeight: 844,
          displayP3: true,
          documentVisible: true,
        }),
        getResourceStats: () => ({ allocations: 1 }),
        getActiveActionLayerEntityIds: () => (active ? new Set(["entity-1"]) : null),
        press: () => {
          activations++;
          active = true;
        },
        release: () => {
          dismissals++;
          active = false;
        },
        reset: () => {
          active = false;
        },
        setDetailedFrameInstrumentation: (enabled) => {
          instrumentationStates.push(enabled);
        },
      },
      config,
    );

    const result = await service.run();

    expect(activations).toBe(2);
    expect(dismissals).toBe(2);
    expect(result.phases.baseline.rendered.frameCount).toBe(4);
    expect(result.phases.toggling.rendered.frameCount).toBe(12);
    expect(result.phases.recovery.rendered.frameCount).toBe(4);
    expect(result.phases.toggling.rendered.cpuRenderMs.median).toBe(3);
    expect(result.phases.toggling.rendered.phasesMs.actionBlur.mean).toBe(0.4);
    expect(result.phases.toggling.raw.detailedPhasesMs.wlur).toHaveLength(12);
    expect(result.phases.toggling.raw.detailedPhasesMs.encode).toHaveLength(12);
    expect(result.phases.toggling.raw.detailedPhasesMs.actionForeground).toHaveLength(12);
    expect(instrumentationStates).toEqual([true, false]);
    expect(result.validity.cadenceStability.stable).toBe(true);
  });
});
