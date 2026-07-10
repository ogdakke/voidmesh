export type ManyEntityAssetMode = "shared" | "unique";
export type ManyEntityLayout = "all-visible" | "world-grid";

export interface ManyEntityScenarioConfig {
  id: string;
  label: string;
  description: string;
  entityCount: number;
  uniqueAssetCount: number;
  sourceSize: { width: number; height: number };
  displaySize: { width: number; height: number };
  assetMode: ManyEntityAssetMode;
  layout: ManyEntityLayout;
  pan: boolean;
  processPixels: boolean;
  frames: number;
  warmupFrames: number;
  samples: number;
}

export const MANY_ENTITY_SCENARIOS: readonly ManyEntityScenarioConfig[] = [
  {
    id: "many-10000-shared-original-all-visible",
    label: "10k shared image instances, all visible",
    description:
      "Composes 10,000 instances of one 1024px image in one viewport; isolates shared-source residency and draw setup.",
    entityCount: 10_000,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 10, height: 6 },
    assetMode: "shared",
    layout: "all-visible",
    pan: false,
    processPixels: false,
    frames: 12,
    warmupFrames: 2,
    samples: 3,
  },
  {
    id: "many-10000-shared-original-small-visible",
    label: "10k shared image instances, small visible set",
    description:
      "Keeps 10,000 instances in world space while only a small viewport-sized subset is admitted to the renderer.",
    entityCount: 10_000,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 96, height: 96 },
    assetMode: "shared",
    layout: "world-grid",
    pan: false,
    processPixels: false,
    frames: 60,
    warmupFrames: 8,
    samples: 3,
  },
  {
    id: "many-10000-shared-original-pan",
    label: "10k shared image instances, viewport sweep",
    description:
      "Pans through a 10,000-instance world grid to measure culling and composition-cache churn with one shared source.",
    entityCount: 10_000,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 96, height: 96 },
    assetMode: "shared",
    layout: "world-grid",
    pan: true,
    processPixels: false,
    frames: 90,
    warmupFrames: 8,
    samples: 3,
  },
  {
    id: "many-4096-unique-thumbnails-all-visible",
    label: "4,096 unique thumbnails, all visible",
    description:
      "Uploads and composes 4,096 distinct 128px image assets in one viewport to expose per-asset source residency.",
    entityCount: 4096,
    uniqueAssetCount: 4096,
    sourceSize: { width: 128, height: 128 },
    displaySize: { width: 16, height: 10 },
    assetMode: "unique",
    layout: "all-visible",
    pan: false,
    processPixels: false,
    frames: 12,
    warmupFrames: 2,
    samples: 3,
  },
  {
    id: "many-4096-unique-thumbnails-pan",
    label: "4,096 unique thumbnails, viewport sweep",
    description:
      "Sweeps through distinct 192px assets so the source cache exceeds its budget and exercises LRU eviction and re-upload.",
    entityCount: 4096,
    uniqueAssetCount: 4096,
    sourceSize: { width: 192, height: 192 },
    displaySize: { width: 96, height: 96 },
    assetMode: "unique",
    layout: "world-grid",
    pan: true,
    processPixels: false,
    frames: 90,
    warmupFrames: 8,
    samples: 3,
  },
  {
    id: "many-2048-shared-processed-all-visible",
    label: "2,048 shared instances, shared processed result",
    description:
      "Applies identical processing to 2,048 instances of one 128px source, verifying processed-result sharing and residency.",
    entityCount: 2048,
    uniqueAssetCount: 1,
    sourceSize: { width: 128, height: 128 },
    displaySize: { width: 22, height: 14 },
    assetMode: "shared",
    layout: "all-visible",
    pan: false,
    processPixels: true,
    frames: 12,
    warmupFrames: 2,
    samples: 3,
  },
] as const;

export interface ManyEntityPositionOptions {
  index: number;
  entityCount: number;
  displaySize: { width: number; height: number };
  layout: ManyEntityLayout;
  canvasSize: { width: number; height: number };
}

export function getManyEntityPosition(options: ManyEntityPositionOptions): {
  x: number;
  y: number;
} {
  if (options.layout === "all-visible") {
    const preferredColumns = Math.ceil(
      Math.sqrt(options.entityCount * (options.canvasSize.width / options.canvasSize.height)),
    );
    const maxFittingColumns = Math.max(
      1,
      Math.floor(options.canvasSize.width / options.displaySize.width),
    );
    const columns = Math.min(preferredColumns, maxFittingColumns);
    const rows = Math.ceil(options.entityCount / columns);
    const cellWidth = options.canvasSize.width / columns;
    const cellHeight = options.canvasSize.height / rows;
    return {
      x: (options.index % columns) * cellWidth + (cellWidth - options.displaySize.width) / 2,
      y:
        Math.floor(options.index / columns) * cellHeight +
        (cellHeight - options.displaySize.height) / 2,
    };
  }

  const columns = Math.ceil(Math.sqrt(options.entityCount));
  const gap = Math.max(
    16,
    Math.round(Math.max(options.displaySize.width, options.displaySize.height) * 0.25),
  );
  return {
    x: (options.index % columns) * (options.displaySize.width + gap),
    y: Math.floor(options.index / columns) * (options.displaySize.height + gap),
  };
}

export function getManyEntityViewportOffset(
  config: ManyEntityScenarioConfig,
  frameIndex: number,
  canvasSize: { width: number; height: number },
): { x: number; y: number } {
  if (!config.pan || config.layout === "all-visible") return { x: 0, y: 0 };

  const columns = Math.ceil(Math.sqrt(config.entityCount));
  const rows = Math.ceil(config.entityCount / columns);
  const gap = Math.max(
    16,
    Math.round(Math.max(config.displaySize.width, config.displaySize.height) * 0.25),
  );
  const worldWidth = columns * (config.displaySize.width + gap);
  const worldHeight = rows * (config.displaySize.height + gap);
  const maxX = Math.max(0, worldWidth - canvasSize.width);
  const maxY = Math.max(0, worldHeight - canvasSize.height);
  const page = Math.floor(frameIndex / 3);
  const pagesX = Math.max(1, Math.ceil(worldWidth / canvasSize.width));
  const xPage = page % pagesX;
  const yPage = Math.floor(page / pagesX) % Math.max(1, Math.ceil(worldHeight / canvasSize.height));

  return {
    x: Math.min(maxX, xPage * canvasSize.width),
    y: Math.min(maxY, yPage * canvasSize.height),
  };
}

export function estimateDecodedAssetBytes(config: ManyEntityScenarioConfig): number {
  return config.uniqueAssetCount * config.sourceSize.width * config.sourceSize.height * 4;
}
