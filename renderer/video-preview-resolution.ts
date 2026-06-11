import type { Size } from "#types/canvas.ts";

export type VideoPreviewQualityRung = "full" | "threeQuarter" | "floor";

export interface VideoPreviewAdaptiveConfig {
  enabled: boolean;
  warmupSamples: number;
  sampleWindow: number;
  downgradeMedianMs: number;
  downgradeP95Ms: number;
  upgradeMedianMs: number;
  upgradeP95Ms: number;
  coolSamplesForUpgrade: number;
  targetFrameRate: number;
  minDetectedFrameRate: number;
  displayEstimateStabilityMultiplier: number;
  frameSampleWindow: number;
  frameDowngradeMedianMultiplier: number;
  frameDowngradeP95Multiplier: number;
  frameUpgradeMedianMultiplier: number;
  frameUpgradeP95Multiplier: number;
  upgradeProbationSamples: number;
  successfulUpgradeCooldownSamples: number;
  failedUpgradeCooldownSamples: number;
  failedUpgradeDetectionSamples: number;
  failedUpgradeRetrySamples: number;
  minLongEdge: number;
  projectedOversample: number;
  bucketFactor: number;
  zoomDownscaleIdleDelayMs: number;
}

export interface VideoPreviewAdaptiveState {
  quality: VideoPreviewQualityRung;
  samples: number[];
  coolSamples: number;
  currentLongEdge: number;
  lastProjectedLongEdge: number;
  lastViewportChangeTimeMs: number;
  forceResolutionUpdate: boolean;
}

export interface VideoPreviewFrameGovernorState {
  frameSamples: number[];
  estimatedDisplayFrameMs: number;
  coolSamples: number;
  upgradeBlockedSamples: number;
  probation: VideoPreviewUpgradeProbation | null;
  failedUpgradeBlocks: VideoPreviewFailedUpgradeBlock[];
}

export interface VideoPreviewUpgradeProbation {
  entityId: string;
  from: VideoPreviewQualityRung;
  to: VideoPreviewQualityRung;
}

export interface VideoPreviewFailedUpgradeBlock {
  from: VideoPreviewQualityRung;
  to: VideoPreviewQualityRung;
  minVisibleVideoCount: number;
  remainingSamples: number;
}

export interface VideoPreviewGovernorEntity {
  id: string;
  quality: VideoPreviewQualityRung;
  originalSize: Size;
}

export interface PreviewResolutionInput {
  isVideo: boolean;
  originalSize: Size;
  entitySize: Size;
  viewportZoom: number;
  nowMs: number;
  state?: VideoPreviewAdaptiveState;
}

export interface PreviewResolution {
  width: number;
  height: number;
  renderScale: number;
  quality: VideoPreviewQualityRung;
}

export interface VideoPreviewQualityTransition {
  entityId?: string;
  from: VideoPreviewQualityRung;
  to: VideoPreviewQualityRung;
  source: "entity-render" | "raf";
  action?: "group-downgrade" | "upgrade-probe" | "failed-upgrade-probe";
  medianMs: number;
  p95Ms: number;
  targetMs?: number;
}

export function createVideoPreviewAdaptiveState(): VideoPreviewAdaptiveState {
  return {
    quality: "full",
    samples: [],
    coolSamples: 0,
    currentLongEdge: 0,
    lastProjectedLongEdge: 0,
    lastViewportChangeTimeMs: 0,
    forceResolutionUpdate: false,
  };
}

export function createVideoPreviewFrameGovernorState(): VideoPreviewFrameGovernorState {
  return {
    frameSamples: [],
    estimatedDisplayFrameMs: 0,
    coolSamples: 0,
    upgradeBlockedSamples: 0,
    probation: null,
    failedUpgradeBlocks: [],
  };
}

export function recordVideoPreviewRenderSample(
  state: VideoPreviewAdaptiveState,
  renderTimeMs: number,
  config: VideoPreviewAdaptiveConfig,
): VideoPreviewQualityTransition | null {
  if (!config.enabled || !Number.isFinite(renderTimeMs)) return null;

  state.samples.push(renderTimeMs);
  const maxSamples = Math.max(config.warmupSamples, config.sampleWindow);
  if (state.samples.length > maxSamples) state.samples.shift();
  if (state.samples.length < maxSamples) return null;

  const window = state.samples.slice(-config.sampleWindow);
  const median = percentile(window, 0.5);
  const p95 = percentile(window, 0.95);
  const isSlow = median >= config.downgradeMedianMs || p95 >= config.downgradeP95Ms;

  if (isSlow) {
    const isSevere =
      (config.downgradeMedianMs > 0 && median >= config.downgradeMedianMs * 2) ||
      (config.downgradeP95Ms > 0 && p95 >= config.downgradeP95Ms * 2);
    const previousQuality = state.quality;
    const nextQuality = isSevere ? "floor" : downgradeQuality(state.quality);
    state.coolSamples = 0;
    if (nextQuality !== state.quality) {
      state.quality = nextQuality;
      state.samples = [];
      state.forceResolutionUpdate = true;
      return {
        from: previousQuality,
        to: nextQuality,
        source: "entity-render",
        medianMs: median,
        p95Ms: p95,
      };
    }
    return null;
  }

  return null;
}

export function recordVideoPreviewFrameGovernorSample(
  state: VideoPreviewFrameGovernorState,
  entities: readonly VideoPreviewGovernorEntity[],
  rafDeltaMs: number,
  config: VideoPreviewAdaptiveConfig,
): VideoPreviewQualityTransition[] {
  if (!config.enabled || !Number.isFinite(rafDeltaMs) || rafDeltaMs <= 0) return [];
  if (config.targetFrameRate <= 0) return [];
  if (entities.length === 0) return [];

  decayFailedUpgradeBlocks(state);
  state.frameSamples.push(rafDeltaMs);
  state.upgradeBlockedSamples = Math.max(0, state.upgradeBlockedSamples - 1);
  const maxSamples = Math.max(1, config.frameSampleWindow);
  if (state.frameSamples.length > maxSamples) state.frameSamples.shift();
  if (state.frameSamples.length < maxSamples) return [];

  const median = percentile(state.frameSamples, 0.5);
  const p95 = percentile(state.frameSamples, 0.95);
  const configuredTargetMs = 1000 / config.targetFrameRate;
  const detectedFrameRate = 1000 / median;
  const stableDisplayWindow =
    detectedFrameRate >= config.minDetectedFrameRate &&
    p95 <= median * config.displayEstimateStabilityMultiplier;
  if (stableDisplayWindow) {
    state.estimatedDisplayFrameMs = median;
  }
  const targetMs = Math.max(configuredTargetMs, state.estimatedDisplayFrameMs || 0);
  const isSlow =
    median >= targetMs * config.frameDowngradeMedianMultiplier ||
    p95 >= targetMs * config.frameDowngradeP95Multiplier;

  if (isSlow) {
    const isSevere = median >= targetMs * 2 || p95 >= targetMs * 2;
    state.coolSamples = 0;

    if (state.probation) {
      const probation = state.probation;
      state.probation = null;
      state.frameSamples = [];
      state.upgradeBlockedSamples = config.failedUpgradeCooldownSamples;
      blockFailedUpgradeProbe(state, probation, entities.length, config);
      return [
        {
          entityId: probation.entityId,
          from: probation.to,
          to: probation.from,
          source: "raf",
          action: "failed-upgrade-probe",
          medianMs: median,
          p95Ms: p95,
          targetMs,
        },
      ];
    }

    const transitions: VideoPreviewQualityTransition[] = [];
    for (const entity of entities) {
      const nextQuality = isSevere ? "floor" : downgradeQuality(entity.quality);
      if (nextQuality === entity.quality) continue;
      transitions.push({
        entityId: entity.id,
        from: entity.quality,
        to: nextQuality,
        source: "raf",
        action: "group-downgrade",
        medianMs: median,
        p95Ms: p95,
        targetMs,
      });
    }

    if (transitions.length > 0) {
      state.frameSamples = [];
    }
    return transitions;
  }

  const isCool =
    median <= targetMs * config.frameUpgradeMedianMultiplier &&
    p95 <= targetMs * config.frameUpgradeP95Multiplier;
  state.coolSamples = isCool ? state.coolSamples + 1 : 0;

  if (state.probation) {
    const probationEntityIsVisible = entities.some(
      (entity) => entity.id === state.probation!.entityId,
    );
    if (!probationEntityIsVisible) {
      state.probation = null;
      state.coolSamples = 0;
      state.frameSamples = [];
      state.upgradeBlockedSamples = Math.max(
        state.upgradeBlockedSamples,
        config.successfulUpgradeCooldownSamples,
      );
      return [];
    }

    if (state.coolSamples >= config.upgradeProbationSamples) {
      state.probation = null;
      state.coolSamples = 0;
      state.frameSamples = [];
      state.upgradeBlockedSamples = Math.max(
        state.upgradeBlockedSamples,
        config.successfulUpgradeCooldownSamples,
      );
    }
    return [];
  }

  if (state.upgradeBlockedSamples > 0) return [];
  if (state.coolSamples < config.coolSamplesForUpgrade) return [];

  const upgradeCandidate = selectUpgradeCandidate(entities, state, config);
  state.coolSamples = 0;
  if (!upgradeCandidate) return [];

  const nextQuality = upgradeQuality(upgradeCandidate.quality);
  if (nextQuality !== upgradeCandidate.quality) {
    state.probation = {
      entityId: upgradeCandidate.id,
      from: upgradeCandidate.quality,
      to: nextQuality,
    };
    state.frameSamples = [];
    return [
      {
        entityId: upgradeCandidate.id,
        from: upgradeCandidate.quality,
        to: nextQuality,
        source: "raf",
        action: "upgrade-probe",
        medianMs: median,
        p95Ms: p95,
        targetMs,
      },
    ];
  }
  return [];
}

export function blockVideoPreviewFrameGovernorUpgrades(
  state: VideoPreviewFrameGovernorState,
  config: VideoPreviewAdaptiveConfig,
): void {
  state.probation = null;
  state.coolSamples = 0;
  state.frameSamples = [];
  state.upgradeBlockedSamples = Math.max(
    state.upgradeBlockedSamples,
    config.failedUpgradeCooldownSamples,
  );
}

export function resolveVideoPreviewResolution(
  input: PreviewResolutionInput,
  config: VideoPreviewAdaptiveConfig,
): PreviewResolution {
  const originalWidth = Math.max(1, Math.round(input.originalSize.width));
  const originalHeight = Math.max(1, Math.round(input.originalSize.height));
  const originalLongEdge = Math.max(originalWidth, originalHeight);

  if (!config.enabled || !input.isVideo || !input.state || input.state.quality === "full") {
    return {
      width: originalWidth,
      height: originalHeight,
      renderScale: 1,
      quality: "full",
    };
  }

  const state = input.state;
  const projectedLongEdge =
    Math.max(input.entitySize.width, input.entitySize.height) * input.viewportZoom;
  if (Math.abs(projectedLongEdge - state.lastProjectedLongEdge) > 0.5) {
    state.lastProjectedLongEdge = projectedLongEdge;
    state.lastViewportChangeTimeMs = input.nowMs;
  }

  const qualityCeiling = getQualityLongEdgeCeiling(
    state.quality,
    originalLongEdge,
    config.minLongEdge,
  );
  const projectedTarget = bucketLongEdge(
    projectedLongEdge * config.projectedOversample,
    config.minLongEdge,
    config.bucketFactor,
  );
  const desiredLongEdge = Math.min(
    originalLongEdge,
    qualityCeiling,
    Math.max(config.minLongEdge, projectedTarget),
  );

  let targetLongEdge = desiredLongEdge;
  if (
    state.currentLongEdge > 0 &&
    desiredLongEdge < state.currentLongEdge &&
    !state.forceResolutionUpdate &&
    input.nowMs - state.lastViewportChangeTimeMs < config.zoomDownscaleIdleDelayMs
  ) {
    targetLongEdge = state.currentLongEdge;
  }

  state.forceResolutionUpdate = false;
  state.currentLongEdge = targetLongEdge;

  const size = sizeFromLongEdge(input.originalSize, targetLongEdge);
  return {
    ...size,
    renderScale: size.width / originalWidth,
    quality: state.quality,
  };
}

function downgradeQuality(quality: VideoPreviewQualityRung): VideoPreviewQualityRung {
  if (quality === "full") return "threeQuarter";
  if (quality === "threeQuarter") return "floor";
  return "floor";
}

function upgradeQuality(quality: VideoPreviewQualityRung): VideoPreviewQualityRung {
  if (quality === "floor") return "threeQuarter";
  if (quality === "threeQuarter") return "full";
  return "full";
}

function selectUpgradeCandidate(
  entities: readonly VideoPreviewGovernorEntity[],
  state: VideoPreviewFrameGovernorState,
  config: VideoPreviewAdaptiveConfig,
): VideoPreviewGovernorEntity | null {
  const visibleVideoCount = entities.length;
  const candidates = entities.filter((entity) => {
    if (entity.quality === "full") return false;
    const nextQuality = upgradeQuality(entity.quality);
    return !isUpgradeBlocked(state, entity.quality, nextQuality, visibleVideoCount);
  });
  if (candidates.length === 0) return null;

  return candidates.toSorted((a, b) => {
    const aDelta = estimateUpgradePixelDelta(a, config.minLongEdge);
    const bDelta = estimateUpgradePixelDelta(b, config.minLongEdge);
    if (aDelta !== bDelta) return aDelta - bDelta;
    return qualityRank(a.quality) - qualityRank(b.quality);
  })[0]!;
}

function blockFailedUpgradeProbe(
  state: VideoPreviewFrameGovernorState,
  probation: VideoPreviewUpgradeProbation,
  visibleVideoCount: number,
  config: VideoPreviewAdaptiveConfig,
): void {
  if (config.failedUpgradeRetrySamples <= 0) return;
  const existing = state.failedUpgradeBlocks.find(
    (block) =>
      block.from === probation.from &&
      block.to === probation.to &&
      block.minVisibleVideoCount === visibleVideoCount,
  );
  if (existing) {
    existing.remainingSamples = Math.max(
      existing.remainingSamples,
      config.failedUpgradeRetrySamples,
    );
    return;
  }

  state.failedUpgradeBlocks.push({
    from: probation.from,
    to: probation.to,
    minVisibleVideoCount: visibleVideoCount,
    remainingSamples: config.failedUpgradeRetrySamples,
  });
}

function decayFailedUpgradeBlocks(state: VideoPreviewFrameGovernorState): void {
  for (const block of state.failedUpgradeBlocks) {
    block.remainingSamples--;
  }
  state.failedUpgradeBlocks = state.failedUpgradeBlocks.filter(
    (block) => block.remainingSamples > 0,
  );
}

function isUpgradeBlocked(
  state: VideoPreviewFrameGovernorState,
  from: VideoPreviewQualityRung,
  to: VideoPreviewQualityRung,
  visibleVideoCount: number,
): boolean {
  return state.failedUpgradeBlocks.some(
    (block) =>
      block.from === from && block.to === to && visibleVideoCount >= block.minVisibleVideoCount,
  );
}

function estimateUpgradePixelDelta(
  entity: VideoPreviewGovernorEntity,
  minLongEdge: number,
): number {
  const currentLongEdge = getQualityLongEdgeCeiling(
    entity.quality,
    Math.max(entity.originalSize.width, entity.originalSize.height),
    minLongEdge,
  );
  const nextLongEdge = getQualityLongEdgeCeiling(
    upgradeQuality(entity.quality),
    Math.max(entity.originalSize.width, entity.originalSize.height),
    minLongEdge,
  );
  const currentSize = sizeFromLongEdge(entity.originalSize, currentLongEdge);
  const nextSize = sizeFromLongEdge(entity.originalSize, nextLongEdge);
  return nextSize.width * nextSize.height - currentSize.width * currentSize.height;
}

function qualityRank(quality: VideoPreviewQualityRung): number {
  if (quality === "floor") return 0;
  if (quality === "threeQuarter") return 1;
  return 2;
}

function getQualityLongEdgeCeiling(
  quality: VideoPreviewQualityRung,
  originalLongEdge: number,
  minLongEdge: number,
): number {
  if (quality === "full") return originalLongEdge;
  if (quality === "threeQuarter") return Math.max(minLongEdge, originalLongEdge * 0.75);
  return minLongEdge;
}

function bucketLongEdge(value: number, minLongEdge: number, factor: number): number {
  if (value <= minLongEdge || factor <= 1) return minLongEdge;
  const exponent = Math.ceil(Math.log(value / minLongEdge) / Math.log(factor));
  return minLongEdge * factor ** exponent;
}

function sizeFromLongEdge(originalSize: Size, longEdge: number): Size {
  const originalWidth = Math.max(1, Math.round(originalSize.width));
  const originalHeight = Math.max(1, Math.round(originalSize.height));
  const originalLongEdge = Math.max(originalWidth, originalHeight);
  const scale = Math.min(1, longEdge / originalLongEdge);
  return {
    width: Math.max(1, Math.min(originalWidth, Math.round(originalWidth * scale))),
    height: Math.max(1, Math.min(originalHeight, Math.round(originalHeight * scale))),
  };
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return sorted[index]!;
}
