import { calculateTargetResolution } from "#renderer/export-formats.ts";
import {
  createPreviewResolutionGovernorState,
  recordPreviewResolutionFrameSample,
  recordPreviewResolutionRenderSample,
  resolvePreviewResolution,
  type PreviewResolutionAdaptiveConfig,
  type PreviewResolutionGovernorEntity,
  type PreviewResolutionGovernorState,
  type PreviewResolutionTransition,
} from "#renderer/preview-resolution-governor.ts";
import { describe, expect, test } from "vitest";

const adaptiveConfig = {
  enabled: true,
  targetFrameRate: 120,
  minDetectedFrameRate: 50,
  displayEstimateStabilityMultiplier: 1.15,
  frameSampleWindow: 4,
  frameDowngradeMedianMultiplier: 1.2,
  frameDowngradeP95Multiplier: 1.6,
  frameUpgradeMedianMultiplier: 1.05,
  frameUpgradeP95Multiplier: 1.25,
  coolSamplesForUpgrade: 5,
  settleSamples: 2,
  minLongEdge: 1280,
  maxLongEdge: 2560,
  projectedOversample: 1.25,
  bucketFactor: 1.25,
  zoomDownscaleIdleDelayMs: 250,
  renderCostSampleWindow: 8,
  upgradeHeadroomMultiplier: 0.8,
  failedRelaxationBlockSamples: 20,
} satisfies PreviewResolutionAdaptiveConfig;

function createEntity(
  id: string,
  options: {
    originalSize?: { width: number; height: number };
    entitySize?: { width: number; height: number };
    viewportZoom?: number;
  } = {},
): PreviewResolutionGovernorEntity {
  const originalSize = options.originalSize ?? { width: 3840, height: 2160 };
  return {
    id,
    originalSize,
    entitySize: options.entitySize ?? originalSize,
    viewportZoom: options.viewportZoom ?? 1,
  };
}

function allocate(
  state: PreviewResolutionGovernorState,
  entities: readonly PreviewResolutionGovernorEntity[],
  nowMs = 0,
): void {
  recordPreviewResolutionFrameSample(state, entities, 0, nowMs, 0, adaptiveConfig);
}

function resolve(
  state: PreviewResolutionGovernorState,
  entity: PreviewResolutionGovernorEntity,
  isManaged = true,
) {
  return resolvePreviewResolution(
    {
      entityId: entity.id,
      isManaged,
      originalSize: entity.originalSize,
      state,
    },
    adaptiveConfig,
  );
}

function recordFrames(
  state: PreviewResolutionGovernorState,
  entities: readonly PreviewResolutionGovernorEntity[],
  rafDeltaMs: number,
  count: number,
  displayFrameMs = 0,
): PreviewResolutionTransition | null {
  let transition: PreviewResolutionTransition | null = null;
  for (let i = 0; i < count; i++) {
    const nextTransition = recordPreviewResolutionFrameSample(
      state,
      entities,
      rafDeltaMs,
      i * rafDeltaMs,
      displayFrameMs,
      adaptiveConfig,
    );
    if (nextTransition) transition = nextTransition;
  }
  return transition;
}

function samplesForCoolUpgrade(): number {
  return adaptiveConfig.frameSampleWindow + adaptiveConfig.coolSamplesForUpgrade - 1;
}

describe("preview resolution governor", () => {
  test("starts 4K managed previews capped at 2560px long edge", () => {
    const state = createPreviewResolutionGovernorState();
    const entity = createEntity("video-1");

    allocate(state, [entity]);

    expect(resolve(state, entity)).toMatchObject({
      width: 2560,
      height: 1440,
      longEdge: 2560,
      managed: true,
    });
  });

  test("does not choose below the 1280px floor for large managed media", () => {
    const state = createPreviewResolutionGovernorState();
    const entity = createEntity("video-1");
    state.pressureLevel = 99;

    allocate(state, [entity]);

    expect(resolve(state, entity)).toMatchObject({
      width: 1280,
      height: 720,
      longEdge: 1280,
    });
  });

  test("never exceeds source dimensions for media smaller than the preview floor", () => {
    const state = createPreviewResolutionGovernorState();
    const entity = createEntity("small-video", {
      originalSize: { width: 960, height: 540 },
    });
    state.pressureLevel = 99;

    allocate(state, [entity]);

    expect(resolve(state, entity)).toMatchObject({
      width: 960,
      height: 540,
      renderScale: 1,
    });
  });

  test("treats stable 60Hz, 100Hz, and 120Hz displays as healthy targets", () => {
    const sixtyHzGovernor = createPreviewResolutionGovernorState();
    const sixtyHzEntity = createEntity("video-60hz");
    recordFrames(sixtyHzGovernor, [sixtyHzEntity], 1000 / 60, 8);

    expect(sixtyHzGovernor.estimatedDisplayFrameMs).toBeCloseTo(1000 / 60);
    expect(sixtyHzGovernor.pressureLevel).toBe(0);

    const hundredHzGovernor = createPreviewResolutionGovernorState();
    hundredHzGovernor.pressureLevel = 1;
    const hundredHzEntity = createEntity("video-100hz");

    const hundredHzTransition = recordFrames(
      hundredHzGovernor,
      [hundredHzEntity],
      10,
      samplesForCoolUpgrade(),
    );

    expect(hundredHzGovernor.estimatedDisplayFrameMs).toBe(10);
    expect(hundredHzTransition).toMatchObject({ action: "cohort-upgrade" });
    expect(hundredHzGovernor.pressureLevel).toBe(0);

    const hundredTwentyHzGovernor = createPreviewResolutionGovernorState();
    const hundredTwentyHzEntity = createEntity("video-120hz");
    recordFrames(hundredTwentyHzGovernor, [hundredTwentyHzEntity], 1000 / 120, 8);

    expect(hundredTwentyHzGovernor.estimatedDisplayFrameMs).toBeCloseTo(1000 / 120);
    expect(hundredTwentyHzGovernor.pressureLevel).toBe(0);
  });

  test("uses startup-learned 60Hz reference without falsely downgrading", () => {
    const state = createPreviewResolutionGovernorState();
    const entity = createEntity("video-60hz");

    const transition = recordFrames(state, [entity], 1000 / 60, 8, 1000 / 60);

    expect(transition).toBeNull();
    expect(state.pressureLevel).toBe(0);
    expect(state.estimatedDisplayFrameMs).toBe(0);
  });

  test("fallback estimator does not learn stable 70-80fps overload as the display target", () => {
    const state = createPreviewResolutionGovernorState();
    const entity = createEntity("firefox-video");
    state.estimatedDisplayFrameMs = 10;

    const transition = recordFrames(state, [entity], 12.5, adaptiveConfig.frameSampleWindow);

    expect(state.estimatedDisplayFrameMs).toBe(10);
    expect(transition).toMatchObject({
      action: "cohort-downgrade",
      fromPressureLevel: 0,
      toPressureLevel: 1,
    });
  });

  test("keeps the fastest learned display estimate instead of relaxing to overload cadence", () => {
    const state = createPreviewResolutionGovernorState();
    const entity = createEntity("firefox-video");

    recordFrames(state, [entity], 10, adaptiveConfig.frameSampleWindow);
    recordFrames(state, [entity], 11.5, adaptiveConfig.frameSampleWindow);

    expect(state.estimatedDisplayFrameMs).toBe(10);
  });

  test("downgrades the visible cohort under pressure without same-frame opportunistic upgrades", () => {
    const state = createPreviewResolutionGovernorState();
    const entities = [createEntity("video-1"), createEntity("gif-1")];

    const transition = recordFrames(state, entities, 1000 / 30, adaptiveConfig.frameSampleWindow);

    expect(transition).toMatchObject({
      action: "cohort-downgrade",
      fromPressureLevel: 0,
      toPressureLevel: 2,
      managedEntityCount: 2,
    });
    expect(state.pressureLevel).toBe(2);
    expect(resolve(state, entities[0]!)).toMatchObject({ width: 2000, height: 1125 });
    expect(resolve(state, entities[1]!)).toMatchObject({ width: 2000, height: 1125 });
  });

  test("blocks relaxation back to a pressure level that just failed", () => {
    const state = createPreviewResolutionGovernorState();
    const entities = [
      createEntity("video-1"),
      createEntity("video-2"),
      createEntity("video-3"),
      createEntity("video-4"),
    ];

    const downgrade = recordFrames(state, entities, 16.4, adaptiveConfig.frameSampleWindow, 10);
    expect(downgrade).toMatchObject({
      action: "cohort-downgrade",
      fromPressureLevel: 0,
      toPressureLevel: 1,
    });
    expect(state.minimumPressureLevel).toBe(1);

    const attemptedUpgrade = recordFrames(
      state,
      entities,
      10,
      samplesForCoolUpgrade() + adaptiveConfig.settleSamples,
      10,
    );

    expect(attemptedUpgrade).toBeNull();
    expect(state.pressureLevel).toBe(1);
  });

  test("slow frames never reduce pressure when visible workload has fewer buckets", () => {
    const state = createPreviewResolutionGovernorState();
    const zoomedOutEntity = createEntity("video-1", { viewportZoom: 0.25 });
    state.pressureLevel = 4;
    state.estimatedDisplayFrameMs = 10;

    const transition = recordFrames(
      state,
      [zoomedOutEntity],
      12.5,
      adaptiveConfig.frameSampleWindow,
    );

    expect(transition).toBeNull();
    expect(state.pressureLevel).toBe(4);
  });

  test("uses sustained healthy frames and predicted headroom to upgrade without long cooldowns", () => {
    const state = createPreviewResolutionGovernorState();
    const entities = [createEntity("video-1"), createEntity("gif-1")];
    state.pressureLevel = 2;

    for (const entity of entities) {
      recordPreviewResolutionRenderSample(
        state,
        entity.id,
        1,
        {
          width: 2000,
          height: 1125,
          longEdge: 2000,
          renderScale: 2000 / 3840,
          managed: true,
        },
        adaptiveConfig,
      );
    }

    const transition = recordFrames(
      state,
      entities,
      1000 / 120,
      adaptiveConfig.settleSamples + samplesForCoolUpgrade(),
    );

    expect(transition).toMatchObject({
      action: "cohort-upgrade",
      fromPressureLevel: 2,
      toPressureLevel: 1,
    });
    expect(state.pressureLevel).toBe(1);
  });

  test("blocks predicted upgrades that exceed the frame budget headroom", () => {
    const state = createPreviewResolutionGovernorState();
    const entities = [createEntity("video-1"), createEntity("video-2")];
    state.pressureLevel = 1;

    for (const entity of entities) {
      recordPreviewResolutionRenderSample(
        state,
        entity.id,
        12,
        {
          width: 2500,
          height: 1406,
          longEdge: 2500,
          renderScale: 2500 / 3840,
          managed: true,
        },
        adaptiveConfig,
      );
    }

    const transition = recordFrames(state, entities, 1000 / 120, samplesForCoolUpgrade() + 8);

    expect(transition).toBeNull();
    expect(state.pressureLevel).toBe(1);
  });

  test("caps managed GIF and continuous shader previews while static previews stay native", () => {
    const state = createPreviewResolutionGovernorState();
    const gifEntity = createEntity("gif-1");
    const animatedShaderEntity = createEntity("flowing-glass-1");
    const staticEntity = createEntity("image-1");

    allocate(state, [gifEntity, animatedShaderEntity]);

    expect(resolve(state, gifEntity, true)).toMatchObject({ width: 2560, height: 1440 });
    expect(resolve(state, animatedShaderEntity, true)).toMatchObject({
      width: 2560,
      height: 1440,
    });
    expect(resolve(state, staticEntity, false)).toMatchObject({
      width: 3840,
      height: 2160,
      renderScale: 1,
      managed: false,
    });
  });

  test("zooms into larger buckets immediately and delays zoom-out downscales until idle", () => {
    const state = createPreviewResolutionGovernorState();
    const zoomedOut = createEntity("video-1", { viewportZoom: 0.25 });
    const zoomedIn = createEntity("video-1", { viewportZoom: 0.6 });

    allocate(state, [zoomedOut], 0);
    expect(resolve(state, zoomedOut)).toMatchObject({ width: 1280, height: 720 });

    allocate(state, [zoomedIn], 50);
    expect(resolve(state, zoomedIn)).toMatchObject({ width: 2560, height: 1440 });

    allocate(state, [zoomedOut], 100);
    expect(resolve(state, zoomedOut)).toMatchObject({ width: 2560, height: 1440 });

    allocate(state, [zoomedOut], 400);
    expect(resolve(state, zoomedOut)).toMatchObject({ width: 1280, height: 720 });
  });

  test("exports keep original source resolution unless a lower preset is selected", () => {
    expect(calculateTargetResolution(3840, 2160, "original")).toEqual({
      width: 3840,
      height: 2160,
    });
    expect(calculateTargetResolution(3840, 2160, "1080p")).toEqual({
      width: 1920,
      height: 1080,
    });
  });
});
