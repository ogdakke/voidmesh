import type { Size } from "#types/canvas.ts";
import { isPlausibleDisplayFrameRate, percentile } from "#lib/display-refresh.ts";

export interface PreviewResolutionAdaptiveConfig {
  enabled: boolean;
  targetFrameRate: number;
  minDetectedFrameRate: number;
  displayEstimateStabilityMultiplier: number;
  frameSampleWindow: number;
  frameDowngradeMedianMultiplier: number;
  frameDowngradeP95Multiplier: number;
  frameUpgradeMedianMultiplier: number;
  frameUpgradeP95Multiplier: number;
  coolSamplesForUpgrade: number;
  settleSamples: number;
  minLongEdge: number;
  maxLongEdge: number;
  projectedOversample: number;
  bucketFactor: number;
  zoomDownscaleIdleDelayMs: number;
  renderCostSampleWindow: number;
  upgradeHeadroomMultiplier: number;
  failedRelaxationBlockSamples: number;
}

export interface PreviewResolutionEntityState {
  currentLongEdge: number;
  lastProjectedLongEdge: number;
  lastViewportChangeTimeMs: number;
}

export interface PreviewResolutionCostState {
  samplesMsPerMegapixel: number[];
}

export interface PreviewResolutionGovernorState {
  frameSamples: number[];
  estimatedDisplayFrameMs: number;
  coolSamples: number;
  settleSamples: number;
  pressureLevel: number;
  minimumPressureLevel: number;
  relaxationBlockedSamples: number;
  forceResolutionUpdate: boolean;
  allocations: Map<string, number>;
  entityStates: Map<string, PreviewResolutionEntityState>;
  entityCosts: Map<string, PreviewResolutionCostState>;
}

export interface PreviewResolutionGovernorEntity {
  id: string;
  originalSize: Size;
  entitySize: Size;
  viewportZoom: number;
}

export interface PreviewResolutionInput {
  entityId: string;
  isManaged: boolean;
  originalSize: Size;
  state: PreviewResolutionGovernorState;
}

export interface PreviewResolution {
  width: number;
  height: number;
  renderScale: number;
  longEdge: number;
  managed: boolean;
}

export interface PreviewResolutionTransition {
  fromPressureLevel: number;
  toPressureLevel: number;
  action: "cohort-downgrade" | "cohort-upgrade";
  medianMs: number;
  p95Ms: number;
  targetMs: number;
  managedEntityCount: number;
}

export function createPreviewResolutionGovernorState(): PreviewResolutionGovernorState {
  return {
    frameSamples: [],
    estimatedDisplayFrameMs: 0,
    coolSamples: 0,
    settleSamples: 0,
    pressureLevel: 0,
    minimumPressureLevel: 0,
    relaxationBlockedSamples: 0,
    forceResolutionUpdate: false,
    allocations: new Map(),
    entityStates: new Map(),
    entityCosts: new Map(),
  };
}

export function recordPreviewResolutionRenderSample(
  state: PreviewResolutionGovernorState,
  entityId: string,
  renderTimeMs: number,
  resolution: PreviewResolution,
  config: PreviewResolutionAdaptiveConfig,
): void {
  if (!config.enabled || !resolution.managed || !Number.isFinite(renderTimeMs)) return;

  const megapixels = (resolution.width * resolution.height) / 1_000_000;
  if (megapixels <= 0) return;

  let cost = state.entityCosts.get(entityId);
  if (!cost) {
    cost = { samplesMsPerMegapixel: [] };
    state.entityCosts.set(entityId, cost);
  }
  cost.samplesMsPerMegapixel.push(renderTimeMs / megapixels);

  const maxSamples = Math.max(1, config.renderCostSampleWindow);
  if (cost.samplesMsPerMegapixel.length > maxSamples) {
    cost.samplesMsPerMegapixel.splice(0, cost.samplesMsPerMegapixel.length - maxSamples);
  }
}

export function recordPreviewResolutionFrameSample(
  state: PreviewResolutionGovernorState,
  entities: readonly PreviewResolutionGovernorEntity[],
  rafDeltaMs: number,
  nowMs: number,
  displayFrameMs: number,
  config: PreviewResolutionAdaptiveConfig,
): PreviewResolutionTransition | null {
  if (!config.enabled || config.targetFrameRate <= 0 || entities.length === 0) {
    resetGovernorWorkload(state);
    return null;
  }

  pruneInactiveState(state, entities);
  decayRelaxationBlock(state);

  let transition: PreviewResolutionTransition | null = null;
  if (Number.isFinite(rafDeltaMs) && rafDeltaMs > 0) {
    state.frameSamples.push(rafDeltaMs);
    const maxSamples = Math.max(1, config.frameSampleWindow);
    if (state.frameSamples.length > maxSamples) state.frameSamples.shift();

    if (state.frameSamples.length >= maxSamples) {
      const median = percentile(state.frameSamples, 0.5);
      const p95 = percentile(state.frameSamples, 0.95);
      const configuredTargetMs = 1000 / config.targetFrameRate;
      const detectedFrameRate = 1000 / median;
      const stableDisplayWindow =
        detectedFrameRate >= config.minDetectedFrameRate &&
        p95 <= median * config.displayEstimateStabilityMultiplier;
      if (
        displayFrameMs <= 0 &&
        stableDisplayWindow &&
        isPlausibleDisplayFrameRate(detectedFrameRate) &&
        (state.estimatedDisplayFrameMs === 0 || median < state.estimatedDisplayFrameMs)
      ) {
        state.estimatedDisplayFrameMs = median;
      }

      const targetMs = Math.max(configuredTargetMs, displayFrameMs, state.estimatedDisplayFrameMs);
      const isSlow =
        median >= targetMs * config.frameDowngradeMedianMultiplier ||
        p95 >= targetMs * config.frameDowngradeP95Multiplier;

      if (isSlow) {
        const maxPressureLevel = getMaxPressureLevel(entities, config);
        const pressureDelta = median >= targetMs * 2 || p95 >= targetMs * 2 ? 2 : 1;
        const previousPressureLevel = state.pressureLevel;
        state.pressureLevel = Math.max(
          previousPressureLevel,
          Math.min(maxPressureLevel, state.pressureLevel + pressureDelta),
        );
        state.coolSamples = 0;
        state.settleSamples = config.settleSamples;
        state.forceResolutionUpdate = true;
        state.frameSamples = [];

        if (state.pressureLevel !== previousPressureLevel) {
          blockFailedRelaxation(state, state.pressureLevel, config);
          transition = {
            fromPressureLevel: previousPressureLevel,
            toPressureLevel: state.pressureLevel,
            action: "cohort-downgrade",
            medianMs: median,
            p95Ms: p95,
            targetMs,
            managedEntityCount: entities.length,
          };
        }
      } else {
        const isCool =
          median <= targetMs * config.frameUpgradeMedianMultiplier &&
          p95 <= targetMs * config.frameUpgradeP95Multiplier;
        state.coolSamples = isCool ? state.coolSamples + 1 : 0;

        if (state.settleSamples > 0) {
          state.settleSamples--;
        } else if (
          state.pressureLevel > 0 &&
          state.pressureLevel > state.minimumPressureLevel &&
          state.coolSamples >= config.coolSamplesForUpgrade &&
          canRelaxPressure(state, entities, targetMs, config)
        ) {
          const previousPressureLevel = state.pressureLevel;
          state.pressureLevel--;
          state.coolSamples = 0;
          state.settleSamples = config.settleSamples;
          state.frameSamples = [];
          transition = {
            fromPressureLevel: previousPressureLevel,
            toPressureLevel: state.pressureLevel,
            action: "cohort-upgrade",
            medianMs: median,
            p95Ms: p95,
            targetMs,
            managedEntityCount: entities.length,
          };
        }
      }
    }
  }

  allocatePreviewResolutions(state, entities, nowMs, config);
  return transition;
}

export function resolvePreviewResolution(
  input: PreviewResolutionInput,
  config: PreviewResolutionAdaptiveConfig,
): PreviewResolution {
  const originalWidth = Math.max(1, Math.round(input.originalSize.width));
  const originalHeight = Math.max(1, Math.round(input.originalSize.height));
  const originalLongEdge = Math.max(originalWidth, originalHeight);

  const allocatedLongEdge = input.state.allocations.get(input.entityId);
  const targetLongEdge =
    config.enabled && input.isManaged && allocatedLongEdge ? allocatedLongEdge : originalLongEdge;
  const size = sizeFromLongEdge(input.originalSize, targetLongEdge);

  return {
    ...size,
    renderScale: size.width / originalWidth,
    longEdge: Math.max(size.width, size.height),
    managed: config.enabled && input.isManaged,
  };
}

function allocatePreviewResolutions(
  state: PreviewResolutionGovernorState,
  entities: readonly PreviewResolutionGovernorEntity[],
  nowMs: number,
  config: PreviewResolutionAdaptiveConfig,
): void {
  const activeIds = new Set<string>();

  for (const entity of entities) {
    activeIds.add(entity.id);
    const buckets = getEntityBuckets(entity, config);
    const desiredIndex = buckets.length - 1;
    const allocatedIndex = Math.max(0, desiredIndex - state.pressureLevel);
    const desiredLongEdge = buckets[allocatedIndex]!;
    const entityState = getEntityState(state, entity.id);
    const projectedLongEdge = getProjectedLongEdge(entity, config);

    if (Math.abs(projectedLongEdge - entityState.lastProjectedLongEdge) > 0.5) {
      entityState.lastProjectedLongEdge = projectedLongEdge;
      entityState.lastViewportChangeTimeMs = nowMs;
    }

    let targetLongEdge = desiredLongEdge;
    if (
      entityState.currentLongEdge > 0 &&
      desiredLongEdge < entityState.currentLongEdge &&
      !state.forceResolutionUpdate &&
      nowMs - entityState.lastViewportChangeTimeMs < config.zoomDownscaleIdleDelayMs
    ) {
      targetLongEdge = entityState.currentLongEdge;
    }

    entityState.currentLongEdge = targetLongEdge;
    state.allocations.set(entity.id, targetLongEdge);
  }

  for (const entityId of state.allocations.keys()) {
    if (!activeIds.has(entityId)) state.allocations.delete(entityId);
  }
  state.forceResolutionUpdate = false;
}

function canRelaxPressure(
  state: PreviewResolutionGovernorState,
  entities: readonly PreviewResolutionGovernorEntity[],
  targetMs: number,
  config: PreviewResolutionAdaptiveConfig,
): boolean {
  const currentCostMs = estimateWorkloadCost(state, entities, state.pressureLevel, config);
  const nextCostMs = estimateWorkloadCost(state, entities, state.pressureLevel - 1, config);

  if (nextCostMs <= currentCostMs) return true;
  if (currentCostMs === 0) return true;
  return nextCostMs <= targetMs * config.upgradeHeadroomMultiplier;
}

function estimateWorkloadCost(
  state: PreviewResolutionGovernorState,
  entities: readonly PreviewResolutionGovernorEntity[],
  pressureLevel: number,
  config: PreviewResolutionAdaptiveConfig,
): number {
  let total = 0;
  for (const entity of entities) {
    const buckets = getEntityBuckets(entity, config);
    const bucketIndex = Math.max(0, buckets.length - 1 - pressureLevel);
    const longEdge = buckets[bucketIndex]!;
    const size = sizeFromLongEdge(entity.originalSize, longEdge);
    const megapixels = (size.width * size.height) / 1_000_000;
    const cost = state.entityCosts.get(entity.id);
    if (!cost || cost.samplesMsPerMegapixel.length === 0) continue;
    total += percentile(cost.samplesMsPerMegapixel, 0.5) * megapixels;
  }
  return total;
}

function resetGovernorWorkload(state: PreviewResolutionGovernorState): void {
  state.frameSamples = [];
  state.coolSamples = 0;
  state.settleSamples = 0;
  state.pressureLevel = 0;
  state.minimumPressureLevel = 0;
  state.relaxationBlockedSamples = 0;
  state.forceResolutionUpdate = false;
  state.allocations.clear();
  state.entityStates.clear();
}

function blockFailedRelaxation(
  state: PreviewResolutionGovernorState,
  minimumPressureLevel: number,
  config: PreviewResolutionAdaptiveConfig,
): void {
  if (config.failedRelaxationBlockSamples <= 0) return;
  state.minimumPressureLevel = Math.max(state.minimumPressureLevel, minimumPressureLevel);
  state.relaxationBlockedSamples = Math.max(
    state.relaxationBlockedSamples,
    config.failedRelaxationBlockSamples,
  );
}

function decayRelaxationBlock(state: PreviewResolutionGovernorState): void {
  if (state.relaxationBlockedSamples <= 0) return;
  state.relaxationBlockedSamples--;
  if (state.relaxationBlockedSamples === 0) {
    state.minimumPressureLevel = 0;
  }
}

function pruneInactiveState(
  state: PreviewResolutionGovernorState,
  entities: readonly PreviewResolutionGovernorEntity[],
): void {
  const activeIds = new Set(entities.map((entity) => entity.id));
  for (const entityId of state.entityStates.keys()) {
    if (!activeIds.has(entityId)) state.entityStates.delete(entityId);
  }
  for (const entityId of state.entityCosts.keys()) {
    if (!activeIds.has(entityId)) state.entityCosts.delete(entityId);
  }
}

function getEntityState(
  state: PreviewResolutionGovernorState,
  entityId: string,
): PreviewResolutionEntityState {
  let entityState = state.entityStates.get(entityId);
  if (!entityState) {
    entityState = {
      currentLongEdge: 0,
      lastProjectedLongEdge: 0,
      lastViewportChangeTimeMs: 0,
    };
    state.entityStates.set(entityId, entityState);
  }
  return entityState;
}

function getMaxPressureLevel(
  entities: readonly PreviewResolutionGovernorEntity[],
  config: PreviewResolutionAdaptiveConfig,
): number {
  return entities.reduce(
    (max, entity) => Math.max(max, getEntityBuckets(entity, config).length - 1),
    0,
  );
}

function getEntityBuckets(
  entity: PreviewResolutionGovernorEntity,
  config: PreviewResolutionAdaptiveConfig,
): number[] {
  const originalLongEdge = Math.max(
    1,
    Math.round(Math.max(entity.originalSize.width, entity.originalSize.height)),
  );
  const maxLongEdge = Math.min(originalLongEdge, config.maxLongEdge);
  if (originalLongEdge <= config.minLongEdge || maxLongEdge <= config.minLongEdge) {
    return [originalLongEdge];
  }

  const projectedTarget = bucketLongEdge(getProjectedLongEdge(entity, config), config);
  const desiredLongEdge = Math.min(originalLongEdge, maxLongEdge, projectedTarget);
  const buckets: number[] = [config.minLongEdge];
  let next = config.minLongEdge;
  const factor = Math.max(1, config.bucketFactor);

  while (factor > 1) {
    next *= factor;
    if (next >= desiredLongEdge) break;
    buckets.push(Math.round(next));
  }

  if (buckets[buckets.length - 1] !== desiredLongEdge) {
    buckets.push(desiredLongEdge);
  }

  return buckets.map((bucket) => Math.min(originalLongEdge, Math.max(1, Math.round(bucket))));
}

function getProjectedLongEdge(
  entity: PreviewResolutionGovernorEntity,
  config: PreviewResolutionAdaptiveConfig,
): number {
  return (
    Math.max(entity.entitySize.width, entity.entitySize.height) *
    entity.viewportZoom *
    config.projectedOversample
  );
}

function bucketLongEdge(value: number, config: PreviewResolutionAdaptiveConfig): number {
  if (value <= config.minLongEdge || config.bucketFactor <= 1) return config.minLongEdge;
  const exponent = Math.ceil(Math.log(value / config.minLongEdge) / Math.log(config.bucketFactor));
  return config.minLongEdge * config.bucketFactor ** exponent;
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
