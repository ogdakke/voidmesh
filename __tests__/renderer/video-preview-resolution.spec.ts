import {
  createVideoPreviewAdaptiveState,
  createVideoPreviewFrameGovernorState,
  recordVideoPreviewFrameGovernorSample,
  recordVideoPreviewRenderSample,
  resolveVideoPreviewResolution,
  type VideoPreviewAdaptiveConfig,
  type VideoPreviewAdaptiveState,
  type VideoPreviewQualityTransition,
} from "#renderer/video-preview-resolution.ts";
import { describe, expect, test } from "vitest";

const adaptiveConfig = {
  enabled: true,
  warmupSamples: 30,
  sampleWindow: 30,
  downgradeMedianMs: 18,
  downgradeP95Ms: 24,
  upgradeMedianMs: 12,
  upgradeP95Ms: 16,
  coolSamplesForUpgrade: 180,
  targetFrameRate: 120,
  minDetectedFrameRate: 50,
  displayEstimateStabilityMultiplier: 1.15,
  frameSampleWindow: 20,
  frameDowngradeMedianMultiplier: 1.2,
  frameDowngradeP95Multiplier: 1.6,
  frameUpgradeMedianMultiplier: 1.05,
  frameUpgradeP95Multiplier: 1.25,
  upgradeProbationSamples: 60,
  successfulUpgradeCooldownSamples: 300,
  failedUpgradeCooldownSamples: 900,
  failedUpgradeDetectionSamples: 120,
  failedUpgradeRetrySamples: 2_000,
  minLongEdge: 1280,
  projectedOversample: 1.25,
  bucketFactor: 1.25,
  zoomDownscaleIdleDelayMs: 250,
} satisfies VideoPreviewAdaptiveConfig;

function resolveVideo(
  state: VideoPreviewAdaptiveState,
  options: {
    originalSize?: { width: number; height: number };
    entitySize?: { width: number; height: number };
    viewportZoom?: number;
    nowMs?: number;
    isVideo?: boolean;
  } = {},
) {
  const originalSize = options.originalSize ?? { width: 3840, height: 2160 };
  return resolveVideoPreviewResolution(
    {
      isVideo: options.isVideo ?? true,
      originalSize,
      entitySize: options.entitySize ?? originalSize,
      viewportZoom: options.viewportZoom ?? 1,
      nowMs: options.nowMs ?? 0,
      state,
    },
    adaptiveConfig,
  );
}

function recordSlowWindow(state: VideoPreviewAdaptiveState): void {
  for (let i = 0; i < adaptiveConfig.sampleWindow; i++) {
    recordVideoPreviewRenderSample(state, 25, adaptiveConfig);
  }
}

function applyTransitions(
  states: Map<string, VideoPreviewAdaptiveState>,
  transitions: readonly VideoPreviewQualityTransition[],
): void {
  for (const transition of transitions) {
    if (!transition.entityId) continue;
    states.get(transition.entityId)!.quality = transition.to;
  }
}

function governorEntities(states: Map<string, VideoPreviewAdaptiveState>) {
  return [...states.entries()].map(([id, state]) => ({
    id,
    quality: state.quality,
    originalSize: { width: 3840, height: 2160 },
  }));
}

function governorEntitiesById(
  states: Map<string, VideoPreviewAdaptiveState>,
  ids: readonly string[],
) {
  return ids.map((id) => {
    const state = states.get(id)!;
    return {
      id,
      quality: state.quality,
      originalSize: { width: 3840, height: 2160 },
    };
  });
}

function createVideoStates(count: number): Map<string, VideoPreviewAdaptiveState> {
  return new Map(
    Array.from({ length: count }, (_, index) => [
      `entity-${index + 1}`,
      createVideoPreviewAdaptiveState(),
    ]),
  );
}

function stableSamplesFor(samples: number): number {
  return adaptiveConfig.frameSampleWindow + samples - 1;
}

describe("video preview adaptive resolution", () => {
  test("starts 4K video preview at full source resolution before pressure", () => {
    const state = createVideoPreviewAdaptiveState();

    for (let i = 0; i < adaptiveConfig.warmupSamples - 1; i++) {
      recordVideoPreviewRenderSample(state, 25, adaptiveConfig);
    }

    expect(state.quality).toBe("full");
    expect(resolveVideo(state)).toMatchObject({
      width: 3840,
      height: 2160,
      renderScale: 1,
    });
  });

  test("downgrades slow 4K video preview to 0.75x, then to the 720p floor", () => {
    const state = createVideoPreviewAdaptiveState();

    recordSlowWindow(state);
    expect(state.quality).toBe("threeQuarter");
    expect(resolveVideo(state)).toMatchObject({ width: 2880, height: 1620 });

    recordSlowWindow(state);
    expect(state.quality).toBe("floor");
    expect(resolveVideo(state)).toMatchObject({ width: 1280, height: 720 });
  });

  test("jumps directly to the floor when a slow window is far above threshold", () => {
    const state = createVideoPreviewAdaptiveState();
    const aggressiveConfig = {
      ...adaptiveConfig,
      downgradeMedianMs: 3,
      downgradeP95Ms: 8,
    };

    for (let i = 0; i < aggressiveConfig.sampleWindow; i++) {
      recordVideoPreviewRenderSample(state, 20, aggressiveConfig);
    }

    expect(state.quality).toBe("floor");
    expect(resolveVideo(state)).toMatchObject({ width: 1280, height: 720 });
  });

  test("uses rAF pacing to downgrade visible videos as a group", () => {
    const governor = createVideoPreviewFrameGovernorState();
    const states = createVideoStates(3);
    let transitions: VideoPreviewQualityTransition[] = [];

    for (let i = 0; i < adaptiveConfig.frameSampleWindow; i++) {
      transitions = recordVideoPreviewFrameGovernorSample(
        governor,
        governorEntities(states),
        1000 / 30,
        adaptiveConfig,
      );
    }
    applyTransitions(states, transitions);

    expect(transitions).toHaveLength(3);
    expect([...states.values()].map((state) => state.quality)).toEqual(["floor", "floor", "floor"]);
  });

  test("treats a stable 100Hz display as healthy and probes one upgrade at a time", () => {
    const governor = createVideoPreviewFrameGovernorState();
    const states = createVideoStates(3);
    for (const state of states.values()) {
      state.quality = "floor";
    }
    let transitions: VideoPreviewQualityTransition[] = [];

    const totalSamples = stableSamplesFor(adaptiveConfig.coolSamplesForUpgrade);
    for (let i = 0; i < totalSamples; i++) {
      transitions = recordVideoPreviewFrameGovernorSample(
        governor,
        governorEntities(states),
        10,
        adaptiveConfig,
      );
      applyTransitions(states, transitions);
    }

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      from: "floor",
      to: "threeQuarter",
    });
    expect([...states.values()].filter((state) => state.quality === "threeQuarter")).toHaveLength(
      1,
    );
    expect(governor.estimatedDisplayFrameMs).toBe(10);
  });

  test("reverts a failed upgrade probe and blocks repeated upgrades", () => {
    const governor = createVideoPreviewFrameGovernorState();
    governor.estimatedDisplayFrameMs = 10;
    const states = createVideoStates(3);
    for (const state of states.values()) {
      state.quality = "floor";
    }
    let transitions: VideoPreviewQualityTransition[] = [];

    const totalSamples = stableSamplesFor(adaptiveConfig.coolSamplesForUpgrade);
    for (let i = 0; i < totalSamples; i++) {
      transitions = recordVideoPreviewFrameGovernorSample(
        governor,
        governorEntities(states),
        10,
        adaptiveConfig,
      );
      applyTransitions(states, transitions);
    }
    expect([...states.values()].filter((state) => state.quality === "threeQuarter")).toHaveLength(
      1,
    );
    const upgradedEntityId = transitions[0]!.entityId!;

    for (let i = 0; i < adaptiveConfig.frameSampleWindow; i++) {
      transitions = recordVideoPreviewFrameGovernorSample(
        governor,
        governorEntities(states),
        22,
        adaptiveConfig,
      );
      applyTransitions(states, transitions);
    }
    expect(transitions).toEqual([
      expect.objectContaining({
        entityId: upgradedEntityId,
        from: "threeQuarter",
        to: "floor",
      }),
    ]);
    expect([...states.values()].map((state) => state.quality)).toEqual(["floor", "floor", "floor"]);
    expect(governor.upgradeBlockedSamples).toBeGreaterThan(0);

    for (let i = 0; i < totalSamples; i++) {
      transitions = recordVideoPreviewFrameGovernorSample(
        governor,
        governorEntities(states),
        10,
        adaptiveConfig,
      );
      applyTransitions(states, transitions);
    }
    expect(transitions).toHaveLength(0);
    expect([...states.values()].map((state) => state.quality)).toEqual(["floor", "floor", "floor"]);
  });

  test("remembers failed upgrade rungs for the same heavy visible workload", () => {
    const governor = createVideoPreviewFrameGovernorState();
    governor.estimatedDisplayFrameMs = 10;
    const states = createVideoStates(3);
    for (const state of states.values()) {
      state.quality = "floor";
    }
    let transitions: VideoPreviewQualityTransition[] = [];

    for (let i = 0; i < stableSamplesFor(adaptiveConfig.coolSamplesForUpgrade); i++) {
      transitions = recordVideoPreviewFrameGovernorSample(
        governor,
        governorEntities(states),
        10,
        adaptiveConfig,
      );
      applyTransitions(states, transitions);
    }
    expect(transitions).toHaveLength(1);

    for (let i = 0; i < adaptiveConfig.frameSampleWindow; i++) {
      transitions = recordVideoPreviewFrameGovernorSample(
        governor,
        governorEntities(states),
        22,
        adaptiveConfig,
      );
      applyTransitions(states, transitions);
    }
    expect(transitions[0]).toMatchObject({
      from: "threeQuarter",
      to: "floor",
      action: "failed-upgrade-probe",
    });
    expect(governor.failedUpgradeBlocks).toEqual([
      expect.objectContaining({
        from: "floor",
        to: "threeQuarter",
        minVisibleVideoCount: 3,
      }),
    ]);

    const retryBeforeBlockExpires =
      adaptiveConfig.failedUpgradeCooldownSamples + adaptiveConfig.coolSamplesForUpgrade;
    for (let i = 0; i < retryBeforeBlockExpires; i++) {
      transitions = recordVideoPreviewFrameGovernorSample(
        governor,
        governorEntities(states),
        10,
        adaptiveConfig,
      );
      applyTransitions(states, transitions);
    }
    expect(transitions).toHaveLength(0);
    expect([...states.values()].map((state) => state.quality)).toEqual(["floor", "floor", "floor"]);

    const lighterWorkloadTransitions: VideoPreviewQualityTransition[] = [];
    for (let i = 0; i < stableSamplesFor(adaptiveConfig.coolSamplesForUpgrade * 2); i++) {
      transitions = recordVideoPreviewFrameGovernorSample(
        governor,
        governorEntitiesById(states, ["entity-1", "entity-2"]),
        10,
        adaptiveConfig,
      );
      lighterWorkloadTransitions.push(...transitions);
      applyTransitions(states, transitions);
    }
    expect(lighterWorkloadTransitions).toHaveLength(1);
    expect(lighterWorkloadTransitions[0]).toMatchObject({
      from: "floor",
      to: "threeQuarter",
      action: "upgrade-probe",
    });
  });

  test("waits through a settle cooldown after a successful upgrade probe", () => {
    const governor = createVideoPreviewFrameGovernorState();
    governor.estimatedDisplayFrameMs = 10;
    const states = createVideoStates(3);
    for (const state of states.values()) {
      state.quality = "floor";
    }
    let transitions: VideoPreviewQualityTransition[] = [];

    for (let i = 0; i < stableSamplesFor(adaptiveConfig.coolSamplesForUpgrade); i++) {
      transitions = recordVideoPreviewFrameGovernorSample(
        governor,
        governorEntities(states),
        10,
        adaptiveConfig,
      );
      applyTransitions(states, transitions);
    }
    expect(transitions).toHaveLength(1);

    for (let i = 0; i < stableSamplesFor(adaptiveConfig.upgradeProbationSamples); i++) {
      transitions = recordVideoPreviewFrameGovernorSample(
        governor,
        governorEntities(states),
        10,
        adaptiveConfig,
      );
      applyTransitions(states, transitions);
    }
    expect(transitions).toHaveLength(0);
    expect(governor.probation).toBeNull();
    expect(governor.upgradeBlockedSamples).toBeGreaterThan(0);

    for (let i = 0; i < adaptiveConfig.coolSamplesForUpgrade; i++) {
      transitions = recordVideoPreviewFrameGovernorSample(
        governor,
        governorEntities(states),
        10,
        adaptiveConfig,
      );
      applyTransitions(states, transitions);
    }

    expect(transitions).toHaveLength(0);
    expect([...states.values()].filter((state) => state.quality === "threeQuarter")).toHaveLength(
      1,
    );
  });

  test("does not mistake stable 30fps overload for the display refresh rate", () => {
    const governor = createVideoPreviewFrameGovernorState();
    const states = createVideoStates(1);
    let transitions: VideoPreviewQualityTransition[] = [];

    for (let i = 0; i < adaptiveConfig.frameSampleWindow; i++) {
      transitions = recordVideoPreviewFrameGovernorSample(
        governor,
        governorEntities(states),
        1000 / 30,
        adaptiveConfig,
      );
    }

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: "full", to: "floor" });
    expect(governor.estimatedDisplayFrameMs).toBe(0);
  });

  test("does not choose below the 720p-class floor for large videos", () => {
    const state = createVideoPreviewAdaptiveState();
    state.quality = "floor";

    expect(resolveVideo(state, { viewportZoom: 0.05 })).toMatchObject({
      width: 1280,
      height: 720,
    });
  });

  test("never exceeds the source dimensions for videos smaller than the preview floor", () => {
    const state = createVideoPreviewAdaptiveState();
    state.quality = "floor";

    expect(
      resolveVideo(state, {
        originalSize: { width: 1280, height: 720 },
        entitySize: { width: 1280, height: 720 },
      }),
    ).toMatchObject({ width: 1280, height: 720 });
  });

  test("preserves source aspect ratio when choosing preview dimensions", () => {
    const state = createVideoPreviewAdaptiveState();
    state.quality = "threeQuarter";

    const resolution = resolveVideo(state, {
      originalSize: { width: 3840, height: 1600 },
      entitySize: { width: 3840, height: 1600 },
    });

    expect(resolution.width).toBe(2880);
    expect(resolution.height).toBe(1200);
  });

  test("zooms into larger buckets immediately and delays zoom-out downscales until idle", () => {
    const state = createVideoPreviewAdaptiveState();
    state.quality = "threeQuarter";

    expect(resolveVideo(state, { viewportZoom: 0.25, nowMs: 0 })).toMatchObject({
      width: 1280,
      height: 720,
    });
    expect(resolveVideo(state, { viewportZoom: 0.6, nowMs: 50 })).toMatchObject({
      width: 2880,
      height: 1620,
    });
    expect(resolveVideo(state, { viewportZoom: 0.25, nowMs: 100 })).toMatchObject({
      width: 2880,
      height: 1620,
    });
    expect(resolveVideo(state, { viewportZoom: 0.25, nowMs: 400 })).toMatchObject({
      width: 1280,
      height: 720,
    });
  });

  test("returns original dimensions for non-video entities", () => {
    const state = createVideoPreviewAdaptiveState();
    state.quality = "floor";

    expect(resolveVideo(state, { isVideo: false })).toMatchObject({
      width: 3840,
      height: 2160,
      renderScale: 1,
    });
  });
});
