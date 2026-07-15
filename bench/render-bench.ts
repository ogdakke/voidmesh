import { InfiniteCanvasRenderer } from "#renderer/canvas-renderer.ts";
import {
  DitheringKind,
  GlassKind,
  GlitchKind,
  MediaType,
  ShaderType,
  Shape,
  type ShaderCanvasEntity,
  type MediaImageAsset,
  type MediaSourceVideo,
  type PlaybackState,
  type ShaderParams,
  type Size,
  type Viewport,
} from "#types/canvas.ts";
import type { RenderState } from "#engine";
import { createImageAsset, releaseImageAsset } from "#lib/media-assets.ts";
import { EntitySpatialIndex } from "#lib/entity-spatial-index.ts";
import {
  createBatchedBenchResources,
  disposeBenchEntities,
  disposeBenchResources,
  getBenchEntityShaderParams,
  resolveBenchShaderParams,
  retainBenchImageMedia,
  type ResolvedBenchShaderParams,
} from "./render-bench-fixtures.ts";
import {
  MANY_ENTITY_SCENARIOS,
  estimateDecodedAssetBytes,
  getManyEntityPosition,
  getManyEntityViewportOffset,
  type ManyEntityScenarioConfig,
} from "./many-entity-scenarios.ts";
import {
  ZOOM_STRESS_SCENARIO,
  estimateZoomStressDecodedBytes,
  getZoomStressDisplaySize,
  getZoomStressFrame,
  getZoomStressFrameCount,
  getZoomStressMediaKind,
  getZoomStressPosition,
  getZoomStressSourceSize,
  type ZoomStressPhase,
  type ZoomStressScenarioConfig,
} from "./zoom-stress-scenario.ts";

import "#styles/reset.css";

import "./render-bench.css";

type ScenarioKind = "image" | "video" | "multi";
type DirtyMode = "none" | "texture" | "video";

interface BenchScenario {
  id: string;
  label: string;
  description: string;
  kind: ScenarioKind;
  sourceSize: Size;
  entityCount?: number;
  shaderType: ShaderType;
  params: Partial<ShaderParams>;
  dirtyMode: DirtyMode;
  frames: number;
  warmupFrames: number;
  samples: number;
  manyEntity?: ManyEntityScenarioConfig;
  zoomStress?: ZoomStressScenarioConfig;
  synchronizeEachFrame?: boolean;
  paceWithAnimationFrame?: boolean;
  recordPerFrame?: boolean;
  resetTexturesBeforeSample?: boolean;
}

type BenchResourceStats = ReturnType<InfiniteCanvasRenderer["getResourceStats"]>;

interface BenchActivityMetrics {
  renderedEntities: number;
  renderedEntitiesPerFrame: number;
  minRenderedEntitiesPerFrame: number;
  maxRenderedEntitiesPerFrame: number;
  sourceTextureAllocations: number;
  processedTextureAllocations: number;
  sourceUploads: number;
  evictions: number;
  fullSceneBatchRebuilds: number;
  fullSceneBatchUploadBytes: number;
  normalInstanceUploadBytes: number;
}

interface BenchFrameSample {
  index: number;
  frameIndex: number;
  phase: ZoomStressPhase | null;
  zoom: number;
  rafIntervalMs: number | null;
  sourceUpdateMs: number;
  cpuCallMs: number;
  cpuRenderMs: number;
  renderPhases: ReturnType<InfiniteCanvasRenderer["getFrameStats"]>["phases"] | null;
  queueWaitMs: number | null;
  endToEndMs: number | null;
  renderedEntities: number;
  residentBytes: number;
  sourceBytes: number;
  processedBytes: number;
  sourceTextureCount: number;
  processedTextureCount: number;
  sourceTextureAllocations: number;
  processedTextureAllocations: number;
  sourceUploads: number;
  evictions: number;
}

interface BenchSample {
  index: number;
  frames: number;
  startFrameIndex: number;
  totalMs: number;
  cpuEncodeMs: number;
  queueDrainMs: number;
  msPerFrame: number;
  cpuEncodeMsPerFrame: number;
  queueDrainMsPerFrame: number;
  peakResidentBytes: number;
  resources: BenchResourceStats;
  activity: BenchActivityMetrics;
  frameSamples: BenchFrameSample[];
  sourceUpdateMedianMs: number;
  sourceUpdateP95Ms: number;
  sourceUpdateMaxMs: number;
  rafIntervalMedianMs: number;
  rafIntervalP95Ms: number;
  rafIntervalMaxMs: number;
  cpuRenderMedianMs: number;
  cpuRenderP95Ms: number;
  cpuRenderMaxMs: number;
  endToEndMedianMs: number;
  endToEndP95Ms: number;
  endToEndMaxMs: number;
}

interface BenchResult {
  id: string;
  label: string;
  description: string;
  shaderType: ShaderType;
  dirtyMode: DirtyMode;
  sourceSize: Size;
  entityCount: number;
  frames: number;
  warmupFrames: number;
  sampleCount: number;
  samples: number[];
  sampleDetails: BenchSample[];
  medianMs: number;
  p95Ms: number;
  msPerFrame: number;
  cpuEncodeMedianMs: number;
  queueDrainMedianMs: number;
  cpuEncodeMsPerFrame: number;
  queueDrainMsPerFrame: number;
  timingMode: "batched" | "gpu-synchronized" | "raf-paced";
  sourceUpdateMedianMs: number;
  sourceUpdateP95Ms: number;
  sourceUpdateMaxMs: number;
  rafIntervalMedianMs: number;
  rafIntervalP95Ms: number;
  rafIntervalMaxMs: number;
  cpuRenderMedianMs: number;
  cpuRenderP95Ms: number;
  cpuRenderMaxMs: number;
  endToEndMedianMs: number;
  endToEndP95Ms: number;
  endToEndMaxMs: number;
  decodedAssetEstimateBytes: number;
  peakResidentBytes: number;
  resources: BenchResourceStats;
  activity: BenchActivityMetrics;
  mediaCounts?: { image: number; video: number };
}

interface VisualMetrics {
  width: number;
  height: number;
  fnv1a32: string;
  meanChannel: number;
  nonTransparentRatio: number;
}

interface VisualCaptureResult {
  id: string;
  label: string;
  sourceSize: Size;
  time: number;
  shaderType: ShaderType;
  shaderKind: GlassKind;
  metrics: VisualMetrics;
}

interface BenchMetadata {
  createdAt: string;
  location: string;
  userAgent: string;
  platform: string;
  hardwareConcurrency: number;
  devicePixelRatio: number;
  webgpu: {
    available: boolean;
    wgslLanguageFeatures: string[];
    immediatesSupported: boolean;
    adapterInfo: Record<string, unknown> | null;
    limits: Record<string, number>;
    features: string[];
  };
}

interface BenchEntitySet {
  entities: ShaderCanvasEntity[];
  selectedEntityIds?: ReadonlySet<string>;
  debugMode?: boolean;
  dragSelectedEntities?: boolean;
  dragSelectEntities?: boolean;
  tweakSingleEntityParams?: boolean;
  beforeFrame?: (frameIndex: number) => void;
  getViewportOffset?: (frameIndex: number) => { x: number; y: number };
  getViewport?: (frameIndex: number, sampleFrameIndex: number) => Viewport;
  getFramePhase?: (frameIndex: number, sampleFrameIndex: number) => ZoomStressPhase | null;
  decodedAssetEstimateBytes?: number;
  mediaCounts?: { image: number; video: number };
  cleanup?: () => void;
}

declare global {
  interface Window {
    __voidmeshBenchResults?: BenchResult[];
    __voidmeshBenchVisual?: VisualCaptureResult;
    __captureVoidmeshRenderBenchVisual?: () => Promise<VisualCaptureResult>;
    __runVoidmeshRenderBenchScenario?: (scenarioId: string) => Promise<BenchResult>;
    __runVoidmeshRenderBench?: () => Promise<BenchResult[]>;
    __runVoidmeshManyEntityBench?: () => Promise<BenchResult[]>;
    __collectVoidmeshRenderBenchMetadata?: () => Promise<BenchMetadata>;
  }
}

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;

const scenarios: BenchScenario[] = [
  {
    id: "image-original-4k-composition",
    label: "4K image, cached original composition",
    description: "Static 4K image after upload; measures canvas composition and renderer overhead.",
    kind: "image",
    sourceSize: { width: 3840, height: 2160 },
    shaderType: ShaderType.dithering,
    params: {
      showOriginal: true,
      postProcess: { enabled: false },
      adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
    },
    dirtyMode: "none",
    frames: 180,
    warmupFrames: 20,
    samples: 5,
  },
  {
    id: "image-dither-4k-upload-shader",
    label: "4K image, upload + ordered dithering",
    description: "Forces source upload and shader processing each frame.",
    kind: "image",
    sourceSize: { width: 3840, height: 2160 },
    shaderType: ShaderType.dithering,
    params: {
      size: 1,
      scale: 1,
      preserveColors: false,
      dithering: { kind: DitheringKind.bayer8x8 },
      postProcess: { enabled: false },
      adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
    },
    dirtyMode: "texture",
    frames: 60,
    warmupFrames: 8,
    samples: 5,
  },
  {
    id: "image-flowing-glass-4k-continuous",
    label: "4K image, flowing glass continuous",
    description: "Static source texture with time-animated flowing glass re-rendering every frame.",
    kind: "image",
    sourceSize: { width: 3840, height: 2160 },
    shaderType: ShaderType.glass,
    params: {
      size: 40,
      intensity: 4,
      scale: 1.55,
      glass: {
        kind: GlassKind.flowing,
        angle: 0,
        caustic: 1,
        frostiness: 0.8,
        highlight: 0.1,
        dispersion: 0.6,
        flow: 0.5,
      },
      postProcess: { enabled: false },
      adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
      timeAutoPlay: true,
    },
    dirtyMode: "none",
    frames: 90,
    warmupFrames: 12,
    samples: 5,
  },
  {
    id: "video-glitch-1080p-upload-shader",
    label: "1080p synthetic video, upload + glitch",
    description: "Canvas-backed video element upload plus glitch shader processing.",
    kind: "video",
    sourceSize: { width: 1920, height: 1080 },
    shaderType: ShaderType.glitch,
    params: {
      size: 25,
      intensity: 1,
      scale: 1,
      preserveColors: true,
      glitch: { kind: GlitchKind.channelShift, angle: 0 },
      postProcess: { enabled: false },
      adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
    },
    dirtyMode: "video",
    frames: 120,
    warmupFrames: 20,
    samples: 5,
  },
  {
    id: "image-bloom-1440p-stack",
    label: "1440p image, shader + bloom stack",
    description: "Forces shader, bloom, grain, and chromatic post-processing.",
    kind: "image",
    sourceSize: { width: 2560, height: 1440 },
    shaderType: ShaderType.halftone,
    params: {
      size: 10,
      intensity: 1,
      scale: 1,
      shape: Shape.circle,
      preserveColors: true,
      postProcess: {
        enabled: true,
        grain: { enabled: true, size: 1, intensity: 0.12 },
        bloom: { enabled: true, threshold: 0.35, intensity: 0.2, filterRadius: 21, softness: 0.1 },
        chromaticAberration: { enabled: true, offset: 3 },
      },
      adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
    },
    dirtyMode: "texture",
    frames: 45,
    warmupFrames: 6,
    samples: 5,
  },
  {
    id: "multi-25-flowing-glass-continuous",
    label: "25 1024px entities, flowing glass continuous",
    description:
      "Many continuously animated flowing-glass entities; stresses per-entity uniform uploads and draw setup.",
    kind: "multi",
    entityCount: 25,
    sourceSize: { width: 1024, height: 1024 },
    shaderType: ShaderType.glass,
    params: {
      size: 28,
      intensity: 3,
      scale: 1.35,
      glass: {
        kind: GlassKind.flowing,
        angle: 0,
        caustic: 1,
        frostiness: 0.8,
        highlight: 0.1,
        dispersion: 0.45,
        flow: 0.65,
      },
      postProcess: { enabled: false },
      adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
      timeAutoPlay: true,
    },
    dirtyMode: "none",
    frames: 60,
    warmupFrames: 10,
    samples: 5,
  },
  {
    id: "image-grain-4k-continuous-postprocess",
    label: "4K image, animated grain post-process",
    description:
      "Static source with animated grain; isolates the 64-byte post-process uniform path and time churn.",
    kind: "image",
    sourceSize: { width: 3840, height: 2160 },
    shaderType: ShaderType.halftone,
    params: {
      showOriginal: true,
      postProcess: {
        enabled: true,
        grain: { enabled: true, size: 1.25, intensity: 0.15 },
        bloom: { enabled: false, threshold: 0.8, intensity: 0, filterRadius: 9, softness: 0.1 },
        chromaticAberration: { enabled: false, offset: 0 },
      },
      adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
    },
    dirtyMode: "none",
    frames: 120,
    warmupFrames: 16,
    samples: 5,
  },
  {
    id: "multi-25-cached-composition",
    label: "25 cached 1024px entities, composition",
    description: "Realistic many-entity composition after textures are already cached.",
    kind: "multi",
    entityCount: 25,
    sourceSize: { width: 1024, height: 1024 },
    shaderType: ShaderType.dithering,
    params: {
      showOriginal: true,
      postProcess: { enabled: false },
      adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
    },
    dirtyMode: "none",
    frames: 180,
    warmupFrames: 20,
    samples: 5,
  },
  {
    id: "multi-72-unique-cached-composition",
    label: "72 unique cached images, composition",
    description:
      "Realistic heterogeneous canvas scale with one distinct resident texture per static image.",
    kind: "multi",
    entityCount: 72,
    sourceSize: { width: 512, height: 512 },
    shaderType: ShaderType.dithering,
    params: {
      showOriginal: true,
      postProcess: { enabled: false },
      adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
    },
    dirtyMode: "none",
    frames: 180,
    warmupFrames: 20,
    samples: 5,
  },
];

const imageManyEntityScenarios: BenchScenario[] = MANY_ENTITY_SCENARIOS.map((scenario) => ({
  id: scenario.id,
  label: scenario.label,
  description: scenario.description,
  kind: "multi",
  entityCount: scenario.entityCount,
  sourceSize: scenario.sourceSize,
  shaderType: ShaderType.dithering,
  params: {
    showOriginal: !scenario.processPixels,
    size: 1,
    scale: 1,
    preserveColors: true,
    dithering: { kind: DitheringKind.bayer4x4 },
    postProcess: { enabled: false },
    adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
  },
  dirtyMode: "none",
  frames: scenario.frames,
  warmupFrames: scenario.warmupFrames,
  samples: scenario.samples,
  paceWithAnimationFrame: scenario.paceWithAnimationFrame,
  recordPerFrame: scenario.recordPerFrame,
  manyEntity: scenario,
}));

const zoomStressOriginalScenario: BenchScenario = {
  id: ZOOM_STRESS_SCENARIO.id,
  label: ZOOM_STRESS_SCENARIO.label,
  description: ZOOM_STRESS_SCENARIO.description,
  kind: "multi",
  entityCount: ZOOM_STRESS_SCENARIO.entityCount,
  sourceSize: ZOOM_STRESS_SCENARIO.imageSourceSize,
  shaderType: ShaderType.dithering,
  params: {
    showOriginal: true,
    postProcess: { enabled: false },
    adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
  },
  dirtyMode: "video",
  frames: getZoomStressFrameCount(ZOOM_STRESS_SCENARIO),
  warmupFrames: ZOOM_STRESS_SCENARIO.warmupFrames,
  samples: ZOOM_STRESS_SCENARIO.samples,
  zoomStress: ZOOM_STRESS_SCENARIO,
  synchronizeEachFrame: false,
  paceWithAnimationFrame: true,
  recordPerFrame: true,
  resetTexturesBeforeSample: true,
};

const zoomStressProcessedScenario: BenchScenario = {
  ...zoomStressOriginalScenario,
  id: "zoom-61-unique-mixed-processed-round-trip",
  label: "61 unique mixed media with default effects, overview to detail",
  description:
    "Runs the same 61-source zoom gesture with default dithering, grain, and bloom so native-resolution video processing is represented.",
  params: {},
};

const manyEntityScenarios = [
  ...imageManyEntityScenarios,
  zoomStressOriginalScenario,
  zoomStressProcessedScenario,
];

const allScenarios = [...scenarios, ...manyEntityScenarios];

const FLOWING_GLASS_VISUAL_TIME = 1.75;
const flowingGlassVisualScenario: BenchScenario = {
  id: "visual-flowing-glass-fixed-time",
  label: "4K flowing glass visual reference",
  description: "Fixed-time flowing glass frame for before/after shader visual comparisons.",
  kind: "image",
  sourceSize: { width: 3840, height: 2160 },
  shaderType: ShaderType.glass,
  params: {
    size: 40,
    intensity: 4,
    scale: 1.55,
    glass: {
      kind: GlassKind.flowing,
      angle: 0,
      caustic: 1,
      frostiness: 0.8,
      highlight: 0.1,
      dispersion: 0.6,
      flow: 0.5,
    },
    postProcess: { enabled: false },
    adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
    time: FLOWING_GLASS_VISUAL_TIME,
    timeAutoPlay: false,
  },
  dirtyMode: "none",
  frames: 1,
  warmupFrames: 0,
  samples: 1,
};

const canvas = queryRequired<HTMLCanvasElement>("#bench-canvas");
const runAllButton = queryRequired<HTMLButtonElement>("#run-all");
const runManyButton = queryRequired<HTMLButtonElement>("#run-many");
const scenarioList = queryRequired<HTMLDivElement>("#scenario-list");
const resultsEl = queryRequired<HTMLPreElement>("#results");

canvas.style.width = `${CANVAS_WIDTH}px`;
canvas.style.height = `${CANVAS_HEIGHT}px`;

let renderer: InfiniteCanvasRenderer | null = null;
const gpuErrors: string[] = [];

function writeResults(value: string): void {
  resultsEl.textContent = value;
}

function markComplete(results: readonly BenchResult[]): void {
  document.documentElement.dataset.benchComplete = "1";
  document.documentElement.dataset.benchResultCount = String(results.length);
}

function markVisualComplete(result: VisualCaptureResult): void {
  document.documentElement.dataset.benchVisualComplete = "1";
  document.documentElement.dataset.benchVisualId = result.id;
}

function queryRequired<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Benchmark DOM is missing ${selector}`);
  return element;
}

async function getRenderer(): Promise<InfiniteCanvasRenderer> {
  if (renderer) return renderer;
  renderer = new InfiniteCanvasRenderer(canvas);
  await renderer.initialize();
  renderer.device?.addEventListener("uncapturederror", (event) => {
    const gpuError = (event as GPUUncapturedErrorEvent).error;
    gpuErrors.push(`${gpuError.constructor.name}: ${gpuError.message}`);
  });
  return renderer;
}

async function collectBenchMetadata(): Promise<BenchMetadata> {
  const gpu = navigator.gpu;
  const adapter = gpu ? await navigator.gpu.requestAdapter() : null;
  const wgslLanguageFeatures = gpu?.wgslLanguageFeatures
    ? [...gpu.wgslLanguageFeatures.values()].sort()
    : [];

  return {
    createdAt: new Date().toISOString(),
    location: window.location.href,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio: window.devicePixelRatio,
    webgpu: {
      available: !!gpu,
      wgslLanguageFeatures,
      immediatesSupported: wgslLanguageFeatures.includes("immediate_address_space"),
      adapterInfo: adapter ? serializeAdapterInfo(adapter) : null,
      limits: adapter ? serializeLimits(adapter.limits) : {},
      features: adapter ? [...adapter.features.values()].sort() : [],
    },
  };
}

function serializeAdapterInfo(adapter: GPUAdapter): Record<string, unknown> {
  const maybeInfo = (adapter as GPUAdapter & { info?: Record<string, unknown> }).info;
  if (!maybeInfo) return {};
  return Object.fromEntries(
    Object.entries(maybeInfo).filter(([, value]) => value !== undefined && value !== ""),
  );
}

function serializeLimits(limits: GPUSupportedLimits): Record<string, number> {
  const names = [
    "maxTextureDimension1D",
    "maxTextureDimension2D",
    "maxTextureDimension3D",
    "maxTextureArrayLayers",
    "maxBindGroups",
    "maxBindGroupsPlusVertexBuffers",
    "maxBindingsPerBindGroup",
    "maxDynamicUniformBuffersPerPipelineLayout",
    "maxDynamicStorageBuffersPerPipelineLayout",
    "maxSampledTexturesPerShaderStage",
    "maxSamplersPerShaderStage",
    "maxStorageBuffersPerShaderStage",
    "maxStorageTexturesPerShaderStage",
    "maxUniformBuffersPerShaderStage",
    "maxUniformBufferBindingSize",
    "maxStorageBufferBindingSize",
    "minUniformBufferOffsetAlignment",
    "minStorageBufferOffsetAlignment",
    "maxVertexBuffers",
    "maxBufferSize",
    "maxImmediateSize",
  ];
  const record = limits as unknown as Record<string, number | undefined>;
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = record[name];
      return typeof value === "number" ? [[name, value]] : [];
    }),
  );
}

async function createSyntheticBitmap(size: Size, seed: number): Promise<ImageBitmap> {
  const offscreen = new OffscreenCanvas(size.width, size.height);
  const ctx = offscreen.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("Could not create synthetic image context");

  const gradient = ctx.createLinearGradient(0, 0, size.width, size.height);
  gradient.addColorStop(0, `hsl(${(seed * 47) % 360} 85% 56%)`);
  gradient.addColorStop(0.45, `hsl(${(seed * 47 + 120) % 360} 74% 48%)`);
  gradient.addColorStop(1, `hsl(${(seed * 47 + 240) % 360} 88% 62%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size.width, size.height);

  ctx.globalCompositeOperation = "overlay";
  for (let index = 0; index < 90; index += 1) {
    const x = pseudoRandom(seed, index * 4) * size.width;
    const y = pseudoRandom(seed, index * 4 + 1) * size.height;
    const radius =
      (0.035 + pseudoRandom(seed, index * 4 + 2) * 0.12) * Math.min(size.width, size.height);
    ctx.fillStyle = `hsla(${Math.floor(pseudoRandom(seed, index * 4 + 3) * 360)} 80% 55% / 0.38)`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "rgb(255 255 255 / 0.18)";
  const stripeWidth = Math.max(16, Math.floor(size.width / 96));
  for (let x = -size.height; x < size.width; x += stripeWidth * 3) {
    ctx.save();
    ctx.translate(x, 0);
    ctx.rotate(-Math.PI / 9);
    ctx.fillRect(0, 0, stripeWidth, size.height * 2);
    ctx.restore();
  }

  return createImageBitmap(offscreen);
}

function pseudoRandom(seed: number, index: number): number {
  const x = Math.sin(seed * 1009 + index * 9176.123) * 43758.5453123;
  return x - Math.floor(x);
}

async function createSyntheticVideo(
  size: Size,
  seed = 1,
): Promise<{
  video: HTMLVideoElement;
  drawFrame: (frameIndex: number) => void;
  cleanup: () => void;
}> {
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = size.width;
  sourceCanvas.height = size.height;
  const ctx = sourceCanvas.getContext("2d");
  if (!ctx) throw new Error("Could not create synthetic video context");

  const stream = sourceCanvas.captureStream(30);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    video.pause();
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  const drawFrame = (frameIndex: number): void => {
    const t = frameIndex / 30;
    ctx.fillStyle = `hsl(${(t * 52 + seed * 37) % 360} 70% 15%)`;
    ctx.fillRect(0, 0, size.width, size.height);

    const gradient = ctx.createRadialGradient(
      size.width * (0.5 + Math.sin(t + seed * 0.31) * 0.25),
      size.height * (0.5 + Math.cos(t * 1.3 + seed * 0.17) * 0.25),
      size.width * 0.05,
      size.width * 0.5,
      size.height * 0.5,
      size.width * 0.7,
    );
    gradient.addColorStop(0, "rgb(255 255 255)");
    gradient.addColorStop(0.35, `hsl(${(t * 90 + seed * 41 + 80) % 360} 90% 60%)`);
    gradient.addColorStop(1, `hsl(${(t * 90 + seed * 41 + 220) % 360} 80% 35%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size.width, size.height);

    ctx.fillStyle = "rgb(0 0 0 / 0.25)";
    const block = Math.max(24, Math.floor(size.width / 48));
    for (let x = 0; x < size.width; x += block * 2) {
      ctx.fillRect((x + frameIndex * 7 + seed * 13) % size.width, 0, block, size.height);
    }
  };

  try {
    drawFrame(0);
    await video.play();
    await waitForVideoMetadata(video);
  } catch (error) {
    cleanup();
    throw error;
  }

  return {
    video,
    drawFrame,
    cleanup,
  };
}

async function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };
    const onLoaded = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Synthetic video failed to load metadata"));
    };
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

async function createEntities(scenario: BenchScenario): Promise<BenchEntitySet> {
  const params = resolveBenchShaderParams(scenario.params);

  if (scenario.kind === "video") {
    const synthetic = await createSyntheticVideo(scenario.sourceSize);
    let bitmap: ImageBitmap | undefined;
    let entity: ShaderCanvasEntity | undefined;
    try {
      bitmap = await createImageBitmap(synthetic.video);
      entity = createEntity({
        id: scenario.id,
        name: scenario.label,
        bitmap,
        size: scenario.sourceSize,
        shaderType: scenario.shaderType,
        params,
        mediaSource: {
          type: MediaType.video,
          videoElement: synthetic.video,
          blob: new Blob([], { type: "video/mp4" }),
          duration: 60,
          fps: 30,
          hasAudio: false,
          alphaMode: "none",
        },
        playback: {
          isPlaying: true,
          currentTime: 0,
          loop: true,
          playbackRate: 1,
          muted: true,
          volume: 0,
        },
      });
      bitmap = undefined;
      const createdEntity = entity;
      return {
        entities: [createdEntity],
        beforeFrame: (frameIndex) => {
          synthetic.drawFrame(frameIndex);
          createdEntity.textureDirty = true;
        },
        cleanup: () => {
          disposeBenchCleanupActions(synthetic.cleanup, () =>
            disposeBenchEntities([createdEntity]),
          );
        },
      };
    } catch (error) {
      disposeBenchCleanupActions(
        synthetic.cleanup,
        () => bitmap?.close(),
        () => {
          if (entity) disposeBenchEntities([entity]);
        },
      );
      throw error;
    }
  }

  if (scenario.zoomStress) {
    return createZoomStressEntitySet(scenario, scenario.zoomStress, params);
  }

  if (scenario.manyEntity) {
    return createManyEntitySet(scenario, scenario.manyEntity, params);
  }

  const count = scenario.kind === "multi" ? (scenario.entityCount ?? 25) : 1;
  const assets = await createSyntheticImageAssets({
    count,
    blobType: "image/png",
    createBitmap: (index) => createSyntheticBitmap(scenario.sourceSize, index + 1),
  });
  const ownedAssets = [...assets];
  const entities: ShaderCanvasEntity[] = [];

  try {
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index]!;
      entities.push(
        createEntity({
          id: `${scenario.id}-${index}`,
          name: `${scenario.label} ${index + 1}`,
          asset,
          size: scenario.sourceSize,
          shaderType: scenario.shaderType,
          params,
          zIndex: index,
          position: getEntityPosition(index, count),
        }),
      );
    }
    releaseOwnedImageAssets(ownedAssets);

    return {
      entities,
      beforeFrame:
        scenario.dirtyMode === "texture"
          ? () => {
              for (const entity of entities) entity.textureDirty = true;
            }
          : undefined,
      cleanup: () => disposeBenchEntities(entities),
    };
  } catch (error) {
    disposeBenchCleanupActions(
      () => releaseOwnedImageAssets(ownedAssets),
      () => disposeBenchEntities(entities),
    );
    throw error;
  }
}

async function createZoomStressEntitySet(
  scenario: BenchScenario,
  config: ZoomStressScenarioConfig,
  params: ResolvedBenchShaderParams,
): Promise<BenchEntitySet> {
  const imageAssets = await createSyntheticImageAssets({
    count: config.imageCount,
    blobType: "image/jpeg",
    id: (index) => `${scenario.id}-image-asset-${index}`,
    createBitmap: (index) => createSyntheticThumbnailBitmap(config.imageSourceSize, index + 1),
  });
  const ownedImageAssets = [...imageAssets];
  let syntheticVideos: Array<Awaited<ReturnType<typeof createSyntheticVideo>>> = [];
  let videoBitmaps: Array<ImageBitmap | undefined> = [];
  const entities: ShaderCanvasEntity[] = [];

  try {
    syntheticVideos = await createSyntheticVideos(config.videoSourceSize, config.videoCount);
    videoBitmaps = await createSyntheticVideoBitmaps(syntheticVideos);

    let imageIndex = 0;
    let videoIndex = 0;
    for (let index = 0; index < config.entityCount; index += 1) {
      const sourceSize = getZoomStressSourceSize(config, index);
      const displaySize = getZoomStressDisplaySize(config, index);
      const position = getZoomStressPosition(config, index);
      if (getZoomStressMediaKind(config, index) === "video") {
        const synthetic = syntheticVideos[videoIndex]!;
        const bitmap = videoBitmaps[videoIndex]!;
        const entity = createEntity({
          id: `${scenario.id}-video-${index}`,
          name: `${scenario.label} video ${videoIndex + 1}`,
          bitmap,
          size: sourceSize,
          displaySize,
          shaderType: scenario.shaderType,
          params,
          mediaSource: {
            type: MediaType.video,
            videoElement: synthetic.video,
            blob: new Blob([], { type: "video/mp4" }),
            duration: 60,
            fps: 30,
            hasAudio: false,
            alphaMode: "none",
          },
          playback: {
            isPlaying: true,
            currentTime: 0,
            loop: true,
            playbackRate: 1,
            muted: true,
            volume: 0,
          },
          zIndex: index,
          position,
        });
        entities.push(entity);
        videoBitmaps[videoIndex] = undefined;
        videoIndex += 1;
        continue;
      }

      const asset = imageAssets[imageIndex]!;
      imageIndex += 1;
      entities.push(
        createEntity({
          id: `${scenario.id}-image-${index}`,
          name: `${scenario.label} image ${imageIndex}`,
          asset,
          size: sourceSize,
          displaySize,
          shaderType: scenario.shaderType,
          params,
          zIndex: index,
          position,
        }),
      );
    }

    if (imageIndex !== config.imageCount || videoIndex !== config.videoCount) {
      throw new Error(
        `Zoom stress media mix produced ${imageIndex} images and ${videoIndex} videos`,
      );
    }
    releaseOwnedImageAssets(ownedImageAssets);

    let lastSyntheticVideoFrameIndex = -1;
    return {
      entities,
      beforeFrame: () => {
        const videoFrameIndex = Math.floor((performance.now() * 30) / 1000);
        if (videoFrameIndex === lastSyntheticVideoFrameIndex) return;
        lastSyntheticVideoFrameIndex = videoFrameIndex;
        for (let index = 0; index < syntheticVideos.length; index += 1) {
          syntheticVideos[index]!.drawFrame(videoFrameIndex + index * 3);
        }
        for (const entity of entities) {
          if (entity.mediaSource.type === MediaType.video) entity.textureDirty = true;
        }
      },
      getViewport: (_frameIndex, sampleFrameIndex) =>
        getZoomStressFrame(config, sampleFrameIndex, {
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
        }).viewport,
      getFramePhase: (_frameIndex, sampleFrameIndex) =>
        getZoomStressFrame(config, sampleFrameIndex, {
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
        }).phase,
      decodedAssetEstimateBytes: estimateZoomStressDecodedBytes(config),
      mediaCounts: { image: config.imageCount, video: config.videoCount },
      cleanup: () => {
        disposeBenchCleanupActions(
          () => disposeBenchResources(syntheticVideos, (synthetic) => synthetic.cleanup()),
          () => disposeBenchEntities(entities),
        );
      },
    };
  } catch (error) {
    disposeBenchCleanupActions(
      () => releaseOwnedImageAssets(ownedImageAssets),
      () => disposeBenchResources(syntheticVideos, (synthetic) => synthetic.cleanup()),
      () => disposeRemainingBitmaps(videoBitmaps),
      () => disposeBenchEntities(entities),
    );
    throw error;
  }
}

async function createSyntheticVideos(
  size: Size,
  count: number,
): Promise<Array<Awaited<ReturnType<typeof createSyntheticVideo>>>> {
  return createBatchedBenchResources({
    count,
    batchSize: 4,
    create: (index) => createSyntheticVideo(size, index + 1),
    dispose: (synthetic) => synthetic.cleanup(),
  });
}

async function createManyEntitySet(
  scenario: BenchScenario,
  config: ManyEntityScenarioConfig,
  params: ResolvedBenchShaderParams,
): Promise<BenchEntitySet> {
  const bitmapCount = config.assetMode === "shared" ? 1 : config.uniqueAssetCount;
  const assets = await createSyntheticImageAssets({
    count: bitmapCount,
    blobType: "image/jpeg",
    id: (index) => `${scenario.id}-asset-${index}`,
    createBitmap: (index) => createSyntheticThumbnailBitmap(config.sourceSize, index + 1),
  });
  const ownedAssets = [...assets];
  const entities: ShaderCanvasEntity[] = [];

  try {
    for (let index = 0; index < config.entityCount; index += 1) {
      const asset = assets[index % assets.length]!;
      const mixedSegment = config.mixedStaticVariants
        ? Math.min(3, Math.floor((index * 4) / config.entityCount))
        : 0;
      const entityParams =
        config.mixedStaticVariants && mixedSegment % 2 === 1
          ? { ...params, showOriginal: true }
          : params;
      const entity = createEntity({
        id: `${scenario.id}-${index}`,
        name: `${scenario.label} ${index + 1}`,
        asset,
        size: scenario.sourceSize,
        displaySize: config.displaySize,
        shaderType: mixedSegment >= 2 ? ShaderType.ascii : scenario.shaderType,
        params: entityParams,
        zIndex: index,
        position: getManyEntityPosition({
          index,
          entityCount: config.entityCount,
          displaySize: config.displaySize,
          layout: config.layout,
          canvasSize: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
        }),
      });
      entities.push(entity);
    }
    releaseOwnedImageAssets(ownedAssets);

    return {
      entities,
      selectedEntityIds: createManyEntitySelection(config, entities),
      debugMode: config.debugMode,
      dragSelectedEntities: config.dragSelectedEntities,
      dragSelectEntities: config.dragSelectEntities,
      tweakSingleEntityParams: config.tweakSingleEntityParams,
      decodedAssetEstimateBytes: estimateDecodedAssetBytes(config),
      getViewportOffset: (frameIndex) =>
        getManyEntityViewportOffset(config, frameIndex, {
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
        }),
      getViewport: config.zoomRange
        ? (frameIndex) => {
            if (frameIndex < config.warmupFrames) {
              return { offset: { x: 0, y: 0 }, zoom: config.zoomRange!.min };
            }
            const cycleLength = Math.max(2, config.frames - 1);
            const gestureFrame = (frameIndex - config.warmupFrames) % config.frames;
            const cycleProgress = gestureFrame / cycleLength;
            const roundTripProgress = 1 - Math.abs(cycleProgress * 2 - 1);
            return {
              offset: { x: 0, y: 0 },
              zoom:
                config.zoomRange!.min +
                (config.zoomRange!.max - config.zoomRange!.min) * roundTripProgress,
            };
          }
        : config.zoom
          ? (frameIndex) => ({
              offset: getManyEntityViewportOffset(config, frameIndex, {
                width: CANVAS_WIDTH,
                height: CANVAS_HEIGHT,
              }),
              zoom: config.zoom!,
            })
          : undefined,
      cleanup: () => disposeBenchEntities(entities),
    };
  } catch (error) {
    disposeBenchCleanupActions(
      () => releaseOwnedImageAssets(ownedAssets),
      () => disposeBenchEntities(entities),
    );
    throw error;
  }
}

function createManyEntitySelection(
  config: ManyEntityScenarioConfig,
  entities: readonly ShaderCanvasEntity[],
): ReadonlySet<string> | undefined {
  if (config.tweakSingleEntityParams) {
    const target = entities[Math.floor(entities.length / 2)];
    return target ? new Set([target.id]) : undefined;
  }
  const selectedCount =
    config.selectedEntityCount ??
    (config.selectedEntityFraction === undefined
      ? undefined
      : Math.floor(entities.length * config.selectedEntityFraction));
  if (selectedCount === undefined) return undefined;
  return new Set(entities.slice(0, selectedCount).map((entity) => entity.id));
}

async function createSyntheticImageAssets(options: {
  count: number;
  blobType: string;
  id?: (index: number) => string;
  createBitmap: (index: number) => Promise<ImageBitmap>;
}): Promise<MediaImageAsset[]> {
  return createBatchedBenchResources({
    count: options.count,
    batchSize: 32,
    create: async (index) => {
      const bitmap = await options.createBitmap(index);
      try {
        return createImageAsset({
          id: options.id?.(index),
          imageBitmap: bitmap,
          blob: new Blob([], { type: options.blobType }),
        });
      } catch (error) {
        bitmap.close();
        throw error;
      }
    },
    dispose: releaseImageAsset,
  });
}

async function createSyntheticVideoBitmaps(
  syntheticVideos: readonly Awaited<ReturnType<typeof createSyntheticVideo>>[],
): Promise<Array<ImageBitmap | undefined>> {
  return createBatchedBenchResources({
    count: syntheticVideos.length,
    batchSize: 32,
    create: (index) => createImageBitmap(syntheticVideos[index]!.video),
    dispose: (bitmap) => bitmap.close(),
  });
}

function releaseOwnedImageAssets(assets: MediaImageAsset[]): void {
  while (assets.length > 0) releaseImageAsset(assets.pop()!);
}

function disposeRemainingBitmaps(bitmaps: readonly (ImageBitmap | undefined)[]): void {
  disposeBenchResources(
    bitmaps.filter((bitmap): bitmap is ImageBitmap => bitmap !== undefined),
    (bitmap) => bitmap.close(),
  );
}

/** Run cleanup actions in reverse ownership order and continue after individual failures. */
function disposeBenchCleanupActions(...actions: Array<() => void>): void {
  disposeBenchResources(actions, (cleanup) => cleanup());
}

async function createSyntheticThumbnailBitmap(size: Size, seed: number): Promise<ImageBitmap> {
  const offscreen = new OffscreenCanvas(size.width, size.height);
  const ctx = offscreen.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Could not create synthetic thumbnail context");

  ctx.fillStyle = `hsl(${(seed * 47) % 360} 72% 42%)`;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.fillStyle = `hsl(${(seed * 83 + 120) % 360} 82% 64%)`;
  const inset = Math.max(2, Math.round(Math.min(size.width, size.height) * 0.12));
  ctx.fillRect(inset, inset, size.width - inset * 2, size.height - inset * 2);
  ctx.fillStyle = `hsl(${(seed * 131 + 240) % 360} 76% 24%)`;
  const stripe = Math.max(2, Math.round(size.width * 0.08));
  ctx.fillRect((seed * 17) % Math.max(1, size.width - stripe), 0, stripe, size.height);

  return createImageBitmap(offscreen);
}

type CreateEntityOptions = {
  id: string;
  name: string;
  size: Size;
  displaySize?: Size;
  shaderType: ShaderType;
  params: ResolvedBenchShaderParams;
  zIndex?: number;
  position?: { x: number; y: number };
} & (
  | {
      asset: MediaImageAsset;
      bitmap?: never;
      mediaSource?: never;
      playback?: never;
    }
  | {
      asset?: never;
      bitmap: ImageBitmap;
      mediaSource: MediaSourceVideo;
      playback: PlaybackState;
    }
);

function createEntity(options: CreateEntityOptions): ShaderCanvasEntity {
  const displayScale =
    options.size.width > CANVAS_WIDTH || options.size.height > CANVAS_HEIGHT
      ? Math.min(
          (CANVAS_WIDTH * 0.78) / options.size.width,
          (CANVAS_HEIGHT * 0.78) / options.size.height,
        )
      : Math.min(1, (CANVAS_WIDTH * 0.22) / options.size.width);
  const displaySize = options.displaySize ?? {
    width: Math.max(1, Math.round(options.size.width * displayScale)),
    height: Math.max(1, Math.round(options.size.height * displayScale)),
  };
  const base = {
    id: options.id,
    name: options.name,
    position: options.position ?? {
      x: (CANVAS_WIDTH - displaySize.width) / 2,
      y: (CANVAS_HEIGHT - displaySize.height) / 2,
    },
    size: displaySize,
    zIndex: options.zIndex ?? 0,
    rotation: 0,
    originalSize: options.size,
    shaderType: options.shaderType,
    shaderParams: getBenchEntityShaderParams(
      options.params,
      options.shaderType === ShaderType.glass &&
        options.params.glass?.kind === GlassKind.flowing &&
        options.params.timeAutoPlay !== false,
    ),
    textureDirty: true,
    selected: false,
    locked: false,
    edited: false,
  };

  if (options.asset !== undefined) {
    const imageMedia = retainBenchImageMedia(options.asset);
    return { ...base, ...imageMedia };
  }

  return {
    ...base,
    imageBitmap: options.bitmap,
    mediaSource: options.mediaSource,
    playback: options.playback,
  };
}

function getEntityPosition(index: number, count: number): { x: number; y: number } {
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const cellWidth = CANVAS_WIDTH / columns;
  const cellHeight = CANVAS_HEIGHT / rows;
  return {
    x: (index % columns) * cellWidth + cellWidth * 0.14,
    y: Math.floor(index / columns) * cellHeight + cellHeight * 0.14,
  };
}

function createRenderState(
  entities: ShaderCanvasEntity[],
  dirty: boolean,
  viewport: Viewport = { offset: { x: 0, y: 0 }, zoom: 1 },
  selectedEntityIds: ReadonlySet<string> = new Set(),
  debugMode = false,
  dragSelectedEntities = false,
  dragSelectEntities = false,
): RenderState {
  const entitySpatialIndex = new EntitySpatialIndex();
  for (const entity of entities) entitySpatialIndex.upsert(entity);
  return {
    viewport,
    entities,
    entitySpatialIndex,
    entityVersion: 0,
    geometryVersion: 0,
    selectionVersion: selectedEntityIds.size > 0 ? 1 : 0,
    dirtyEntityIds: new Set(),
    selectedEntityIds,
    debugMode,
    debugView: "none",
    dirty,
    canvasCallouts: [],
    dragSelectBounds: dragSelectEntities ? { x: 0, y: 0, width: 0, height: 0 } : null,
    dragSelectMode: dragSelectEntities ? "replace" : null,
    multiSelectBounds: null,
    actionLayer: {
      active: false,
      entityIds: new Set(),
      entityOffset: { x: 0, y: 0 },
      blurIntensity: 0,
    },
    dragVisual: {
      active: dragSelectedEntities,
      isDragPhase: dragSelectedEntities,
      entityIds: dragSelectedEntities ? selectedEntityIds : new Set(),
      scale: 1,
      offset: { x: 0, y: 0 },
      appliesToSelection: dragSelectedEntities,
    },
    disintegration: { overlays: [] },
  };
}

async function runFrames(params: {
  renderer: InfiniteCanvasRenderer;
  entities: ShaderCanvasEntity[];
  frameCount: number;
  beforeFrame?: (frameIndex: number) => void;
  getViewportOffset?: (frameIndex: number) => { x: number; y: number };
  getViewport?: (frameIndex: number, sampleFrameIndex: number) => Viewport;
  getFramePhase?: (frameIndex: number, sampleFrameIndex: number) => ZoomStressPhase | null;
  startFrameIndex: number;
  synchronizeEachFrame?: boolean;
  paceWithAnimationFrame?: boolean;
  recordPerFrame?: boolean;
  selectedEntityIds?: ReadonlySet<string>;
  debugMode?: boolean;
  dragSelectedEntities?: boolean;
  dragSelectEntities?: boolean;
  tweakSingleEntityParams?: boolean;
}): Promise<{
  totalMs: number;
  cpuEncodeMs: number;
  queueDrainMs: number;
  peakResidentBytes: number;
  resources: BenchResourceStats;
  activity: BenchActivityMetrics;
  frameSamples: BenchFrameSample[];
  rafIntervalSamples: number[];
  sourceUpdateSamples: number[];
  cpuRenderSamples: number[];
  endToEndSamples: number[];
}> {
  const device = params.renderer.device;
  if (!device) throw new Error("Renderer device is unavailable");

  const start = performance.now();
  let cpuEncodeMs = 0;
  const resourcesBefore = params.renderer.getResourceStats();
  let resources = resourcesBefore;
  let peakResidentBytes = getTotalResidentBytes(resources);
  let renderedEntities = 0;
  let minRenderedEntitiesPerFrame = Infinity;
  let maxRenderedEntitiesPerFrame = 0;
  let previousResources = resourcesBefore;
  let previousRafTimestamp: number | null = null;
  const frameSamples: BenchFrameSample[] = [];
  const rafIntervalSamples: number[] = [];
  const sourceUpdateSamples: number[] = [];
  const cpuRenderSamples: number[] = [];
  const endToEndSamples: number[] = [];
  const renderState = createRenderState(
    params.entities,
    true,
    { offset: { x: 0, y: 0 }, zoom: 1 },
    params.selectedEntityIds,
    params.debugMode,
    params.dragSelectedEntities,
    params.dragSelectEntities,
  );
  const parameterTargetIndex = params.tweakSingleEntityParams
    ? Math.floor(params.entities.length / 2)
    : -1;
  const dirtyEntityIds = new Set<string>();

  for (let index = 0; index < params.frameCount; index += 1) {
    const frameIndex = params.startFrameIndex + index;
    const rafTimestamp = params.paceWithAnimationFrame ? await nextAnimationFrame() : null;
    const rafIntervalMs =
      rafTimestamp !== null && previousRafTimestamp !== null
        ? rafTimestamp - previousRafTimestamp
        : null;
    if (rafIntervalMs !== null) rafIntervalSamples.push(rafIntervalMs);
    previousRafTimestamp = rafTimestamp;
    const sourceUpdateStart = performance.now();
    params.beforeFrame?.(frameIndex);
    if (parameterTargetIndex >= 0) {
      const previous = params.entities[parameterTargetIndex]!;
      const shaderParams = { ...previous.shaderParams, size: 1 + (frameIndex % 24) * 0.125 };
      const next = { ...previous, shaderParams, textureDirty: true };
      params.entities[parameterTargetIndex] = next;
      dirtyEntityIds.clear();
      dirtyEntityIds.add(next.id);
      renderState.entityVersion++;
      renderState.selectionVersion++;
      renderState.dirtyEntityIds = dirtyEntityIds;
    }
    const sourceUpdateMs = performance.now() - sourceUpdateStart;
    sourceUpdateSamples.push(sourceUpdateMs);
    const viewport =
      params.getViewport?.(frameIndex, index) ??
      ({
        offset: params.getViewportOffset?.(frameIndex) ?? { x: 0, y: 0 },
        zoom: 1,
      } satisfies Viewport);
    const frameStart = performance.now();
    const cpuStart = performance.now();
    renderState.viewport = viewport;
    if (params.dragSelectedEntities) {
      renderState.dragVisual.offset.x = index * 16;
      renderState.dragVisual.offset.y = index * -8;
    }
    if (params.dragSelectEntities && renderState.dragSelectBounds) {
      renderState.dragSelectBounds.width = (index + 1) * 180;
      renderState.dragSelectBounds.height = (index + 1) * 120;
    }
    params.renderer.render(renderState);
    const cpuEnd = performance.now();
    cpuEncodeMs += cpuEnd - cpuStart;
    const frameStats = params.renderer.getFrameStats();
    cpuRenderSamples.push(frameStats.renderTime);
    if (params.synchronizeEachFrame) await device.queue.onSubmittedWorkDone();
    const frameEnd = performance.now();
    const endToEndMs = params.synchronizeEachFrame ? frameEnd - frameStart : null;
    if (endToEndMs !== null) endToEndSamples.push(endToEndMs);

    const frameRenderedCount = frameStats.renderedCount;
    renderedEntities += frameRenderedCount;
    minRenderedEntitiesPerFrame = Math.min(minRenderedEntitiesPerFrame, frameRenderedCount);
    maxRenderedEntitiesPerFrame = Math.max(maxRenderedEntitiesPerFrame, frameRenderedCount);
    resources = params.renderer.getResourceStats();
    peakResidentBytes = Math.max(peakResidentBytes, getTotalResidentBytes(resources));
    if (params.recordPerFrame) {
      frameSamples.push({
        index,
        frameIndex,
        phase: params.getFramePhase?.(frameIndex, index) ?? null,
        zoom: viewport.zoom,
        rafIntervalMs,
        sourceUpdateMs,
        cpuCallMs: cpuEnd - cpuStart,
        cpuRenderMs: frameStats.renderTime,
        renderPhases: frameStats.phases ? { ...frameStats.phases } : null,
        queueWaitMs: params.synchronizeEachFrame ? frameEnd - cpuEnd : null,
        endToEndMs,
        renderedEntities: frameRenderedCount,
        residentBytes: getTotalResidentBytes(resources),
        sourceBytes: resources.entityTextures.sourceBytes,
        processedBytes: resources.entityTextures.processedBytes,
        sourceTextureCount: resources.entityTextures.sourceTextureCount,
        processedTextureCount: resources.entityTextures.processedTextureCount,
        sourceTextureAllocations:
          resources.entityTextures.sourceTextureAllocations -
          previousResources.entityTextures.sourceTextureAllocations,
        processedTextureAllocations:
          resources.entityTextures.processedTextureAllocations -
          previousResources.entityTextures.processedTextureAllocations,
        sourceUploads:
          resources.entityTextures.sourceUploads - previousResources.entityTextures.sourceUploads,
        evictions: resources.entityTextures.evictions - previousResources.entityTextures.evictions,
      });
    }
    previousResources = resources;
  }

  const beforeDrain = performance.now();
  await device.queue.onSubmittedWorkDone();
  const end = performance.now();
  if (gpuErrors.length > 0) {
    throw new Error(`WebGPU errors during render bench:\n${gpuErrors.join("\n")}`);
  }

  return {
    totalMs: end - start,
    cpuEncodeMs,
    queueDrainMs: end - beforeDrain,
    peakResidentBytes,
    resources,
    frameSamples,
    rafIntervalSamples,
    sourceUpdateSamples,
    cpuRenderSamples,
    endToEndSamples,
    activity: {
      renderedEntities,
      renderedEntitiesPerFrame: params.frameCount === 0 ? 0 : renderedEntities / params.frameCount,
      minRenderedEntitiesPerFrame:
        minRenderedEntitiesPerFrame === Infinity ? 0 : minRenderedEntitiesPerFrame,
      maxRenderedEntitiesPerFrame,
      sourceTextureAllocations:
        resources.entityTextures.sourceTextureAllocations -
        resourcesBefore.entityTextures.sourceTextureAllocations,
      processedTextureAllocations:
        resources.entityTextures.processedTextureAllocations -
        resourcesBefore.entityTextures.processedTextureAllocations,
      sourceUploads:
        resources.entityTextures.sourceUploads - resourcesBefore.entityTextures.sourceUploads,
      evictions: resources.entityTextures.evictions - resourcesBefore.entityTextures.evictions,
      fullSceneBatchRebuilds:
        resources.composition.fullSceneBatchRebuilds -
        resourcesBefore.composition.fullSceneBatchRebuilds,
      fullSceneBatchUploadBytes:
        resources.composition.fullSceneBatchUploadBytes -
        resourcesBefore.composition.fullSceneBatchUploadBytes,
      normalInstanceUploadBytes:
        resources.composition.normalInstanceUploadBytes -
        resourcesBefore.composition.normalInstanceUploadBytes,
    },
  };
}

async function nextAnimationFrame(): Promise<number> {
  return await new Promise<number>((resolve) => requestAnimationFrame(resolve));
}

function getTotalResidentBytes(resources: BenchResourceStats): number {
  return (
    resources.entityTextures.residentBytes +
    resources.processingTextures.residentBytes +
    resources.texturePool.residentBytes
  );
}

async function runScenario(scenario: BenchScenario): Promise<BenchResult> {
  const benchRenderer = await getRenderer();
  const scenarioResourcesBefore = benchRenderer.getResourceStats();
  const entitySet = await createEntities(scenario);
  let frameIndex = 0;
  gpuErrors.length = 0;

  try {
    writeResults(`Running ${scenario.label}\n\nWarming up...`);
    const warmupResult = await runFrames({
      renderer: benchRenderer,
      entities: entitySet.entities,
      frameCount: scenario.warmupFrames,
      beforeFrame: entitySet.beforeFrame,
      getViewportOffset: entitySet.getViewportOffset,
      getViewport: entitySet.getViewport,
      getFramePhase: entitySet.getFramePhase,
      startFrameIndex: frameIndex,
      synchronizeEachFrame: scenario.synchronizeEachFrame,
      paceWithAnimationFrame: scenario.paceWithAnimationFrame,
      selectedEntityIds: entitySet.selectedEntityIds,
      debugMode: entitySet.debugMode,
      dragSelectedEntities: entitySet.dragSelectedEntities,
      dragSelectEntities: entitySet.dragSelectEntities,
    });
    frameIndex += scenario.warmupFrames;

    const samples: number[] = [];
    const cpuSamples: number[] = [];
    const queueDrainSamples: number[] = [];
    const rafIntervalFrameSamples: number[] = [];
    const sourceUpdateFrameSamples: number[] = [];
    const cpuRenderFrameSamples: number[] = [];
    const endToEndFrameSamples: number[] = [];
    const sampleDetails: BenchSample[] = [];
    for (let sample = 0; sample < scenario.samples; sample += 1) {
      writeResults(`Running ${scenario.label}\n\nSample ${sample + 1} of ${scenario.samples}...`);
      if (scenario.resetTexturesBeforeSample) {
        await benchRenderer.waitForGPU();
        for (const entity of entitySet.entities) {
          benchRenderer.removeEntityTexture(entity.id);
          entity.textureDirty = true;
        }
      }
      const startFrameIndex = frameIndex;
      const result = await runFrames({
        renderer: benchRenderer,
        entities: entitySet.entities,
        frameCount: scenario.frames,
        beforeFrame: entitySet.beforeFrame,
        getViewportOffset: entitySet.getViewportOffset,
        getViewport: entitySet.getViewport,
        getFramePhase: entitySet.getFramePhase,
        startFrameIndex: frameIndex,
        synchronizeEachFrame: scenario.synchronizeEachFrame,
        paceWithAnimationFrame: scenario.paceWithAnimationFrame,
        recordPerFrame: scenario.recordPerFrame,
        selectedEntityIds: entitySet.selectedEntityIds,
        debugMode: entitySet.debugMode,
        dragSelectedEntities: entitySet.dragSelectedEntities,
        dragSelectEntities: entitySet.dragSelectEntities,
        tweakSingleEntityParams: entitySet.tweakSingleEntityParams,
      });
      frameIndex += scenario.frames;
      samples.push(result.totalMs);
      cpuSamples.push(result.cpuEncodeMs);
      queueDrainSamples.push(result.queueDrainMs);
      rafIntervalFrameSamples.push(...result.rafIntervalSamples);
      sourceUpdateFrameSamples.push(...result.sourceUpdateSamples);
      cpuRenderFrameSamples.push(...result.cpuRenderSamples);
      endToEndFrameSamples.push(...result.endToEndSamples);
      sampleDetails.push({
        index: sample,
        frames: scenario.frames,
        startFrameIndex,
        totalMs: result.totalMs,
        cpuEncodeMs: result.cpuEncodeMs,
        queueDrainMs: result.queueDrainMs,
        msPerFrame: result.totalMs / scenario.frames,
        cpuEncodeMsPerFrame: result.cpuEncodeMs / scenario.frames,
        queueDrainMsPerFrame: result.queueDrainMs / scenario.frames,
        peakResidentBytes: result.peakResidentBytes,
        resources: result.resources,
        activity: result.activity,
        frameSamples: result.frameSamples,
        sourceUpdateMedianMs: median(result.sourceUpdateSamples),
        sourceUpdateP95Ms: percentile(result.sourceUpdateSamples, 0.95),
        sourceUpdateMaxMs: max(result.sourceUpdateSamples),
        rafIntervalMedianMs: median(result.rafIntervalSamples),
        rafIntervalP95Ms: percentile(result.rafIntervalSamples, 0.95),
        rafIntervalMaxMs: max(result.rafIntervalSamples),
        cpuRenderMedianMs: median(result.cpuRenderSamples),
        cpuRenderP95Ms: percentile(result.cpuRenderSamples, 0.95),
        cpuRenderMaxMs: max(result.cpuRenderSamples),
        endToEndMedianMs: median(result.endToEndSamples),
        endToEndP95Ms: percentile(result.endToEndSamples, 0.95),
        endToEndMaxMs: max(result.endToEndSamples),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const latestSample = sampleDetails.at(-1);
    if (!latestSample) throw new Error(`Benchmark scenario ${scenario.id} produced no samples`);
    return {
      id: scenario.id,
      label: scenario.label,
      description: scenario.description,
      shaderType: scenario.shaderType,
      dirtyMode: scenario.dirtyMode,
      sourceSize: scenario.sourceSize,
      entityCount: entitySet.entities.length,
      frames: scenario.frames,
      warmupFrames: scenario.warmupFrames,
      sampleCount: scenario.samples,
      samples,
      sampleDetails,
      medianMs: median(samples),
      p95Ms: percentile(samples, 0.95),
      msPerFrame: median(samples) / scenario.frames,
      cpuEncodeMedianMs: median(cpuSamples),
      queueDrainMedianMs: median(queueDrainSamples),
      cpuEncodeMsPerFrame: median(cpuSamples) / scenario.frames,
      queueDrainMsPerFrame: median(queueDrainSamples) / scenario.frames,
      timingMode: scenario.paceWithAnimationFrame
        ? "raf-paced"
        : scenario.synchronizeEachFrame
          ? "gpu-synchronized"
          : "batched",
      sourceUpdateMedianMs: median(sourceUpdateFrameSamples),
      sourceUpdateP95Ms: percentile(sourceUpdateFrameSamples, 0.95),
      sourceUpdateMaxMs: max(sourceUpdateFrameSamples),
      rafIntervalMedianMs: median(rafIntervalFrameSamples),
      rafIntervalP95Ms: percentile(rafIntervalFrameSamples, 0.95),
      rafIntervalMaxMs: max(rafIntervalFrameSamples),
      cpuRenderMedianMs: median(cpuRenderFrameSamples),
      cpuRenderP95Ms: percentile(cpuRenderFrameSamples, 0.95),
      cpuRenderMaxMs: max(cpuRenderFrameSamples),
      endToEndMedianMs: median(endToEndFrameSamples),
      endToEndP95Ms: percentile(endToEndFrameSamples, 0.95),
      endToEndMaxMs: max(endToEndFrameSamples),
      decodedAssetEstimateBytes:
        entitySet.decodedAssetEstimateBytes ??
        entitySet.entities.length * scenario.sourceSize.width * scenario.sourceSize.height * 4,
      peakResidentBytes: Math.max(
        warmupResult.peakResidentBytes,
        ...sampleDetails.map((sample) => sample.peakResidentBytes),
      ),
      resources: latestSample.resources,
      mediaCounts: entitySet.mediaCounts,
      activity: {
        ...medianActivity(sampleDetails.map((sample) => sample.activity)),
        ...getResourceCounterDelta(scenarioResourcesBefore, latestSample.resources),
      },
    };
  } finally {
    try {
      for (const entity of entitySet.entities) {
        benchRenderer.removeEntityTexture(entity.id);
      }
    } finally {
      entitySet.cleanup?.();
    }
  }
}

function getResourceCounterDelta(
  before: BenchResourceStats,
  after: BenchResourceStats,
): Pick<
  BenchActivityMetrics,
  | "sourceTextureAllocations"
  | "processedTextureAllocations"
  | "sourceUploads"
  | "evictions"
  | "fullSceneBatchRebuilds"
  | "fullSceneBatchUploadBytes"
  | "normalInstanceUploadBytes"
> {
  return {
    sourceTextureAllocations:
      after.entityTextures.sourceTextureAllocations -
      before.entityTextures.sourceTextureAllocations,
    processedTextureAllocations:
      after.entityTextures.processedTextureAllocations -
      before.entityTextures.processedTextureAllocations,
    sourceUploads: after.entityTextures.sourceUploads - before.entityTextures.sourceUploads,
    evictions: after.entityTextures.evictions - before.entityTextures.evictions,
    fullSceneBatchRebuilds:
      after.composition.fullSceneBatchRebuilds - before.composition.fullSceneBatchRebuilds,
    fullSceneBatchUploadBytes:
      after.composition.fullSceneBatchUploadBytes - before.composition.fullSceneBatchUploadBytes,
    normalInstanceUploadBytes:
      after.composition.normalInstanceUploadBytes - before.composition.normalInstanceUploadBytes,
  };
}

function medianActivity(samples: readonly BenchActivityMetrics[]): BenchActivityMetrics {
  const medianField = (key: keyof BenchActivityMetrics): number =>
    median(samples.map((sample) => sample[key]));
  return {
    renderedEntities: medianField("renderedEntities"),
    renderedEntitiesPerFrame: medianField("renderedEntitiesPerFrame"),
    minRenderedEntitiesPerFrame: medianField("minRenderedEntitiesPerFrame"),
    maxRenderedEntitiesPerFrame: medianField("maxRenderedEntitiesPerFrame"),
    sourceTextureAllocations: medianField("sourceTextureAllocations"),
    processedTextureAllocations: medianField("processedTextureAllocations"),
    sourceUploads: medianField("sourceUploads"),
    evictions: medianField("evictions"),
    fullSceneBatchRebuilds: medianField("fullSceneBatchRebuilds"),
    fullSceneBatchUploadBytes: medianField("fullSceneBatchUploadBytes"),
    normalInstanceUploadBytes: medianField("normalInstanceUploadBytes"),
  };
}

function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

function max(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index]!;
}

async function runScenarioSuite(
  suiteScenarios: readonly BenchScenario[],
  button: HTMLButtonElement,
): Promise<BenchResult[]> {
  button.disabled = true;
  delete document.documentElement.dataset.benchComplete;
  delete document.documentElement.dataset.benchResultCount;
  const results: BenchResult[] = [];
  try {
    for (const scenario of suiteScenarios) {
      const result = await runScenario(scenario);
      results.push(result);
      window.__voidmeshBenchResults = results;
      writeResults(formatResults(results));
      console.table(
        results.map((item) => ({
          id: item.id,
          "ms/frame": item.msPerFrame.toFixed(3),
          "median batch": item.medianMs.toFixed(2),
          "cpu encode": item.cpuEncodeMedianMs.toFixed(2),
          "queue drain": item.queueDrainMedianMs.toFixed(2),
        })),
      );
    }
    writeResults(formatResults(results));
    markComplete(results);
    console.log("[voidmesh-render-bench]", JSON.stringify(results, null, 2));
    return results;
  } finally {
    button.disabled = false;
  }
}

async function runAll(): Promise<BenchResult[]> {
  return runScenarioSuite(scenarios, runAllButton);
}

async function runManyEntitySuite(): Promise<BenchResult[]> {
  return runScenarioSuite(manyEntityScenarios, runManyButton);
}

async function runScenarioById(scenarioId: string): Promise<BenchResult> {
  const scenario = allScenarios.find((item) => item.id === scenarioId);
  if (!scenario) throw new Error(`Unknown render benchmark scenario: ${scenarioId}`);
  const result = await runScenario(scenario);
  window.__voidmeshBenchResults = [result];
  writeResults(formatResults([result]));
  markComplete([result]);
  console.log("[voidmesh-render-bench-scenario]", JSON.stringify(result, null, 2));
  return result;
}

async function captureBlobMetrics(blob: Blob): Promise<VisualMetrics> {
  const bitmap = await createImageBitmap(blob);
  const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = offscreen.getContext("2d", { alpha: true });
  if (!ctx) {
    bitmap.close();
    throw new Error("Could not create visual metric context");
  }

  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const pixels = ctx.getImageData(0, 0, offscreen.width, offscreen.height).data;
  let hash = 2166136261 >>> 0;
  let channelSum = 0;
  let nonTransparentPixels = 0;

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index]!;
    const green = pixels[index + 1]!;
    const blue = pixels[index + 2]!;
    const alpha = pixels[index + 3]!;

    hash ^= red;
    hash = Math.imul(hash, 16777619) >>> 0;
    hash ^= green;
    hash = Math.imul(hash, 16777619) >>> 0;
    hash ^= blue;
    hash = Math.imul(hash, 16777619) >>> 0;
    hash ^= alpha;
    hash = Math.imul(hash, 16777619) >>> 0;

    channelSum += red + green + blue + alpha;
    if (alpha > 0) nonTransparentPixels += 1;
  }

  return {
    width: offscreen.width,
    height: offscreen.height,
    fnv1a32: hash.toString(16).padStart(8, "0"),
    meanChannel: channelSum / pixels.length,
    nonTransparentRatio: nonTransparentPixels / (pixels.length / 4),
  };
}

async function captureFlowingGlassVisual(): Promise<VisualCaptureResult> {
  const benchRenderer = await getRenderer();
  const entitySet = await createEntities(flowingGlassVisualScenario);

  try {
    const device = benchRenderer.device;
    if (!device) throw new Error("Renderer device is unavailable");
    benchRenderer.render(createRenderState(entitySet.entities, true));
    await device.queue.onSubmittedWorkDone();
    const blob = await benchRenderer.renderEntityToBlob(entitySet.entities[0]!, {
      format: "png",
      quality: 1,
    });
    if (!blob) throw new Error("Could not export visual reference texture");

    const result: VisualCaptureResult = {
      id: flowingGlassVisualScenario.id,
      label: flowingGlassVisualScenario.label,
      sourceSize: flowingGlassVisualScenario.sourceSize,
      time: FLOWING_GLASS_VISUAL_TIME,
      shaderType: ShaderType.glass,
      shaderKind: GlassKind.flowing,
      metrics: await captureBlobMetrics(blob),
    };
    window.__voidmeshBenchVisual = result;
    writeResults(JSON.stringify(result, null, 2));
    markVisualComplete(result);
    console.log("[voidmesh-render-visual]", JSON.stringify(result, null, 2));
    return result;
  } finally {
    try {
      for (const entity of entitySet.entities) {
        benchRenderer.removeEntityTexture(entity.id);
      }
    } finally {
      entitySet.cleanup?.();
    }
  }
}

function formatResults(results: readonly BenchResult[]): string {
  return JSON.stringify(results, null, 2);
}

function renderScenarioList(): void {
  scenarioList.textContent = "";
  for (const scenario of allScenarios) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scenario-button";
    button.innerHTML = `<strong>${scenario.label}</strong><span>${scenario.description}</span>`;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const result = await runScenario(scenario);
        window.__voidmeshBenchResults = [result];
        writeResults(formatResults([result]));
        markComplete([result]);
      } finally {
        button.disabled = false;
      }
    });
    scenarioList.append(button);
  }
}

renderScenarioList();
runAllButton.addEventListener("click", () => {
  void runAll();
});
runManyButton.addEventListener("click", () => {
  void runManyEntitySuite();
});
window.__runVoidmeshRenderBench = runAll;
window.__runVoidmeshManyEntityBench = runManyEntitySuite;
window.__runVoidmeshRenderBenchScenario = runScenarioById;
window.__captureVoidmeshRenderBenchVisual = captureFlowingGlassVisual;
window.__collectVoidmeshRenderBenchMetadata = collectBenchMetadata;

const searchParams = new URLSearchParams(window.location.search);
const scenarioId = searchParams.get("scenario");
if (searchParams.get("visual") === "flowing-glass") {
  void captureFlowingGlassVisual();
} else if (scenarioId) {
  void runScenarioById(scenarioId);
} else if (searchParams.get("suite") === "many-entity") {
  void runManyEntitySuite();
} else if (searchParams.get("autorun") === "1") {
  void runAll();
}
