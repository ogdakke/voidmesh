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
  zoom?: number;
  zoomRange?: { min: number; max: number };
  processPixels: boolean;
  selectedEntityFraction?: number;
  selectedEntityCount?: number;
  debugMode?: boolean;
  dragSelectedEntities?: boolean;
  dragSelectEntities?: boolean;
  mixedStaticVariants?: boolean;
  tweakSingleEntityParams?: boolean;
  paceWithAnimationFrame?: boolean;
  recordPerFrame?: boolean;
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
  {
    id: "many-16384-shared-processed-all-visible",
    label: "16,384 shared instances, instanced processed result",
    description:
      "Composes 2^14 identical processed instances in one viewport to guard shared-texture instancing and command submission scaling.",
    entityCount: 16_384,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 6, height: 6 },
    assetMode: "shared",
    layout: "all-visible",
    pan: false,
    processPixels: true,
    frames: 24,
    warmupFrames: 4,
    samples: 3,
  },
  {
    id: "many-131072-shared-processed-overview-pan",
    label: "131,072 shared instances, 50k+ visible overview",
    description:
      "Pans a low-zoom viewport containing roughly 50,000–60,000 visible processed instances through a 2^17-entity world.",
    entityCount: 131_072,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 6, height: 6 },
    assetMode: "shared",
    layout: "world-grid",
    pan: true,
    zoom: 0.18,
    processPixels: true,
    frames: 18,
    warmupFrames: 4,
    samples: 3,
  },
  {
    id: "many-262144-shared-processed-overview-pan",
    label: "262,144 shared instances, no selection",
    description:
      "Pans the duplicated 2^18-instance overview without selection as the direct control for selection-density comparisons.",
    entityCount: 262_144,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 6, height: 6 },
    assetMode: "shared",
    layout: "world-grid",
    pan: true,
    zoom: 0.18,
    processPixels: true,
    paceWithAnimationFrame: true,
    recordPerFrame: true,
    frames: 18,
    warmupFrames: 4,
    samples: 3,
  },
  {
    id: "many-262144-shared-mixed-static-overview-pan",
    label: "262,144 shared instances, mixed static effects",
    description:
      "Pans contiguous dithering, ASCII, processed, and show-original regions while preserving one mixed full-scene composition plan.",
    entityCount: 262_144,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 6, height: 6 },
    assetMode: "shared",
    layout: "world-grid",
    pan: true,
    zoom: 0.18,
    processPixels: true,
    mixedStaticVariants: true,
    paceWithAnimationFrame: true,
    recordPerFrame: true,
    frames: 18,
    warmupFrames: 4,
    samples: 3,
  },
  {
    id: "many-131072-shared-mixed-static-zoom-round-trip",
    label: "131,072 shared mixed instances, zoom round trip",
    description:
      "Zooms a mixed static 2^17-entity canvas from 1% to 30% and back, guarding against rebuilding the persistent composition plan on every zoom frame.",
    entityCount: 131_072,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 6, height: 6 },
    assetMode: "shared",
    layout: "world-grid",
    pan: false,
    zoomRange: { min: 0.01, max: 0.3 },
    processPixels: true,
    mixedStaticVariants: true,
    paceWithAnimationFrame: true,
    recordPerFrame: true,
    frames: 24,
    warmupFrames: 4,
    samples: 3,
  },
  {
    id: "many-131072-shared-single-param-tweak",
    label: "131,072 shared instances, one entity parameter changing",
    description:
      "Changes one selected entity's shader parameters every frame while preserving the persistent scene and patching only its texture run.",
    entityCount: 131_072,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 6, height: 6 },
    assetMode: "shared",
    layout: "world-grid",
    pan: false,
    zoom: 0.01,
    processPixels: true,
    selectedEntityCount: 1,
    tweakSingleEntityParams: true,
    paceWithAnimationFrame: true,
    recordPerFrame: true,
    frames: 24,
    warmupFrames: 4,
    samples: 3,
  },
  {
    id: "many-262144-shared-processed-overview-pan-single-selected",
    label: "262,144 shared instances, one selected",
    description:
      "Pans the duplicated overview with one selected entity, including the z-ordered entity-label split draw.",
    entityCount: 262_144,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 6, height: 6 },
    assetMode: "shared",
    layout: "world-grid",
    pan: true,
    zoom: 0.18,
    processPixels: true,
    selectedEntityCount: 1,
    paceWithAnimationFrame: true,
    recordPerFrame: true,
    frames: 18,
    warmupFrames: 4,
    samples: 3,
  },
  {
    id: "many-262144-shared-processed-overview-pan-half-selected",
    label: "262,144 shared instances, half selected",
    description:
      "Pans the duplicated 2^18-instance overview with half of the entities selected, guarding the persistent selection-aware composition batch.",
    entityCount: 262_144,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 6, height: 6 },
    assetMode: "shared",
    layout: "world-grid",
    pan: true,
    zoom: 0.18,
    processPixels: true,
    selectedEntityFraction: 0.5,
    paceWithAnimationFrame: true,
    recordPerFrame: true,
    frames: 18,
    warmupFrames: 4,
    samples: 3,
  },
  {
    id: "many-262144-shared-processed-overview-pan-all-selected",
    label: "262,144 shared instances, all selected",
    description:
      "Pans the duplicated overview with every entity selected, guarding the maximum selection-density instance payload.",
    entityCount: 262_144,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 6, height: 6 },
    assetMode: "shared",
    layout: "world-grid",
    pan: true,
    zoom: 0.18,
    processPixels: true,
    selectedEntityFraction: 1,
    paceWithAnimationFrame: true,
    recordPerFrame: true,
    frames: 18,
    warmupFrames: 4,
    samples: 3,
  },
  {
    id: "many-262144-shared-processed-overview-pan-half-selected-debug",
    label: "262,144 shared instances, half selected, debug",
    description:
      "Runs the same half-selected overview with debug borders enabled, guarding against debug-mode batch ejection.",
    entityCount: 262_144,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 6, height: 6 },
    assetMode: "shared",
    layout: "world-grid",
    pan: true,
    zoom: 0.18,
    processPixels: true,
    selectedEntityFraction: 0.5,
    debugMode: true,
    paceWithAnimationFrame: true,
    recordPerFrame: true,
    frames: 18,
    warmupFrames: 4,
    samples: 3,
  },
  {
    id: "many-262144-shared-processed-overview-drag-half-selected",
    label: "262,144 shared instances, dragging half",
    description:
      "Moves half of the duplicated overview through the selected-group GPU transform without rebuilding instance data.",
    entityCount: 262_144,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 6, height: 6 },
    assetMode: "shared",
    layout: "world-grid",
    pan: false,
    zoom: 0.18,
    processPixels: true,
    selectedEntityFraction: 0.5,
    dragSelectedEntities: true,
    paceWithAnimationFrame: true,
    recordPerFrame: true,
    frames: 18,
    warmupFrames: 4,
    samples: 3,
  },
  {
    id: "many-262144-shared-processed-overview-drag-select",
    label: "262,144 shared instances, expanding drag selection",
    description:
      "Expands a replace-mode drag-selection rectangle through the overview using GPU AABB membership without rebuilding scene instances.",
    entityCount: 262_144,
    uniqueAssetCount: 1,
    sourceSize: { width: 1024, height: 1024 },
    displaySize: { width: 6, height: 6 },
    assetMode: "shared",
    layout: "world-grid",
    pan: false,
    zoom: 0.18,
    processPixels: true,
    dragSelectEntities: true,
    paceWithAnimationFrame: true,
    recordPerFrame: true,
    frames: 18,
    warmupFrames: 4,
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
