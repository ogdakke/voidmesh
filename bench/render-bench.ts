import { config } from "#config";
import { InfiniteCanvasRenderer } from "#renderer/canvas-renderer.ts";
import {
  DitheringKind,
  GlassKind,
  GlitchKind,
  MediaType,
  ShaderType,
  Shape,
  type ShaderCanvasEntity,
  type ShaderParams,
  type Size,
} from "#types/canvas.ts";
import type { RenderState } from "../engine/canvas-store.ts";

import "../styles/reset.css";

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
  beforeFrame?: (frameIndex: number) => void;
  cleanup?: () => void;
}

declare global {
  interface Window {
    __voidmeshBenchResults?: BenchResult[];
    __voidmeshBenchVisual?: VisualCaptureResult;
    __captureVoidmeshRenderBenchVisual?: () => Promise<VisualCaptureResult>;
    __runVoidmeshRenderBenchScenario?: (scenarioId: string) => Promise<BenchResult>;
    __runVoidmeshRenderBench?: () => Promise<BenchResult[]>;
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
];

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

function cloneParams(overrides: Partial<ShaderParams>): ShaderParams {
  return deepMergeShaderParams(structuredClone(config.defaults.shaderParams), overrides);
}

function queryRequired<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Benchmark DOM is missing ${selector}`);
  return element;
}

function deepMergeShaderParams(base: ShaderParams, overrides: Partial<ShaderParams>): ShaderParams {
  deepMergeRecord(base as unknown as Record<string, unknown>, overrides as Record<string, unknown>);
  return base;
}

function deepMergeRecord(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof base[key] === "object" &&
      base[key] !== null &&
      !Array.isArray(base[key])
    ) {
      deepMergeRecord(base[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      base[key] = value;
    }
  }
  return base;
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
  const gpu = navigator.gpu as
    | (GPU & {
        wgslLanguageFeatures?: Set<string>;
      })
    | undefined;
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

async function createSyntheticVideo(size: Size): Promise<{
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

  const drawFrame = (frameIndex: number): void => {
    const t = frameIndex / 30;
    ctx.fillStyle = `hsl(${(t * 52) % 360} 70% 15%)`;
    ctx.fillRect(0, 0, size.width, size.height);

    const gradient = ctx.createRadialGradient(
      size.width * (0.5 + Math.sin(t) * 0.25),
      size.height * (0.5 + Math.cos(t * 1.3) * 0.25),
      size.width * 0.05,
      size.width * 0.5,
      size.height * 0.5,
      size.width * 0.7,
    );
    gradient.addColorStop(0, "rgb(255 255 255)");
    gradient.addColorStop(0.35, `hsl(${(t * 90 + 80) % 360} 90% 60%)`);
    gradient.addColorStop(1, `hsl(${(t * 90 + 220) % 360} 80% 35%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size.width, size.height);

    ctx.fillStyle = "rgb(0 0 0 / 0.25)";
    const block = Math.max(24, Math.floor(size.width / 48));
    for (let x = 0; x < size.width; x += block * 2) {
      ctx.fillRect((x + frameIndex * 7) % size.width, 0, block, size.height);
    }
  };

  drawFrame(0);
  await video.play();
  await waitForVideoMetadata(video);

  return {
    video,
    drawFrame,
    cleanup: () => {
      video.pause();
      for (const track of stream.getTracks()) {
        track.stop();
      }
      video.srcObject = null;
    },
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
  if (scenario.kind === "video") {
    const synthetic = await createSyntheticVideo(scenario.sourceSize);
    const bitmap = await createImageBitmap(synthetic.video);
    const entity = createEntity({
      id: scenario.id,
      name: scenario.label,
      bitmap,
      size: scenario.sourceSize,
      shaderType: scenario.shaderType,
      params: scenario.params,
      mediaSource: {
        type: MediaType.video,
        videoElement: synthetic.video,
        blob: new Blob([], { type: "video/mp4" }),
        duration: 60,
        fps: 30,
        hasAudio: false,
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
    return {
      entities: [entity],
      beforeFrame: (frameIndex) => {
        synthetic.drawFrame(frameIndex);
        entity.textureDirty = true;
      },
      cleanup: () => {
        bitmap.close();
        synthetic.cleanup();
      },
    };
  }

  const count = scenario.kind === "multi" ? (scenario.entityCount ?? 25) : 1;
  const bitmaps = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      createSyntheticBitmap(scenario.sourceSize, index + 1),
    ),
  );
  const entities = bitmaps.map((bitmap, index) =>
    createEntity({
      id: `${scenario.id}-${index}`,
      name: `${scenario.label} ${index + 1}`,
      bitmap,
      size: scenario.sourceSize,
      shaderType: scenario.shaderType,
      params: scenario.params,
      zIndex: index,
      position: getEntityPosition(index, count),
    }),
  );

  return {
    entities,
    beforeFrame:
      scenario.dirtyMode === "texture"
        ? () => {
            for (const entity of entities) {
              entity.textureDirty = true;
            }
          }
        : undefined,
    cleanup: () => {
      for (const bitmap of bitmaps) {
        bitmap.close();
      }
    },
  };
}

function createEntity(options: {
  id: string;
  name: string;
  bitmap: ImageBitmap;
  size: Size;
  shaderType: ShaderType;
  params: Partial<ShaderParams>;
  mediaSource?: ShaderCanvasEntity["mediaSource"];
  playback?: ShaderCanvasEntity["playback"];
  zIndex?: number;
  position?: { x: number; y: number };
}): ShaderCanvasEntity {
  const displayScale =
    options.size.width > CANVAS_WIDTH || options.size.height > CANVAS_HEIGHT
      ? Math.min(
          (CANVAS_WIDTH * 0.78) / options.size.width,
          (CANVAS_HEIGHT * 0.78) / options.size.height,
        )
      : Math.min(1, (CANVAS_WIDTH * 0.22) / options.size.width);
  const displaySize = {
    width: Math.max(1, Math.round(options.size.width * displayScale)),
    height: Math.max(1, Math.round(options.size.height * displayScale)),
  };

  return {
    id: options.id,
    name: options.name,
    position: options.position ?? {
      x: (CANVAS_WIDTH - displaySize.width) / 2,
      y: (CANVAS_HEIGHT - displaySize.height) / 2,
    },
    size: displaySize,
    zIndex: options.zIndex ?? 0,
    rotation: 0,
    imageBitmap: options.bitmap,
    originalSize: options.size,
    mediaSource: options.mediaSource ?? {
      type: MediaType.image,
      imageBitmap: options.bitmap,
      blob: new Blob([], { type: "image/png" }),
    },
    playback: options.playback,
    shaderType: options.shaderType,
    shaderParams: cloneParams(options.params),
    textureDirty: true,
    selected: false,
    locked: false,
    edited: false,
  } as ShaderCanvasEntity;
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

function createRenderState(entities: ShaderCanvasEntity[], dirty: boolean): RenderState {
  return {
    viewport: { offset: { x: 0, y: 0 }, zoom: 1 },
    entities,
    selectedEntityIds: new Set(),
    hoveredEntityId: null,
    debugMode: false,
    dirty,
    canvasCallouts: [],
    dragSelectBounds: null,
    multiSelectBounds: null,
    actionLayerActive: false,
    actionLayerEntityIds: new Set(),
  };
}

async function runFrames(params: {
  renderer: InfiniteCanvasRenderer;
  entities: ShaderCanvasEntity[];
  frameCount: number;
  beforeFrame?: (frameIndex: number) => void;
  startFrameIndex: number;
}): Promise<{ totalMs: number; cpuEncodeMs: number; queueDrainMs: number }> {
  const device = params.renderer.device;
  if (!device) throw new Error("Renderer device is unavailable");

  const start = performance.now();
  let cpuEncodeMs = 0;

  for (let index = 0; index < params.frameCount; index += 1) {
    params.beforeFrame?.(params.startFrameIndex + index);
    const cpuStart = performance.now();
    params.renderer.render(createRenderState([...params.entities], true));
    cpuEncodeMs += performance.now() - cpuStart;
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
  };
}

async function runScenario(scenario: BenchScenario): Promise<BenchResult> {
  const benchRenderer = await getRenderer();
  const entitySet = await createEntities(scenario);
  let frameIndex = 0;
  gpuErrors.length = 0;

  try {
    writeResults(`Running ${scenario.label}\n\nWarming up...`);
    await runFrames({
      renderer: benchRenderer,
      entities: entitySet.entities,
      frameCount: scenario.warmupFrames,
      beforeFrame: entitySet.beforeFrame,
      startFrameIndex: frameIndex,
    });
    frameIndex += scenario.warmupFrames;

    const samples: number[] = [];
    const cpuSamples: number[] = [];
    const queueDrainSamples: number[] = [];
    const sampleDetails: BenchSample[] = [];
    for (let sample = 0; sample < scenario.samples; sample += 1) {
      writeResults(`Running ${scenario.label}\n\nSample ${sample + 1} of ${scenario.samples}...`);
      const startFrameIndex = frameIndex;
      const result = await runFrames({
        renderer: benchRenderer,
        entities: entitySet.entities,
        frameCount: scenario.frames,
        beforeFrame: entitySet.beforeFrame,
        startFrameIndex: frameIndex,
      });
      frameIndex += scenario.frames;
      samples.push(result.totalMs);
      cpuSamples.push(result.cpuEncodeMs);
      queueDrainSamples.push(result.queueDrainMs);
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
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

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
    };
  } finally {
    for (const entity of entitySet.entities) {
      benchRenderer.removeEntityTexture(entity.id);
    }
    entitySet.cleanup?.();
  }
}

function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index]!;
}

async function runAll(): Promise<BenchResult[]> {
  runAllButton.disabled = true;
  delete document.documentElement.dataset.benchComplete;
  delete document.documentElement.dataset.benchResultCount;
  const results: BenchResult[] = [];
  try {
    for (const scenario of scenarios) {
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
    runAllButton.disabled = false;
  }
}

async function runScenarioById(scenarioId: string): Promise<BenchResult> {
  const scenario = scenarios.find((item) => item.id === scenarioId);
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
  const device = benchRenderer.device;
  if (!device) throw new Error("Renderer device is unavailable");

  try {
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
    for (const entity of entitySet.entities) {
      benchRenderer.removeEntityTexture(entity.id);
    }
    entitySet.cleanup?.();
  }
}

function formatResults(results: readonly BenchResult[]): string {
  return JSON.stringify(results, null, 2);
}

function renderScenarioList(): void {
  scenarioList.textContent = "";
  for (const scenario of scenarios) {
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
window.__runVoidmeshRenderBench = runAll;
window.__runVoidmeshRenderBenchScenario = runScenarioById;
window.__captureVoidmeshRenderBenchVisual = captureFlowingGlassVisual;
window.__collectVoidmeshRenderBenchMetadata = collectBenchMetadata;

const searchParams = new URLSearchParams(window.location.search);
const scenarioId = searchParams.get("scenario");
if (searchParams.get("visual") === "flowing-glass") {
  void captureFlowingGlassVisual();
} else if (scenarioId) {
  void runScenarioById(scenarioId);
} else if (searchParams.get("autorun") === "1") {
  void runAll();
}
