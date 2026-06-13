import { CanvasStore } from "#engine";
import { config, glassKindResets, glitchKindResets } from "#config";
import { deepMerge } from "#lib/deep-merge.ts";
import { applyShaderDefaults } from "#lib/shader-defaults.ts";
import { InfiniteCanvasRenderer } from "#renderer/canvas-renderer.ts";
import {
  AsciiKind,
  DitheringKind,
  GlassKind,
  GlitchKind,
  MediaType,
  ShaderType,
  type ShaderCanvasEntity,
  type ShaderParams,
  type ShaderType as ShaderTypeValue,
} from "#types/canvas.ts";

const CANVAS_SIZE = 256 * 3;
const ENTITY_SIZE = 192 * 3;

const VISUAL_CASES = [
  { id: "halftone", shaderType: ShaderType.halftone },
  { id: "blobs", shaderType: ShaderType.blobs },
  { id: "melt", shaderType: ShaderType.melt },
  ...Object.values(DitheringKind).map((kind) => ({
    id: `dithering-${kind}`,
    shaderType: ShaderType.dithering,
    ditheringKind: kind,
  })),
  ...Object.values(AsciiKind).map((kind) => ({
    id: `ascii-${kind}`,
    shaderType: ShaderType.ascii,
    asciiKind: kind,
  })),
  ...Object.values(GlassKind).map((kind) => ({
    id: `glass-${kind}`,
    shaderType: ShaderType.glass,
    glassKind: kind,
  })),
  ...Object.values(GlitchKind).map((kind) => ({
    id: `glitch-${kind}`,
    shaderType: ShaderType.glitch,
    glitchKind: kind,
  })),
] as const;

type VisualCase = (typeof VISUAL_CASES)[number];

export interface WebgpuHarnessRenderResult {
  canvasWidth: number;
  canvasHeight: number;
  entityCount: number;
  renderedCount: number;
  frameVisiblePixels: number;
  colorConfig: {
    supportsP3: boolean;
    canvasFormat: GPUTextureFormat;
    canvasColorSpace: PredefinedColorSpace;
    intermediateFormat: GPUTextureFormat;
    textureColorSpace: PredefinedColorSpace;
  };
}

declare global {
  interface Window {
    __voidmeshWebgpuHarness: {
      hasWebgpuAdapter(): Promise<boolean>;
      getVisualCases(): string[];
      renderBasic(): Promise<WebgpuHarnessRenderResult>;
      renderVisualCase(caseId: string): Promise<WebgpuHarnessRenderResult>;
      destroy(): void;
    };
  }
}

let renderer: InfiniteCanvasRenderer | null = null;
let teapotBitmapPromise: Promise<ImageBitmap> | null = null;

async function createTestBitmap(): Promise<ImageBitmap> {
  const source = new OffscreenCanvas(ENTITY_SIZE, ENTITY_SIZE);
  const ctx = source.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context unavailable");
  }

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, ENTITY_SIZE, ENTITY_SIZE);
  ctx.fillStyle = "#f00";
  ctx.fillRect(24, 24, 72, 72);
  ctx.fillStyle = "#0f0";
  ctx.fillRect(96, 24, 72, 72);
  ctx.fillStyle = "#00f";
  ctx.fillRect(24, 96, 144, 72);

  return createImageBitmap(source);
}

async function createTeapotBitmap(): Promise<ImageBitmap> {
  if (teapotBitmapPromise) return teapotBitmapPromise;

  teapotBitmapPromise = (async () => {
    const response = await fetch(new URL("./teapot.jpg", import.meta.url));
    if (!response.ok) {
      throw new Error(`Failed to load teapot fixture: ${response.status}`);
    }

    const source = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(ENTITY_SIZE, ENTITY_SIZE);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D canvas context unavailable");
    }

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, ENTITY_SIZE, ENTITY_SIZE);

    const scale = Math.min(ENTITY_SIZE / source.width, ENTITY_SIZE / source.height);
    const width = Math.round(source.width * scale);
    const height = Math.round(source.height * scale);
    const x = Math.floor((ENTITY_SIZE - width) / 2);
    const y = Math.floor((ENTITY_SIZE - height) / 2);
    ctx.drawImage(source, x, y, width, height);
    source.close();

    return createImageBitmap(canvas);
  })();

  return teapotBitmapPromise;
}

function createBaseShaderParams(shaderType: ShaderTypeValue): ShaderParams {
  const shaderParams: ShaderParams = structuredClone(config.defaults.shaderParams);
  const params = applyShaderDefaults(shaderParams, ShaderType.dithering, shaderType);
  params.showOriginal = false;
  params.time = 0;
  params.timeAutoPlay = false;
  params.postProcess = {
    enabled: false,
    grain: { enabled: false, size: 1, intensity: 0 },
    bloom: { enabled: false, threshold: 1, intensity: 0, filterRadius: 0, softness: 0 },
    chromaticAberration: { enabled: false, offset: 0 },
  };
  return params;
}

function createSmokeShaderParams(): ShaderParams {
  const shaderParams: ShaderParams = structuredClone(config.defaults.shaderParams);
  shaderParams.showOriginal = true;
  shaderParams.timeAutoPlay = false;
  shaderParams.postProcess = {
    enabled: false,
    grain: { enabled: false, size: 1, intensity: 0 },
    bloom: { enabled: false, threshold: 1, intensity: 0, filterRadius: 0, softness: 0 },
    chromaticAberration: { enabled: false, offset: 0 },
  };
  return shaderParams;
}

function createVisualShaderParams(testCase: VisualCase): ShaderParams {
  let shaderParams = createBaseShaderParams(testCase.shaderType);

  if ("ditheringKind" in testCase) {
    shaderParams.dithering = { ...shaderParams.dithering, kind: testCase.ditheringKind };
  }
  if ("asciiKind" in testCase) {
    shaderParams.ascii = { ...shaderParams.ascii, kind: testCase.asciiKind, invert: false };
  }
  if ("glassKind" in testCase) {
    shaderParams = deepMerge(shaderParams, glassKindResets[testCase.glassKind]);
    shaderParams.glass = {
      ...config.defaults.shaderParams.glass,
      ...shaderParams.glass,
      kind: testCase.glassKind,
    };
    shaderParams.postProcess = {
      enabled: false,
      grain: { enabled: false, size: 1, intensity: 0 },
      bloom: { enabled: false, threshold: 1, intensity: 0, filterRadius: 0, softness: 0 },
      chromaticAberration: { enabled: false, offset: 0 },
    };
  }
  if ("glitchKind" in testCase) {
    shaderParams = deepMerge(shaderParams, glitchKindResets[testCase.glitchKind]);
    shaderParams.glitch = { ...shaderParams.glitch, kind: testCase.glitchKind, angle: 0 };
  }

  return shaderParams;
}

function createEntity(
  bitmap: ImageBitmap,
  shaderType: ShaderTypeValue,
  shaderParams: ShaderParams,
): ShaderCanvasEntity {
  const position = Math.floor((CANVAS_SIZE - ENTITY_SIZE) / 2);

  return {
    id: "webgpu-smoke-entity",
    name: "WebGPU Smoke Entity",
    position: { x: position, y: position },
    size: { width: ENTITY_SIZE, height: ENTITY_SIZE },
    zIndex: 1,
    rotation: 0,
    imageBitmap: bitmap,
    originalSize: { width: ENTITY_SIZE, height: ENTITY_SIZE },
    shaderType,
    shaderParams,
    textureDirty: true,
    selected: false,
    locked: false,
    edited: false,
    mediaSource: {
      type: MediaType.image,
      imageBitmap: bitmap,
      blob: new Blob([], { type: "image/png" }),
    },
  };
}

function countVisiblePixels(data: Uint8ClampedArray): number {
  let visiblePixels = 0;
  for (let index = 0; index < data.length; index += 4) {
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;
    if (red > 20 || green > 20 || blue > 20) {
      visiblePixels++;
    }
  }
  return visiblePixels;
}

function drawPreview(frame: {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}): void {
  const existing = document.querySelector<HTMLCanvasElement>("#snapshot-preview");
  const canvas = existing ?? document.createElement("canvas");
  canvas.id = "snapshot-preview";
  canvas.width = frame.width;
  canvas.height = frame.height;
  canvas.style.width = `${frame.width}px`;
  canvas.style.height = `${frame.height}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas context unavailable");
  }

  ctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
  if (!existing) {
    document.body.append(canvas);
  }
}

async function renderEntityCase(
  bitmap: ImageBitmap,
  shaderType: ShaderTypeValue,
  shaderParams: ShaderParams,
): Promise<WebgpuHarnessRenderResult> {
  renderer?.destroy();
  renderer = null;

  const canvas = document.createElement("canvas");
  canvas.id = "webgpu-canvas";
  canvas.style.width = `${CANVAS_SIZE}px`;
  canvas.style.height = `${CANVAS_SIZE}px`;
  document.body.replaceChildren(canvas);

  const store = new CanvasStore();
  renderer = new InfiniteCanvasRenderer(canvas);
  await renderer.initialize();
  renderer.setDisplaySize(CANVAS_SIZE, CANVAS_SIZE);

  store.setViewport({ offset: { x: 0, y: 0 }, zoom: 1 });
  store.addEntity(createEntity(bitmap, shaderType, shaderParams));

  const frameCapture = renderer.captureNextFramePixels();
  renderer.render(store.getRenderState());
  store.clearDirtyFlags();
  const frame = await frameCapture;
  await renderer.waitForGPU();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  drawPreview(frame);

  const stats = renderer.getFrameStats();
  return {
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    entityCount: stats.entityCount,
    renderedCount: stats.renderedCount,
    frameVisiblePixels: countVisiblePixels(frame.data),
    colorConfig: renderer.colorConfig,
  };
}

async function renderBasic(): Promise<WebgpuHarnessRenderResult> {
  return renderEntityCase(
    await createTestBitmap(),
    ShaderType.dithering,
    createSmokeShaderParams(),
  );
}

async function renderVisualCase(caseId: string): Promise<WebgpuHarnessRenderResult> {
  const testCase = VISUAL_CASES.find((item) => item.id === caseId);
  if (!testCase) {
    throw new Error(`Unknown visual render case: ${caseId}`);
  }

  return renderEntityCase(
    await createTeapotBitmap(),
    testCase.shaderType,
    createVisualShaderParams(testCase),
  );
}

window.__voidmeshWebgpuHarness = {
  async hasWebgpuAdapter() {
    if (!navigator.gpu) return false;
    return (await navigator.gpu.requestAdapter()) !== null;
  },
  getVisualCases() {
    return VISUAL_CASES.map((testCase) => testCase.id);
  },
  renderBasic,
  renderVisualCase,
  destroy() {
    renderer?.destroy();
    renderer = null;
    document.body.replaceChildren();
  },
};
