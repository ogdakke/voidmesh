export type ZoomStressMediaKind = "image" | "video";
export type ZoomStressPhase =
  | "detail-hold"
  | "zoom-out"
  | "overview-hold"
  | "zoom-in"
  | "target-hold";

export interface ZoomStressScenarioConfig {
  id: string;
  label: string;
  description: string;
  entityCount: number;
  imageCount: number;
  videoCount: number;
  imageSourceSize: { width: number; height: number };
  videoSourceSize: { width: number; height: number };
  imageDisplaySize: { width: number; height: number };
  videoDisplaySize: { width: number; height: number };
  columns: number;
  cellSize: { width: number; height: number };
  targetIndex: number;
  detailZoom: number;
  overviewZoom: number;
  detailHoldFrames: number;
  zoomOutFrames: number;
  overviewHoldFrames: number;
  zoomInFrames: number;
  targetHoldFrames: number;
  warmupFrames: number;
  samples: number;
}

export interface ZoomStressFrame {
  phase: ZoomStressPhase;
  phaseFrame: number;
  zoom: number;
  viewport: {
    offset: { x: number; y: number };
    zoom: number;
  };
}

/**
 * Mirrors a real mixed-media workspace: unique medium/large sources are spread
 * over a world grid, then a cursor-anchored zoom exposes every entity before
 * returning to one image at full display detail.
 */
export const ZOOM_STRESS_SCENARIO = {
  id: "zoom-61-unique-mixed-round-trip",
  label: "61 unique mixed media, overview to detail",
  description:
    "Zooms from one entity out to 61 unique medium/large images and videos, then back into the target while measuring every frame.",
  entityCount: 61,
  imageCount: 45,
  videoCount: 16,
  imageSourceSize: { width: 2048, height: 1365 },
  videoSourceSize: { width: 1280, height: 720 },
  imageDisplaySize: { width: 420, height: 280 },
  videoDisplaySize: { width: 420, height: 236 },
  columns: 8,
  cellSize: { width: 680, height: 480 },
  targetIndex: 29,
  detailZoom: 2.2,
  overviewZoom: 0.14,
  detailHoldFrames: 4,
  zoomOutFrames: 44,
  overviewHoldFrames: 8,
  zoomInFrames: 60,
  targetHoldFrames: 4,
  warmupFrames: 4,
  samples: 3,
} as const satisfies ZoomStressScenarioConfig;

export function getZoomStressFrameCount(config: ZoomStressScenarioConfig): number {
  return (
    config.detailHoldFrames +
    config.zoomOutFrames +
    config.overviewHoldFrames +
    config.zoomInFrames +
    config.targetHoldFrames
  );
}

export function getZoomStressMediaKind(
  config: ZoomStressScenarioConfig,
  index: number,
): ZoomStressMediaKind {
  assertEntityIndex(config, index);
  // 0, 4, ... 60 gives exactly 16 videos distributed across the grid.
  return index % 4 === 0 ? "video" : "image";
}

export function getZoomStressSourceSize(
  config: ZoomStressScenarioConfig,
  index: number,
): { width: number; height: number } {
  return getZoomStressMediaKind(config, index) === "video"
    ? config.videoSourceSize
    : config.imageSourceSize;
}

export function getZoomStressDisplaySize(
  config: ZoomStressScenarioConfig,
  index: number,
): { width: number; height: number } {
  return getZoomStressMediaKind(config, index) === "video"
    ? config.videoDisplaySize
    : config.imageDisplaySize;
}

export function getZoomStressPosition(
  config: ZoomStressScenarioConfig,
  index: number,
): { x: number; y: number } {
  assertEntityIndex(config, index);
  return {
    x: (index % config.columns) * config.cellSize.width,
    y: Math.floor(index / config.columns) * config.cellSize.height,
  };
}

export function getZoomStressTargetCenter(config: ZoomStressScenarioConfig): {
  x: number;
  y: number;
} {
  const position = getZoomStressPosition(config, config.targetIndex);
  const size = getZoomStressDisplaySize(config, config.targetIndex);
  return {
    x: position.x + size.width / 2,
    y: position.y + size.height / 2,
  };
}

export function getZoomStressFrame(
  config: ZoomStressScenarioConfig,
  frameIndex: number,
  canvasSize: { width: number; height: number },
): ZoomStressFrame {
  const frameCount = getZoomStressFrameCount(config);
  const index = positiveModulo(Math.floor(frameIndex), frameCount);
  const target = getZoomStressTargetCenter(config);

  const detailEnd = config.detailHoldFrames;
  const zoomOutEnd = detailEnd + config.zoomOutFrames;
  const overviewEnd = zoomOutEnd + config.overviewHoldFrames;
  const zoomInEnd = overviewEnd + config.zoomInFrames;

  let phase: ZoomStressPhase;
  let phaseFrame: number;
  let zoom: number;
  if (index < detailEnd) {
    phase = "detail-hold";
    phaseFrame = index;
    zoom = config.detailZoom;
  } else if (index < zoomOutEnd) {
    phase = "zoom-out";
    phaseFrame = index - detailEnd;
    zoom = interpolateZoom(
      config.detailZoom,
      config.overviewZoom,
      (phaseFrame + 1) / config.zoomOutFrames,
    );
  } else if (index < overviewEnd) {
    phase = "overview-hold";
    phaseFrame = index - zoomOutEnd;
    zoom = config.overviewZoom;
  } else if (index < zoomInEnd) {
    phase = "zoom-in";
    phaseFrame = index - overviewEnd;
    zoom = interpolateZoom(
      config.overviewZoom,
      config.detailZoom,
      (phaseFrame + 1) / config.zoomInFrames,
    );
  } else {
    phase = "target-hold";
    phaseFrame = index - zoomInEnd;
    zoom = config.detailZoom;
  }

  return {
    phase,
    phaseFrame,
    zoom,
    viewport: {
      offset: {
        x: target.x - canvasSize.width / (2 * zoom),
        y: target.y - canvasSize.height / (2 * zoom),
      },
      zoom,
    },
  };
}

export function estimateZoomStressDecodedBytes(config: ZoomStressScenarioConfig): number {
  return (
    config.imageCount * config.imageSourceSize.width * config.imageSourceSize.height * 4 +
    config.videoCount * config.videoSourceSize.width * config.videoSourceSize.height * 4
  );
}

function interpolateZoom(from: number, to: number, progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  const eased = clamped * clamped * (3 - 2 * clamped);
  return Math.exp(Math.log(from) + (Math.log(to) - Math.log(from)) * eased);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function assertEntityIndex(config: ZoomStressScenarioConfig, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= config.entityCount) {
    throw new Error(`Zoom stress entity index ${index} is out of range`);
  }
}
