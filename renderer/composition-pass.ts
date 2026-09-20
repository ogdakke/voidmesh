import { OverlapCrossing } from "./overlap-crossing.ts";
import { OpaqueTextureProof } from "./opaque-texture-proof.ts";
import { getTextureByteSize } from "#lib/textures.ts";
import { config } from "#config";
import type { DragSelectMode } from "#engine";
import { MediaType, type Bounds, type ShaderCanvasEntity, type Viewport } from "#types/canvas.ts";
import instancedCompositionShaderSource from "./composition-instanced.wgsl?raw";
import compositionShaderSource from "./composition.wgsl?raw";

export type CompositionSource =
  | { kind: "texture"; texture: GPUTexture }
  | { kind: "external"; texture: GPUExternalTexture };

export interface CompositionDrawItem {
  bindGroup: GPUBindGroup | null;
  texture: GPUTexture | null;
  pipeline: "texture" | "external";
  entity: ShaderCanvasEntity;
  isSelected: boolean;
  debugMode: boolean;
  offsetX: number;
  offsetY: number;
  visualScale: number;
}

export type CompositionLayer = "all" | "scene" | "action";

interface CrossingSliceDraw {
  item: CompositionDrawItem | null;
  anchor: number;
  slice: number;
  sourceIndex: number;
}

export interface CompositionPassOptions {
  device: GPUDevice;
  format: GPUTextureFormat;
  viewportUniformBuffer: GPUBuffer;
}

export interface PrepareCompositionItemOptions {
  entity: ShaderCanvasEntity;
  source: CompositionSource;
  isSelected: boolean;
  debugMode: boolean;
  positionOffsetX: number;
  positionOffsetY: number;
  visualScale: number;
}

export interface DisintegrationCompositionUniforms {
  position: { x: number; y: number };
  size: { width: number; height: number };
  rotation: number;
  progress: number;
  seed: number;
}

export interface FullSceneBatchKey {
  entityVersion: number;
  geometryVersion: number;
  selectionVersion: number;
  debugMode: boolean;
  singleSelectedIndex: number;
  renderWidth: number;
  renderHeight: number;
  texture: GPUTexture | null;
  textureCacheRevision: number;
  instanceCount: number;
}

export interface PrepareFullSceneBatchOptions extends FullSceneBatchKey {
  entities: readonly ShaderCanvasEntity[];
  selectedEntityIds: ReadonlySet<string>;
}

export interface PrepareMixedFullSceneBatchOptions extends FullSceneBatchKey {
  entities: readonly ShaderCanvasEntity[];
  selectedEntityIds: ReadonlySet<string>;
  textureRanges: readonly FullSceneTextureRange[];
}

export interface FullSceneBatchPatch {
  index: number;
  entity: ShaderCanvasEntity;
  texture: GPUTexture;
  isSelected: boolean;
}

export interface FullSceneInstancePatch {
  index: number;
  entity: ShaderCanvasEntity;
  isSelected: boolean;
}

export interface FullSceneTextureRange {
  texture: GPUTexture;
  firstInstance: number;
  instanceCount: number;
}

export interface CompositionPassStats {
  fullSceneBatchRebuilds: number;
  fullSceneBatchUploadBytes: number;
  normalInstanceUploadBytes: number;
  occlusionPasses: number;
  opacityProofs: number;
  opacityBufferBytes: number;
  layerTextureBytes: number;
  externalBindGroupCreations: number;
  sharpRestorePasses: number;
  sharpRestoreCopiedPixels: number;
  sharpRestoreDrawnItems: number;
}

interface CompositionUniformState {
  positionX: number;
  positionY: number;
  width: number;
  height: number;
  rotation: number;
  isSelected: boolean;
  debugMode: boolean;
  positionOffsetX: number;
  positionOffsetY: number;
  visualScale: number;
}

interface CompositionDrawCommand {
  kind: "texture" | "external";
  texture: GPUTexture | null;
  firstInstance: number;
  instanceCount: number;
  item: CompositionDrawItem | null;
}

interface FullSceneBatchCache extends FullSceneBatchKey {
  bufferGeneration: number;
  drawRanges: FullSceneTextureRange[];
  textures: GPUTexture[];
}

interface RetainedFullSceneInstancePayload {
  entityVersion: number;
  geometryVersion: number;
  selectionVersion: number;
  debugMode: boolean;
  instanceCount: number;
  data: ArrayBuffer;
}

function appendTextureRange(
  ranges: FullSceneBatchCache["drawRanges"],
  texture: GPUTexture,
  firstInstance: number,
  instanceCount: number,
): void {
  if (instanceCount <= 0) return;
  const previous = ranges.at(-1);
  if (
    previous?.texture === texture &&
    previous.firstInstance + previous.instanceCount === firstInstance
  ) {
    previous.instanceCount += instanceCount;
    return;
  }
  ranges.push({ texture, firstInstance, instanceCount });
}

function collectUniqueTextures(ranges: FullSceneBatchCache["drawRanges"]): GPUTexture[] {
  const textures: GPUTexture[] = [];
  const seen = new Set<GPUTexture>();
  for (const range of ranges) {
    if (seen.has(range.texture)) continue;
    seen.add(range.texture);
    textures.push(range.texture);
  }
  return textures;
}

const INSTANCE_STRIDE_BYTES = 24;
const INSTANCE_STRIDE_VALUES = INSTANCE_STRIDE_BYTES / 4;
const INITIAL_INSTANCE_CAPACITY = 256;
const INSTANCE_ROTATION_BITS = 16;
const INSTANCE_ROTATION_MAX = (1 << INSTANCE_ROTATION_BITS) - 1;
const INSTANCE_SCALE_BITS = 10;
const INSTANCE_SCALE_MAX = (1 << INSTANCE_SCALE_BITS) - 1;
const INSTANCE_SCALE_QUANTIZED_MAX = INSTANCE_SCALE_MAX - 1;
const INSTANCE_SCALE_MIN = 0.8;
const INSTANCE_SCALE_RANGE = 0.25;
const INSTANCE_SCALE_SHIFT = INSTANCE_ROTATION_BITS;
const INSTANCE_FLAG_SELECTED = 1 << 26;
const INSTANCE_FLAG_DEBUG = 1 << 27;
const INSTANCE_FLAG_LOCKED = 1 << 28;

function getDragSelectModeValue(mode: DragSelectMode | null): number {
  switch (mode) {
    case "replace":
      return 1;
    case "additive":
      return 2;
    case "subtractive":
      return 3;
    default:
      return 0;
  }
}

function packInstanceState(
  entity: ShaderCanvasEntity,
  isSelected: boolean,
  debugMode: boolean,
  visualScale: number,
): number {
  const normalizedRotation = (((entity.rotation % 360) + 360) % 360) / 360;
  const rotation = Math.round(normalizedRotation * INSTANCE_ROTATION_MAX);
  const clampedScale = Math.max(
    INSTANCE_SCALE_MIN,
    Math.min(visualScale, INSTANCE_SCALE_MIN + INSTANCE_SCALE_RANGE),
  );
  const scale =
    visualScale === 1
      ? INSTANCE_SCALE_MAX
      : Math.round(
          ((clampedScale - INSTANCE_SCALE_MIN) / INSTANCE_SCALE_RANGE) *
            INSTANCE_SCALE_QUANTIZED_MAX,
        );
  return (
    (rotation |
      (scale << INSTANCE_SCALE_SHIFT) |
      (isSelected ? INSTANCE_FLAG_SELECTED : 0) |
      (debugMode ? INSTANCE_FLAG_DEBUG : 0) |
      (entity.locked ? INSTANCE_FLAG_LOCKED : 0)) >>>
    0
  );
}

export function createExternalCompositionShaderSource(source: string): string {
  const rewritten = source
    .replace(
      /@group\(0\)\s*@binding\(2\)\s*var\s+entityTexture\s*:\s*texture_2d\s*<\s*f32\s*>\s*;/,
      "@group(0) @binding(2) var entityTexture: texture_external;",
    )
    .replace(
      /textureSampleLevel\(entityTexture,\s*entitySampler,\s*(\w+),\s*0(?:\.0*)?\)/g,
      "textureSampleBaseClampToEdge(entityTexture, entitySampler, $1)",
    );

  if (
    rewritten === source ||
    !rewritten.includes("texture_external") ||
    !rewritten.includes("textureSampleBaseClampToEdge(entityTexture,") ||
    /textureSample(?:Level)?\(entityTexture,/.test(rewritten)
  ) {
    throw new Error("Failed to rewrite composition shader source for external texture input.");
  }
  return rewritten;
}

export class CompositionPass {
  readonly #format: GPUTextureFormat;
  readonly #instancedDescriptor: GPURenderPipelineDescriptor;
  readonly #externalDescriptor: GPURenderPipelineDescriptor;
  #proof: OpaqueTextureProof | null = null;
  #prepassPipeline: GPURenderPipeline | null = null;
  #depthPipelines: { texture: GPURenderPipeline; external: GPURenderPipeline } | null = null;
  #restorePipelines: { texture: GPURenderPipeline; external: GPURenderPipeline } | null = null;
  #restoreDepthPipelines: { texture: GPURenderPipeline; external: GPURenderPipeline } | null = null;
  #backdropLayout: GPUBindGroupLayout | null = null;
  #backdropGroup: GPUBindGroup | null = null;
  #externalBackdropLayout: GPUBindGroupLayout | null = null;
  #unprovenOpacity: GPUBuffer | null = null;
  #restoreGroups = new WeakMap<GPUTexture, { buffer: GPUBuffer; group: GPUBindGroup }>();
  #backdrop: GPUTexture | null = null;
  #depth: GPUTexture | null = null;
  #depthView: GPUTextureView | null = null;
  #occlusion = false;
  #drawMode: "normal" | "depth" | "restore" = "normal";
  #occlusionPasses = 0;
  readonly #backdropItems: CompositionDrawItem[] = [];
  readonly #sharpRestoreItems: CompositionDrawItem[] = [];
  readonly #occluderItems: CompositionDrawItem[] = [];
  #prepassLayout: GPUBindGroupLayout | null = null;
  #prepassInstances: { buffer: GPUBuffer; group: GPUBindGroup } | null = null;
  #opacityTable: GPUBuffer | null = null;
  #opacityTableBytes = 0;
  #opacityTableGroup: GPUBindGroup | null = null;
  readonly #device: GPUDevice;
  readonly #slicePool: CrossingSliceDraw[] = [];
  readonly #slicePlan: CrossingSliceDraw[] = [];
  readonly #sliceItem: CompositionDrawItem[] = [];
  #sliceSource: CompositionDrawItem | null = null;
  #sliceLayer: CompositionLayer = "all";
  readonly #appendSlice = (
    anchor: number,
    slice: number,
    sourceIndex: number,
    foreground: boolean,
  ): void => {
    if (
      (this.#sliceLayer === "scene" && foreground) ||
      (this.#sliceLayer === "action" && !foreground)
    )
      return;
    const item = this.#sliceSource;
    if (!item) throw new Error("Crossing slice has no source material");
    const index = this.#slicePlan.length;
    const draw = this.#slicePool[index] ?? { item, anchor, slice, sourceIndex };
    draw.item = item;
    draw.anchor = anchor;
    draw.slice = slice;
    draw.sourceIndex = sourceIndex;
    this.#slicePool[index] = draw;
    this.#slicePlan.push(draw);
  };
  readonly #compareSlices = (a: CrossingSliceDraw, b: CrossingSliceDraw): number =>
    a.anchor - b.anchor ||
    Number(a.slice > 1) - Number(b.slice > 1) ||
    a.sourceIndex - b.sourceIndex;
  readonly crossing: OverlapCrossing;
  readonly #viewportUniformBuffer: GPUBuffer;
  readonly #pipeline: GPURenderPipeline;
  readonly #instancedPipeline: GPURenderPipeline;
  readonly #interactiveInstancedPipeline: GPURenderPipeline;
  readonly #externalPipeline: GPURenderPipeline;
  readonly #bindGroupLayout: GPUBindGroupLayout;
  readonly #instancedBindGroupLayout: GPUBindGroupLayout;
  readonly #externalBindGroupLayout: GPUBindGroupLayout;
  readonly #sampler: GPUSampler;
  readonly #interactionUniformBuffer: GPUBuffer;
  readonly #interactionUniformData = new ArrayBuffer(32);
  readonly #interactionUniformFloats = new Float32Array(this.#interactionUniformData);
  readonly #interactionUniformUints = new Uint32Array(this.#interactionUniformData);
  #interactionOffsetX = 0;
  #interactionOffsetY = 0;
  #interactionScale = 0;
  #interactionSelectionMode = 0;
  #interactionSelectionX = 0;
  #interactionSelectionY = 0;
  #interactionSelectionWidth = 0;
  #interactionSelectionHeight = 0;
  readonly #entityUniformData = new ArrayBuffer(config.rendering.entityUniformSize);
  readonly #entityFloatView = new Float32Array(this.#entityUniformData);
  readonly #entityUintView = new Uint32Array(this.#entityUniformData);
  readonly #textureViewCache = new WeakMap<GPUTexture, GPUTextureView>();
  #instanceBuffer: GPUBuffer | null = null;
  #instanceCapacity = 0;
  #instanceData = new ArrayBuffer(0);
  #instanceFloatView = new Float32Array(0);
  #instanceUintView = new Uint32Array(0);
  #instanceWriteCursor = 0;
  #instanceBufferGeneration = 0;
  #instanceBindGroupCache = new WeakMap<GPUTexture, GPUBindGroup>();
  readonly #drawCommands: CompositionDrawCommand[] = [];
  #fullSceneBatch: FullSceneBatchCache | null = null;
  // Visible draws reuse the same CPU/GPU instance buffer and invalidate the active
  // batch. Preserve its immutable payload so a texture-only refresh can restore it.
  #retainedFullSceneInstancePayload: RetainedFullSceneInstancePayload | null = null;
  #fullSceneBatchRebuilds = 0;
  #fullSceneBatchUploadBytes = 0;
  #normalInstanceUploadBytes = 0;
  #externalBindGroupCreations = 0;
  #sharpRestorePasses = 0;
  #sharpRestoreCopiedPixels = 0;
  #sharpRestoreDrawnItems = 0;

  // Entity composition cache (uniform buffers, bind groups, texture views).
  // Invalidated when entity composition texture or visual state changes.
  #entityCompositionCache: WeakMap<
    ShaderCanvasEntity,
    {
      texture: GPUTexture;
      drawItem: CompositionDrawItem;
    }
  > = new WeakMap();

  readonly #entityExternalCompositionCache: Map<
    string,
    {
      uniformBuffer: GPUBuffer;
      uniformState: CompositionUniformState;
      drawItem: CompositionDrawItem;
    }
  > = new Map();

  constructor(options: CompositionPassOptions) {
    this.#format = options.format;
    this.#device = options.device;
    this.crossing = new OverlapCrossing(this.#device);
    this.#viewportUniformBuffer = options.viewportUniformBuffer;

    const shaderModule = this.#device.createShaderModule({
      label: "Composition shader",
      code: compositionShaderSource,
    });

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
      label: "Composition bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    this.#instancedBindGroupLayout = this.#device.createBindGroupLayout({
      label: "Instanced composition bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
      ],
    });

    this.#externalBindGroupLayout = this.#device.createBindGroupLayout({
      label: "External composition bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          externalTexture: {},
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    });

    this.#sampler = this.#device.createSampler({
      label: "Composition sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.#interactionUniformBuffer = this.#device.createBuffer({
      label: "Composition interaction uniforms",
      size: this.#interactionUniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Composition pipeline layout",
      bindGroupLayouts: [this.#bindGroupLayout, this.crossing.layout],
    });

    this.#pipeline = this.#device.createRenderPipeline({
      label: "Composition pipeline",
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: options.format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
    });

    const instancedShaderModule = this.#device.createShaderModule({
      label: "Instanced composition shader",
      code: instancedCompositionShaderSource,
    });
    const instancedPipelineLayout = this.#device.createPipelineLayout({
      label: "Instanced composition pipeline layout",
      bindGroupLayouts: [this.#instancedBindGroupLayout, this.crossing.layout],
    });
    this.#instancedDescriptor = {
      label: "Instanced composition pipeline",
      layout: instancedPipelineLayout,
      vertex: {
        module: instancedShaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: instancedShaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: options.format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
    };
    this.#instancedPipeline = this.#device.createRenderPipeline(this.#instancedDescriptor);
    this.#interactiveInstancedPipeline = this.#device.createRenderPipeline({
      label: "Interactive instanced composition pipeline",
      layout: instancedPipelineLayout,
      vertex: {
        module: instancedShaderModule,
        entryPoint: "vs_interactive",
      },
      fragment: {
        module: instancedShaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: options.format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
    });

    const externalShaderModule = this.#device.createShaderModule({
      label: "External composition shader",
      code: createExternalCompositionShaderSource(compositionShaderSource),
    });

    const externalPipelineLayout = this.#device.createPipelineLayout({
      label: "External composition pipeline layout",
      bindGroupLayouts: [this.#externalBindGroupLayout, this.crossing.layout],
    });

    this.#externalDescriptor = {
      label: "External composition pipeline",
      layout: externalPipelineLayout,
      vertex: {
        module: externalShaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: externalShaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: options.format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
    };
    this.#externalPipeline = this.#device.createRenderPipeline(this.#externalDescriptor);
  }

  prepareDrawItem(options: PrepareCompositionItemOptions): CompositionDrawItem {
    const { entity, source, isSelected, positionOffsetX, positionOffsetY } = options;

    if (source.kind === "texture") {
      const cached = this.#entityCompositionCache.get(entity);
      const drawItem: CompositionDrawItem = cached?.drawItem ?? {
        bindGroup: null,
        texture: source.texture,
        pipeline: "texture",
        entity,
        isSelected,
        debugMode: options.debugMode,
        offsetX: positionOffsetX,
        offsetY: positionOffsetY,
        visualScale: options.visualScale,
      };
      drawItem.texture = source.texture;
      drawItem.entity = entity;
      drawItem.isSelected = isSelected;
      drawItem.debugMode = options.debugMode;
      drawItem.offsetX = positionOffsetX;
      drawItem.offsetY = positionOffsetY;
      drawItem.visualScale = options.visualScale;
      if (!cached) {
        this.#entityCompositionCache.set(entity, { texture: source.texture, drawItem });
      } else {
        cached.texture = source.texture;
      }
      return drawItem;
    }

    const cached = this.#entityExternalCompositionCache.get(entity.id);
    const uniformBuffer =
      cached?.uniformBuffer ??
      this.#device.createBuffer({
        label: `Entity ${entity.id} external composition uniform`,
        size: config.rendering.entityUniformSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

    const uniformState = this.#writeLiveEntityUniforms(
      uniformBuffer,
      options,
      cached?.uniformState,
    );

    // GPUExternalTexture validity is tied to the imported video frame. WebKit may
    // revive the same JavaScript wrapper identity for a later import, but a bind
    // group from the previous lifetime must not be reused.
    const bindGroup = this.#device.createBindGroup({
      label: `Entity ${entity.id} external composition bind group`,
      layout: this.#externalBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: source.texture },
        { binding: 3, resource: this.#sampler },
      ],
    });
    this.#externalBindGroupCreations++;

    const drawItem: CompositionDrawItem = cached?.drawItem ?? {
      bindGroup,
      texture: null,
      pipeline: "external",
      entity,
      isSelected,
      debugMode: options.debugMode,
      offsetX: positionOffsetX,
      offsetY: positionOffsetY,
      visualScale: options.visualScale,
    };
    drawItem.bindGroup = bindGroup;
    drawItem.texture = null;
    drawItem.pipeline = "external";
    drawItem.entity = entity;
    drawItem.isSelected = isSelected;
    drawItem.debugMode = options.debugMode;
    drawItem.offsetX = positionOffsetX;
    drawItem.offsetY = positionOffsetY;
    drawItem.visualScale = options.visualScale;

    if (!cached) {
      this.#entityExternalCompositionCache.set(entity.id, {
        uniformBuffer,
        uniformState,
        drawItem,
      });
    } else {
      cached.uniformState = uniformState;
    }

    return drawItem;
  }

  beginFrame(maximumInstanceCount: number): void {
    this.#occlusion = false;
    this.#drawMode = "normal";
    this.#backdropItems.length = 0;
    this.#sharpRestoreItems.length = 0;
    this.#occluderItems.length = 0;
    this.#instanceWriteCursor = 0;
    if (maximumInstanceCount > 0) this.#ensureInstanceCapacity(maximumInstanceCount);
  }

  getStats(): CompositionPassStats {
    return {
      fullSceneBatchRebuilds: this.#fullSceneBatchRebuilds,
      fullSceneBatchUploadBytes: this.#fullSceneBatchUploadBytes,
      normalInstanceUploadBytes: this.#normalInstanceUploadBytes,
      occlusionPasses: this.#occlusionPasses,
      opacityProofs: this.#proof?.getStats().proofs ?? 0,
      opacityBufferBytes: (this.#proof?.getStats().residentBytes ?? 0) + this.#opacityTableBytes,
      externalBindGroupCreations: this.#externalBindGroupCreations,
      sharpRestorePasses: this.#sharpRestorePasses,
      sharpRestoreCopiedPixels: this.#sharpRestoreCopiedPixels,
      sharpRestoreDrawnItems: this.#sharpRestoreDrawnItems,
      layerTextureBytes:
        (this.#depth ? this.#depth.width * this.#depth.height * 4 : 0) +
        (this.#backdrop
          ? getTextureByteSize(this.#backdrop.width, this.#backdrop.height, this.#format)
          : 0),
    };
  }

  endFrame(): void {
    this.#proof?.endFrame();
  }
  primeImmutableSource(texture: GPUTexture, encoder: GPUCommandEncoder): void {
    this.#proof ??= new OpaqueTextureProof(this.#device);
    this.#proof.get(texture, encoder);
  }

  /** Compile crossing pipelines before user input, rather than on first return. */
  async initializeOverlap(): Promise<void> {
    this.#ensureBackdropBindings();
    this.#proof ??= new OpaqueTextureProof(this.#device);
    const make = async (entryPoint: string, depth: boolean) => {
      const descriptors = this.#pipelineDescriptors(entryPoint, depth);
      const [texture, external] = await Promise.all([
        this.#device.createRenderPipelineAsync(descriptors.texture),
        this.#device.createRenderPipelineAsync(descriptors.external),
      ]);
      return { texture, external };
    };
    const [depth, restore, restoreDepth, prepass] = await Promise.all([
      make("fs_main", true),
      make("fs_restore", false),
      make("fs_restore", true),
      this.#device.createRenderPipelineAsync(this.#prepassDescriptor()),
      this.#proof.initialize(),
    ]);
    this.#depthPipelines = depth;
    this.#restorePipelines = restore;
    this.#restoreDepthPipelines = restoreDepth;
    this.#prepassPipeline = prepass;
  }

  #ensureBackdropBindings(): void {
    this.#backdropLayout ??= this.#device.createBindGroupLayout({
      label: "Sharp overlap backdrop",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });
    this.#externalBackdropLayout ??= this.#device.createBindGroupLayout({
      label: "External sharp overlap backdrop",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });
    this.#unprovenOpacity ??= this.#device.createBuffer({
      label: "Unproven opacity",
      size: 4,
      usage: GPUBufferUsage.STORAGE,
    });
  }

  #prepassDescriptor(): GPURenderPipelineDescriptor {
    this.#prepassLayout ??= this.#device.createBindGroupLayout({
      label: "Overlap depth instances",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    return {
      label: "Opaque overlap depth prepass",
      layout: this.#device.createPipelineLayout({
        bindGroupLayouts: [this.#prepassLayout, this.crossing.layout, this.#proof!.layout],
      }),
      vertex: { ...this.#instancedDescriptor.vertex, entryPoint: "vs_occlusion" },
      fragment: {
        module: this.#instancedDescriptor.vertex.module,
        entryPoint: "fs_occlusion",
        targets: [],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less-equal" },
    };
  }

  #pipelineDescriptors(entryPoint: string, depth: boolean) {
    const make = (
      descriptor: GPURenderPipelineDescriptor,
      baseLayout: GPUBindGroupLayout,
      backdropLayout: GPUBindGroupLayout | null,
    ): GPURenderPipelineDescriptor => {
      if (!descriptor.fragment) throw new Error("Composition pipeline has no fragment stage");
      return {
        ...descriptor,
        label: `${descriptor.label} ${entryPoint}${depth ? " depth-tested" : ""}`,
        layout:
          entryPoint === "fs_restore"
            ? this.#device.createPipelineLayout({
                bindGroupLayouts: [baseLayout, this.crossing.layout, backdropLayout!],
              })
            : descriptor.layout,
        fragment: { ...descriptor.fragment, entryPoint },
        ...(depth
          ? {
              depthStencil: {
                format: "depth32float" as const,
                depthWriteEnabled: false,
                depthCompare: "less-equal" as const,
              },
            }
          : {}),
      };
    };
    return {
      texture: make(
        this.#instancedDescriptor,
        this.#instancedBindGroupLayout,
        this.#backdropLayout,
      ),
      external: make(
        this.#externalDescriptor,
        this.#externalBindGroupLayout,
        this.#externalBackdropLayout,
      ),
    };
  }

  #makePipelines(entryPoint: string, depth: boolean) {
    const descriptors = this.#pipelineDescriptors(entryPoint, depth);
    return {
      texture: this.#device.createRenderPipeline(descriptors.texture),
      external: this.#device.createRenderPipeline(descriptors.external),
    };
  }

  /** Exact opacity is cached only for immutable, original still-image uploads. */
  prepareOcclusion(
    encoder: GPUCommandEncoder,
    items: readonly CompositionDrawItem[],
    width: number,
    height: number,
    zoom: number,
  ): GPURenderPassDepthStencilAttachment | undefined {
    if (!this.crossing.hasLayerSlices) return undefined;
    if (this.#instanceWriteCursor !== 0)
      throw new Error("Prepare overlap occlusion before entity draws");
    this.#ensureInstanceCapacity(items.length * 3 + this.crossing.contactCount);
    this.#occluderItems.length = 0;
    let area = 0;
    for (const item of items) {
      if (
        item.pipeline !== "texture" ||
        !item.texture ||
        item.entity.mediaSource.type !== MediaType.image ||
        !item.entity.shaderParams.showOriginal ||
        this.crossing.isActiveEntity(item.entity.id) ||
        item.isSelected ||
        item.debugMode
      )
        continue;
      this.#occluderItems.push(item);
      area += item.entity.size.width * item.entity.size.height * item.visualScale ** 2 * zoom ** 2;
    }
    // Pay for a prepass only when original-image overdraw can outweigh it.
    if (area < width * height * 2) return undefined;
    if (width * height * 4 > config.rendering.processingTextureBudgetBytes)
      throw new Error("Overlap depth target exceeds its byte budget");
    this.#proof ??= new OpaqueTextureProof(this.#device);
    this.#depthPipelines ??= this.#makePipelines("fs_main", true);
    this.#prepassPipeline ??= this.#device.createRenderPipeline(this.#prepassDescriptor());
    if (!this.#depth || this.#depth.width !== width || this.#depth.height !== height) {
      if (this.#backdrop && (this.#backdrop.width !== width || this.#backdrop.height !== height)) {
        this.#backdrop.destroy();
        this.#backdrop = null;
        this.#backdropGroup = null;
        this.#restoreGroups = new WeakMap();
      }
      const backdropBytes = this.#backdrop ? getTextureByteSize(width, height, this.#format) : 0;
      if (width * height * 4 + backdropBytes > config.rendering.processingTextureBudgetBytes)
        throw new Error("Overlap layer targets exceed their byte budget");
      this.#depth?.destroy();
      this.#depth = this.#device.createTexture({
        label: "Overlap opaque depth",
        size: [width, height],
        format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.#depthView = this.#depth.createView();
    }
    // Reserve before encoding any pass that refers to the shared instance buffer.
    this.#ensureInstanceCapacity(
      items.length * 3 + this.crossing.contactCount + this.#occluderItems.length,
    );
    const count = this.#occluderItems.length;
    const firstInstance = this.#instanceWriteCursor;
    const tableBytes = Math.max(256, 2 ** Math.ceil(Math.log2((firstInstance + count) * 4)));
    if (tableBytes > this.#device.limits.maxStorageBufferBindingSize)
      throw new Error("Overlap opacity table exceeds the GPU storage binding limit");
    if (this.#opacityTableBytes < tableBytes) {
      this.#opacityTable?.destroy();
      this.#opacityTable = this.#device.createBuffer({
        label: "Overlap instance opacity",
        size: tableBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.#opacityTableBytes = tableBytes;
      this.#opacityTableGroup = this.#device.createBindGroup({
        layout: this.#proof.layout,
        entries: [{ binding: 1, resource: { buffer: this.#opacityTable } }],
      });
    }
    for (let i = 0; i < count; i++) {
      const item = this.#occluderItems[i]!;
      const proof = this.#proof.get(item.texture!, encoder);
      encoder.copyBufferToBuffer(proof.buffer, 0, this.#opacityTable!, (firstInstance + i) * 4, 4);
      this.#writeInstance(firstInstance + i, item);
    }
    this.#device.queue.writeBuffer(
      this.#instanceBuffer!,
      firstInstance * INSTANCE_STRIDE_BYTES,
      this.#instanceData,
      firstInstance * INSTANCE_STRIDE_BYTES,
      count * INSTANCE_STRIDE_BYTES,
    );
    this.#normalInstanceUploadBytes += count * INSTANCE_STRIDE_BYTES;
    this.#instanceWriteCursor += count;
    if (this.#prepassInstances?.buffer !== this.#instanceBuffer)
      this.#prepassInstances = {
        buffer: this.#instanceBuffer!,
        group: this.#device.createBindGroup({
          layout: this.#prepassLayout!,
          entries: [
            { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
            { binding: 1, resource: { buffer: this.#instanceBuffer! } },
          ],
        }),
      };
    const pass = encoder.beginRenderPass({
      label: "Overlap opaque depth prepass",
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.#depthView!,
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    pass.setPipeline(this.#prepassPipeline!);
    pass.setBindGroup(0, this.#prepassInstances.group);
    pass.setBindGroup(1, this.crossing.bindGroup);
    pass.setBindGroup(2, this.#opacityTableGroup!);
    pass.draw(6, count, 0, firstInstance);
    pass.end();
    this.#drawMode = "depth";
    this.#occlusion = true;
    this.#occlusionPasses++;
    return { view: this.#depthView!, depthReadOnly: true };
  }

  drawBackdropScene(pass: GPURenderPassEncoder, items: readonly CompositionDrawItem[]): void {
    this.#drawMode = this.#occlusion ? "depth" : "normal";
    if (!this.crossing.hasSharpScene) {
      this.drawItems(pass, items, "scene");
      return;
    }
    this.#backdropItems.length = 0;
    for (const item of items)
      if (!this.crossing.isActiveEntity(item.entity.id)) this.#backdropItems.push(item);
    this.#drawItems(pass, this.#backdropItems, 0);
  }

  restoreSharpScene(
    encoder: GPUCommandEncoder,
    target: GPUTexture,
    view: GPUTextureView,
    items: readonly CompositionDrawItem[],
    viewport: Viewport,
    dpr: number,
  ): void {
    if (!this.crossing.hasSharpScene) {
      this.#drawMode = "normal";
      return;
    }
    const bytes =
      getTextureByteSize(target.width, target.height, this.#format) +
      (this.#depth ? this.#depth.width * this.#depth.height * 4 : 0);
    if (bytes > config.rendering.processingTextureBudgetBytes)
      throw new Error("Overlap layer targets exceed their byte budget");
    this.#ensureBackdropBindings();
    if (
      !this.#backdrop ||
      this.#backdrop.width !== target.width ||
      this.#backdrop.height !== target.height
    ) {
      this.#backdrop?.destroy();
      this.#backdrop = this.#device.createTexture({
        label: "Blurred overlap backdrop",
        size: [target.width, target.height],
        format: this.#format,
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.#backdropGroup = this.#device.createBindGroup({
        layout: this.#externalBackdropLayout!,
        entries: [{ binding: 0, resource: this.#backdrop.createView() }],
      });
      this.#restoreGroups = new WeakMap();
    }
    this.#restorePipelines ??= this.#makePipelines("fs_restore", false);
    if (this.#occlusion) this.#restoreDepthPipelines ??= this.#makePipelines("fs_restore", true);

    this.#sharpRestoreItems.length = 0;
    for (const item of items) {
      const role = this.crossing.sharpSceneRole(item.entity.id);
      if (!role) continue;
      this.#sharpRestoreItems.push(item);
    }
    const copyBounds = this.crossing.getSharpSceneWorldBounds((4 * dpr) / viewport.zoom);
    const minimumX = Math.max(
      0,
      copyBounds ? Math.floor((copyBounds.x - viewport.offset.x) * viewport.zoom) - 1 : 0,
    );
    const minimumY = Math.max(
      0,
      copyBounds ? Math.floor((copyBounds.y - viewport.offset.y) * viewport.zoom) - 1 : 0,
    );
    const maximumX = Math.min(
      target.width,
      copyBounds
        ? Math.ceil((copyBounds.x + copyBounds.width - viewport.offset.x) * viewport.zoom) + 1
        : 0,
    );
    const maximumY = Math.min(
      target.height,
      copyBounds
        ? Math.ceil((copyBounds.y + copyBounds.height - viewport.offset.y) * viewport.zoom) + 1
        : 0,
    );
    const copyWidth = maximumX - minimumX;
    const copyHeight = maximumY - minimumY;
    if (this.#sharpRestoreItems.length === 0) {
      this.#drawMode = "normal";
      return;
    }
    if (copyWidth > 0 && copyHeight > 0) {
      encoder.copyTextureToTexture(
        { texture: target, origin: { x: minimumX, y: minimumY } },
        { texture: this.#backdrop, origin: { x: minimumX, y: minimumY } },
        { width: copyWidth, height: copyHeight },
      );
      this.#sharpRestoreCopiedPixels += copyWidth * copyHeight;
    }
    this.#sharpRestorePasses++;
    this.#sharpRestoreDrawnItems += this.#sharpRestoreItems.length;
    this.#ensureInstanceCapacity(
      this.#instanceWriteCursor + this.#sharpRestoreItems.length * 2 + this.crossing.contactCount,
    );
    const pass = encoder.beginRenderPass({
      label: "Sharp lower crossing reconstruction",
      colorAttachments: [{ view, loadOp: "load", storeOp: "store" }],
      ...(this.#occlusion
        ? { depthStencilAttachment: { view: this.#depthView!, depthReadOnly: true } }
        : {}),
    });
    this.#drawMode = "restore";
    this.drawItems(pass, this.#sharpRestoreItems, "scene");
    pass.end();
    this.#drawMode = "normal";
  }

  hasFullSceneBatch(key: FullSceneBatchKey): boolean {
    const cached = this.#fullSceneBatch;
    return (
      cached !== null &&
      cached.bufferGeneration === this.#instanceBufferGeneration &&
      cached.entityVersion === key.entityVersion &&
      cached.geometryVersion === key.geometryVersion &&
      cached.selectionVersion === key.selectionVersion &&
      cached.debugMode === key.debugMode &&
      cached.renderWidth === key.renderWidth &&
      cached.renderHeight === key.renderHeight &&
      cached.texture === key.texture &&
      cached.instanceCount === key.instanceCount
    );
  }

  prepareFullSceneBatch(options: PrepareFullSceneBatchOptions): void {
    const { entities, selectedEntityIds, ...key } = options;
    if (entities.length !== key.instanceCount) {
      throw new Error("Full-scene batch instance count does not match its entity payload");
    }
    if (this.hasFullSceneBatch(key)) return;

    const buffer = this.#ensureInstanceCapacity(entities.length);
    for (let index = 0; index < entities.length; index++) {
      const entity = entities[index]!;
      this.#writeFullSceneInstance(
        index,
        entity,
        selectedEntityIds.has(entity.id),
        options.debugMode,
      );
      entity.textureDirty = false;
    }
    const uploadBytes = entities.length * INSTANCE_STRIDE_BYTES;
    this.#device.queue.writeBuffer(buffer, 0, this.#instanceData, 0, uploadBytes);
    this.#fullSceneBatchRebuilds += 1;
    this.#fullSceneBatchUploadBytes += uploadBytes;
    this.#fullSceneBatch = {
      ...key,
      bufferGeneration: this.#instanceBufferGeneration,
      drawRanges: [{ texture: options.texture!, firstInstance: 0, instanceCount: entities.length }],
      textures: [options.texture!],
    };
    this.#retainFullSceneInstancePayload(key, uploadBytes);
  }

  prepareMixedFullSceneBatch(options: PrepareMixedFullSceneBatchOptions): void {
    const { entities, selectedEntityIds, textureRanges, ...key } = options;
    if (entities.length !== key.instanceCount) {
      throw new Error("Mixed full-scene batch instance count does not match its entity payload");
    }
    if (this.hasFullSceneBatch(key)) return;

    const drawRanges: FullSceneBatchCache["drawRanges"] = [];
    let nextInstance = 0;
    for (const range of textureRanges) {
      if (range.firstInstance !== nextInstance || range.instanceCount <= 0) {
        throw new Error("Mixed full-scene texture ranges must cover entities in order");
      }
      appendTextureRange(drawRanges, range.texture, range.firstInstance, range.instanceCount);
      nextInstance += range.instanceCount;
    }
    if (nextInstance !== entities.length) {
      throw new Error("Mixed full-scene texture ranges do not cover the entity payload");
    }

    const buffer = this.#ensureInstanceCapacity(entities.length);
    for (let index = 0; index < entities.length; index++) {
      const entity = entities[index]!;
      this.#writeFullSceneInstance(
        index,
        entity,
        selectedEntityIds.has(entity.id),
        options.debugMode,
      );
      entity.textureDirty = false;
    }
    const uploadBytes = entities.length * INSTANCE_STRIDE_BYTES;
    this.#device.queue.writeBuffer(buffer, 0, this.#instanceData, 0, uploadBytes);
    this.#fullSceneBatchRebuilds += 1;
    this.#fullSceneBatchUploadBytes += uploadBytes;
    this.#fullSceneBatch = {
      ...key,
      bufferGeneration: this.#instanceBufferGeneration,
      drawRanges,
      textures: collectUniqueTextures(drawRanges),
    };
    this.#retainFullSceneInstancePayload(key, uploadBytes);
  }

  restoreFullSceneBatch(
    key: FullSceneBatchKey,
    textureRanges: readonly FullSceneTextureRange[],
  ): boolean {
    const retained = this.#retainedFullSceneInstancePayload;
    if (
      !retained ||
      retained.entityVersion !== key.entityVersion ||
      retained.geometryVersion !== key.geometryVersion ||
      retained.selectionVersion !== key.selectionVersion ||
      retained.debugMode !== key.debugMode ||
      retained.instanceCount !== key.instanceCount
    ) {
      return false;
    }

    const drawRanges: FullSceneTextureRange[] = [];
    let nextInstance = 0;
    for (const range of textureRanges) {
      if (range.firstInstance !== nextInstance || range.instanceCount <= 0) return false;
      appendTextureRange(drawRanges, range.texture, range.firstInstance, range.instanceCount);
      nextInstance += range.instanceCount;
    }
    if (nextInstance !== key.instanceCount) return false;

    const buffer = this.#ensureInstanceCapacity(key.instanceCount);
    const uploadBytes = retained.data.byteLength;
    new Uint8Array(this.#instanceData, 0, uploadBytes).set(new Uint8Array(retained.data));
    this.#device.queue.writeBuffer(buffer, 0, retained.data, 0, uploadBytes);
    this.#fullSceneBatchUploadBytes += uploadBytes;
    this.#fullSceneBatch = {
      ...key,
      bufferGeneration: this.#instanceBufferGeneration,
      drawRanges,
      textures: collectUniqueTextures(drawRanges),
    };
    return true;
  }

  patchFullSceneInstances(
    key: FullSceneBatchKey,
    patches: readonly FullSceneInstancePatch[],
  ): boolean {
    if (patches.length === 0) return false;
    const cached = this.#fullSceneBatch;
    const buffer = this.#instanceBuffer;
    if (
      !cached ||
      !buffer ||
      cached.bufferGeneration !== this.#instanceBufferGeneration ||
      cached.entityVersion !== key.entityVersion ||
      cached.selectionVersion !== key.selectionVersion ||
      cached.debugMode !== key.debugMode ||
      cached.renderWidth !== key.renderWidth ||
      cached.renderHeight !== key.renderHeight ||
      cached.texture !== key.texture ||
      cached.instanceCount !== key.instanceCount
    ) {
      return false;
    }

    let sortedPatches = patches;
    for (let index = 1; index < patches.length; index++) {
      if (patches[index - 1]!.index <= patches[index]!.index) continue;
      sortedPatches = [...patches].sort((left, right) => left.index - right.index);
      break;
    }
    let previousPatchIndex = -1;
    for (const patch of sortedPatches) {
      if (
        patch.index < 0 ||
        patch.index >= key.instanceCount ||
        patch.index === previousPatchIndex
      ) {
        return false;
      }
      previousPatchIndex = patch.index;
    }
    for (const patch of sortedPatches) {
      this.#writeFullSceneInstance(patch.index, patch.entity, patch.isSelected, key.debugMode);
    }

    for (let start = 0; start < sortedPatches.length;) {
      let end = start + 1;
      while (
        end < sortedPatches.length &&
        sortedPatches[end]!.index === sortedPatches[end - 1]!.index + 1
      ) {
        end++;
      }
      const firstIndex = sortedPatches[start]!.index;
      const byteOffset = firstIndex * INSTANCE_STRIDE_BYTES;
      const byteLength = (end - start) * INSTANCE_STRIDE_BYTES;
      this.#device.queue.writeBuffer(
        buffer,
        byteOffset,
        this.#instanceData,
        byteOffset,
        byteLength,
      );
      start = end;
    }
    this.#fullSceneBatchUploadBytes += patches.length * INSTANCE_STRIDE_BYTES;
    this.#fullSceneBatch = {
      ...key,
      bufferGeneration: this.#instanceBufferGeneration,
      drawRanges: cached.drawRanges,
      textures: cached.textures,
    };
    this.#updateRetainedFullSceneInstancePayload(cached, key, sortedPatches);
    return true;
  }

  patchMixedFullSceneBatch(
    key: FullSceneBatchKey,
    patches: readonly FullSceneBatchPatch[],
  ): boolean {
    const cached = this.#fullSceneBatch;
    const buffer = this.#instanceBuffer;
    if (
      !cached ||
      !buffer ||
      cached.bufferGeneration !== this.#instanceBufferGeneration ||
      cached.geometryVersion !== key.geometryVersion ||
      cached.debugMode !== key.debugMode ||
      cached.instanceCount !== key.instanceCount
    ) {
      return false;
    }

    let sortedPatches = patches;
    for (let index = 1; index < patches.length; index++) {
      if (patches[index - 1]!.index <= patches[index]!.index) continue;
      sortedPatches = [...patches].sort((a, b) => a.index - b.index);
      break;
    }
    let previousPatchIndex = -1;
    for (const { index } of sortedPatches) {
      if (index < 0 || index >= key.instanceCount) return false;
      if (index === previousPatchIndex) return false;
      previousPatchIndex = index;
    }

    const drawRanges: FullSceneBatchCache["drawRanges"] = [];
    let patchCursor = 0;
    for (const cachedRange of cached.drawRanges) {
      let rangeCursor = cachedRange.firstInstance;
      const rangeEnd = cachedRange.firstInstance + cachedRange.instanceCount;
      while (patchCursor < sortedPatches.length) {
        const patch = sortedPatches[patchCursor]!;
        if (patch.index >= rangeEnd) break;
        if (patch.index < rangeCursor) return false;
        if (patch.index > rangeCursor) {
          appendTextureRange(
            drawRanges,
            cachedRange.texture,
            rangeCursor,
            patch.index - rangeCursor,
          );
        }
        appendTextureRange(drawRanges, patch.texture, patch.index, 1);
        rangeCursor = patch.index + 1;
        patchCursor++;
      }
      if (rangeCursor < rangeEnd) {
        appendTextureRange(drawRanges, cachedRange.texture, rangeCursor, rangeEnd - rangeCursor);
      }
    }
    if (patchCursor !== sortedPatches.length) return false;

    for (const { index, entity, isSelected } of sortedPatches) {
      this.#writeFullSceneInstance(index, entity, isSelected, key.debugMode);
      entity.textureDirty = false;
    }
    for (let start = 0; start < sortedPatches.length;) {
      let end = start + 1;
      while (
        end < sortedPatches.length &&
        sortedPatches[end]!.index === sortedPatches[end - 1]!.index + 1
      ) {
        end++;
      }
      const firstIndex = sortedPatches[start]!.index;
      const byteOffset = firstIndex * INSTANCE_STRIDE_BYTES;
      const byteLength = (end - start) * INSTANCE_STRIDE_BYTES;
      this.#device.queue.writeBuffer(
        buffer,
        byteOffset,
        this.#instanceData,
        byteOffset,
        byteLength,
      );
      start = end;
    }
    this.#fullSceneBatchUploadBytes += patches.length * INSTANCE_STRIDE_BYTES;
    this.#fullSceneBatch = {
      ...key,
      bufferGeneration: this.#instanceBufferGeneration,
      drawRanges,
      textures: collectUniqueTextures(drawRanges),
    };
    this.#updateRetainedFullSceneInstancePayload(cached, key, sortedPatches);
    return true;
  }

  visitCachedFullSceneTextures(visitor: (texture: GPUTexture) => void): boolean {
    const cached = this.#fullSceneBatch;
    if (!cached || cached.bufferGeneration !== this.#instanceBufferGeneration) return false;
    for (const texture of cached.textures) visitor(texture);
    return true;
  }

  drawFullSceneBatch(
    pass: GPURenderPassEncoder,
    key: FullSceneBatchKey,
    dragOffset?: { x: number; y: number },
    dragScale = 1,
    dragSelectBounds: Bounds | null = null,
    dragSelectMode: DragSelectMode | null = null,
  ): boolean {
    if (!this.hasFullSceneBatch(key)) return false;
    const cached = this.#fullSceneBatch!;
    const dragOffsetX = dragOffset?.x ?? 0;
    const dragOffsetY = dragOffset?.y ?? 0;
    const hasDragTransform = dragOffsetX !== 0 || dragOffsetY !== 0 || dragScale !== 1;
    this.#writeInteractionUniforms(
      hasDragTransform ? dragOffsetX : 0,
      hasDragTransform ? dragOffsetY : 0,
      hasDragTransform ? dragScale : 0,
      dragSelectBounds,
      dragSelectMode,
    );
    this.#instanceWriteCursor = Math.max(this.#instanceWriteCursor, key.instanceCount);
    pass.setPipeline(
      hasDragTransform || dragSelectMode !== null
        ? this.#interactiveInstancedPipeline
        : this.#instancedPipeline,
    );
    for (const range of cached.drawRanges) {
      pass.setBindGroup(0, this.#getInstancedBindGroup(range.texture));
      pass.setBindGroup(1, this.crossing.bindGroup);
      pass.draw(6, range.instanceCount, 0, range.firstInstance);
    }
    return true;
  }

  drawItems(
    pass: GPURenderPassEncoder,
    items: readonly CompositionDrawItem[],
    layer: CompositionLayer = "all",
  ): void {
    if (layer === "action") this.#drawMode = "normal";
    if (!(layer === "all" ? this.crossing.hasSlices : this.crossing.hasLayerSlices)) {
      this.#drawItems(pass, items, 0);
      return;
    }
    this.#sliceLayer = layer;
    this.#slicePlan.length = 0;
    for (const item of items) {
      this.#sliceSource = item;
      this.crossing.appendSlices(item.entity.id, this.#appendSlice);
    }
    this.#sliceSource = null;
    this.#slicePlan.sort(this.#compareSlices);
    // Reserve once before recording any draw, so later slices cannot replace
    // the instance buffer already referenced by this render pass.
    // Reserve the later sharp action draws too; growing between render passes
    // would destroy an instance buffer still referenced by the scene pass.
    this.#ensureInstanceCapacity(
      this.#instanceWriteCursor + this.#slicePlan.length + (layer === "scene" ? items.length : 0),
    );
    let slice = -1;
    for (const draw of this.#slicePlan) {
      if (slice !== draw.slice && this.#sliceItem.length > 0) {
        this.#drawItems(pass, this.#sliceItem, slice);
        this.#sliceItem.length = 0;
      }
      slice = draw.slice;
      if (!draw.item) throw new Error("Crossing slice lost its source material");
      this.#sliceItem.push(draw.item);
      draw.item = null;
    }
    if (this.#sliceItem.length > 0) this.#drawItems(pass, this.#sliceItem, slice);
    this.#sliceItem.length = 0;
  }

  #drawItems(
    pass: GPURenderPassEncoder,
    items: readonly CompositionDrawItem[],
    slice: number,
  ): void {
    this.#writeInteractionUniforms(0, 0, 0, null, null);
    this.#fullSceneBatch = null;
    const firstWrittenInstance = this.#instanceWriteCursor;
    const instanceCount = this.#prepareDrawCommands(items);
    if (instanceCount > 0) {
      const uploadBytes = instanceCount * INSTANCE_STRIDE_BYTES;
      const buffer = this.#ensureInstanceCapacity(this.#instanceWriteCursor);
      this.#device.queue.writeBuffer(
        buffer,
        firstWrittenInstance * INSTANCE_STRIDE_BYTES,
        this.#instanceData,
        firstWrittenInstance * INSTANCE_STRIDE_BYTES,
        uploadBytes,
      );
      this.#normalInstanceUploadBytes += uploadBytes;
    }

    let currentPipeline: "texture" | "external" | null = null;
    for (const command of this.#drawCommands) {
      if (command.kind === "texture") {
        const texture = command.texture;
        if (!texture) continue;
        if (currentPipeline !== "texture") {
          pass.setPipeline(
            this.#drawMode === "depth"
              ? this.#depthPipelines!.texture
              : this.#drawMode === "restore"
                ? (this.#occlusion ? this.#restoreDepthPipelines! : this.#restorePipelines!).texture
                : this.#instancedPipeline,
          );
          currentPipeline = "texture";
        }
        pass.setBindGroup(0, this.#getInstancedBindGroup(texture));
        pass.setBindGroup(1, this.crossing.bindGroup);
        if (this.#drawMode === "restore") {
          const buffer = this.#proof?.find(texture) ?? this.#unprovenOpacity!;
          let cached = this.#restoreGroups.get(texture);
          if (!cached || cached.buffer !== buffer) {
            cached = {
              buffer,
              group: this.#device.createBindGroup({
                layout: this.#backdropLayout!,
                entries: [
                  { binding: 0, resource: this.#backdrop!.createView() },
                  { binding: 1, resource: { buffer } },
                ],
              }),
            };
            this.#restoreGroups.set(texture, cached);
          }
          pass.setBindGroup(2, cached.group);
        }
        pass.draw(6, command.instanceCount, slice * 6, command.firstInstance);
      } else {
        const item = command.item;
        if (!item?.bindGroup) continue;
        if (currentPipeline !== "external") {
          pass.setPipeline(
            this.#drawMode === "depth"
              ? this.#depthPipelines!.external
              : this.#drawMode === "restore"
                ? (this.#occlusion ? this.#restoreDepthPipelines! : this.#restorePipelines!)
                    .external
                : this.#externalPipeline,
          );
          currentPipeline = "external";
        }
        pass.setBindGroup(0, item.bindGroup);
        pass.setBindGroup(1, this.crossing.bindGroup);
        if (this.#drawMode === "restore") pass.setBindGroup(2, this.#backdropGroup!);
        pass.draw(6, 1, slice * 6);
      }
    }
  }

  createTextureBindGroup(
    label: string,
    textureView: GPUTextureView,
    uniformBuffer: GPUBuffer,
  ): GPUBindGroup {
    return this.#device.createBindGroup({
      label,
      layout: this.#bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: textureView },
        { binding: 3, resource: this.#sampler },
      ],
    });
  }

  writeDisintegrationUniforms(
    uniformBuffer: GPUBuffer,
    uniforms: DisintegrationCompositionUniforms,
  ): void {
    this.#entityFloatView[0] = uniforms.position.x;
    this.#entityFloatView[1] = uniforms.position.y;
    this.#entityFloatView[2] = uniforms.size.width;
    this.#entityFloatView[3] = uniforms.size.height;
    this.#entityFloatView[4] = (uniforms.rotation * Math.PI) / 180;
    this.#entityUintView[5] = 0;
    this.#entityUintView[6] = 0;
    this.#entityUintView[7] = 0;
    this.#entityFloatView[8] = 1.0;
    this.#entityFloatView[9] = uniforms.progress;
    this.#entityFloatView[10] = uniforms.seed;
    this.#entityFloatView[11] = 0;

    this.#device.queue.writeBuffer(uniformBuffer, 0, this.#entityUniformData);
  }

  drawTextureBindGroup(pass: GPURenderPassEncoder, bindGroup: GPUBindGroup): void {
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setBindGroup(1, this.crossing.bindGroup);
    pass.draw(6);
  }

  removeEntity(entityId: string): void {
    this.crossing.forget(entityId);
    const externalCached = this.#entityExternalCompositionCache.get(entityId);
    if (externalCached) {
      externalCached.uniformBuffer.destroy();
      this.#entityExternalCompositionCache.delete(entityId);
    }
  }

  destroy(): void {
    this.#proof?.destroy();
    this.#depth?.destroy();
    this.#backdrop?.destroy();
    this.#unprovenOpacity?.destroy();
    this.#opacityTable?.destroy();
    this.#proof = null;
    this.#opacityTable = null;
    this.#opacityTableBytes = 0;
    this.#unprovenOpacity = null;
    this.#backdropGroup = null;
    this.#depthView = null;
    this.#opacityTableGroup = null;
    this.#prepassInstances = null;
    this.#restoreGroups = new WeakMap();
    this.#backdropItems.length = 0;
    this.#occluderItems.length = 0;
    this.#depth = null;
    this.#backdrop = null;
    this.crossing.destroy();
    this.#slicePool.length = 0;
    this.#slicePlan.length = 0;
    this.#sliceItem.length = 0;
    this.#entityCompositionCache = new WeakMap();

    for (const cached of this.#entityExternalCompositionCache.values()) {
      cached.uniformBuffer.destroy();
    }
    this.#entityExternalCompositionCache.clear();
    this.#interactionUniformBuffer.destroy();
    this.#instanceBuffer?.destroy();
    this.#instanceBuffer = null;
    this.#instanceCapacity = 0;
    this.#instanceData = new ArrayBuffer(0);
    this.#instanceFloatView = new Float32Array(0);
    this.#instanceUintView = new Uint32Array(0);
    this.#instanceWriteCursor = 0;
    this.#instanceBufferGeneration++;
    this.#instanceBindGroupCache = new WeakMap();
    this.#drawCommands.length = 0;
    this.#fullSceneBatch = null;
    this.#retainedFullSceneInstancePayload = null;
  }

  #retainFullSceneInstancePayload(key: FullSceneBatchKey, byteLength: number): void {
    this.#retainedFullSceneInstancePayload = {
      entityVersion: key.entityVersion,
      geometryVersion: key.geometryVersion,
      selectionVersion: key.selectionVersion,
      debugMode: key.debugMode,
      instanceCount: key.instanceCount,
      data: this.#instanceData.slice(0, byteLength),
    };
  }

  #updateRetainedFullSceneInstancePayload(
    cached: FullSceneBatchCache,
    key: FullSceneBatchKey,
    patches: readonly { index: number }[],
  ): void {
    const retained = this.#retainedFullSceneInstancePayload;
    if (
      !retained ||
      retained.entityVersion !== cached.entityVersion ||
      retained.geometryVersion !== cached.geometryVersion ||
      retained.selectionVersion !== cached.selectionVersion ||
      retained.debugMode !== cached.debugMode ||
      retained.instanceCount !== cached.instanceCount
    ) {
      return;
    }
    const retainedBytes = new Uint8Array(retained.data);
    const instanceBytes = new Uint8Array(this.#instanceData);
    for (const { index } of patches) {
      const byteOffset = index * INSTANCE_STRIDE_BYTES;
      retainedBytes.set(
        instanceBytes.subarray(byteOffset, byteOffset + INSTANCE_STRIDE_BYTES),
        byteOffset,
      );
    }
    retained.entityVersion = key.entityVersion;
    retained.geometryVersion = key.geometryVersion;
    retained.selectionVersion = key.selectionVersion;
    retained.debugMode = key.debugMode;
  }

  #prepareDrawCommands(items: readonly CompositionDrawItem[]): number {
    let commandCount = 0;
    let instanceCount = 0;
    const firstInstance = this.#instanceWriteCursor;

    for (const item of items) {
      if (item.pipeline === "texture") {
        const texture = item.texture;
        if (!texture) continue;
        if (instanceCount === 0) this.#ensureInstanceCapacity(firstInstance + items.length);
        const instanceIndex = firstInstance + instanceCount;
        this.#writeInstance(instanceIndex, item);

        const previous = commandCount > 0 ? this.#drawCommands[commandCount - 1] : undefined;
        if (
          previous?.kind === "texture" &&
          previous.texture === texture &&
          previous.item === null
        ) {
          previous.instanceCount++;
        } else {
          const command = this.#getDrawCommand(commandCount++);
          command.kind = "texture";
          command.texture = texture;
          command.firstInstance = instanceIndex;
          command.instanceCount = 1;
          command.item = null;
        }
        instanceCount++;
        continue;
      }

      const command = this.#getDrawCommand(commandCount++);
      command.kind = "external";
      command.texture = null;
      command.firstInstance = 0;
      command.instanceCount = 1;
      command.item = item;
    }

    this.#drawCommands.length = commandCount;
    this.#instanceWriteCursor += instanceCount;
    return instanceCount;
  }

  #getDrawCommand(index: number): CompositionDrawCommand {
    let command = this.#drawCommands[index];
    if (command) return command;
    command = {
      kind: "texture",
      texture: null,
      firstInstance: 0,
      instanceCount: 0,
      item: null,
    };
    this.#drawCommands[index] = command;
    return command;
  }

  #ensureInstanceCapacity(required: number): GPUBuffer {
    if (this.#instanceBuffer && required <= this.#instanceCapacity) return this.#instanceBuffer;

    let capacity = Math.max(INITIAL_INSTANCE_CAPACITY, this.#instanceCapacity || 1);
    while (capacity < required) capacity *= 2;
    const byteSize = capacity * INSTANCE_STRIDE_BYTES;
    if (byteSize > this.#device.limits.maxStorageBufferBindingSize) {
      throw new Error(
        `Instanced composition requires ${byteSize} bytes, exceeding maxStorageBufferBindingSize`,
      );
    }

    const nextBuffer = this.#device.createBuffer({
      label: `Composition instances (${capacity})`,
      size: byteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#instanceBuffer?.destroy();
    this.#instanceBuffer = nextBuffer;
    this.#instanceCapacity = capacity;
    this.#instanceBufferGeneration++;
    this.#instanceData = new ArrayBuffer(byteSize);
    this.#instanceFloatView = new Float32Array(this.#instanceData);
    this.#instanceUintView = new Uint32Array(this.#instanceData);
    this.#instanceBindGroupCache = new WeakMap();
    this.#fullSceneBatch = null;
    return nextBuffer;
  }

  #writeFullSceneInstance(
    index: number,
    entity: ShaderCanvasEntity,
    isSelected: boolean,
    debugMode: boolean,
  ): void {
    const offset = index * INSTANCE_STRIDE_VALUES;
    this.#instanceFloatView[offset] = entity.position.x;
    this.#instanceFloatView[offset + 1] = entity.position.y;
    this.#instanceFloatView[offset + 2] = entity.size.width;
    this.#instanceFloatView[offset + 3] = entity.size.height;
    this.#instanceUintView[offset + 4] = packInstanceState(entity, isSelected, debugMode, 1);
    this.#instanceUintView[offset + 5] = this.crossing.key(entity.id);
  }

  #writeInstance(index: number, item: CompositionDrawItem): void {
    const offset = index * INSTANCE_STRIDE_VALUES;
    const entity = item.entity;
    this.#instanceFloatView[offset] = entity.position.x + item.offsetX;
    this.#instanceFloatView[offset + 1] = entity.position.y + item.offsetY;
    this.#instanceFloatView[offset + 2] = entity.size.width;
    this.#instanceFloatView[offset + 3] = entity.size.height;
    this.#instanceUintView[offset + 4] = packInstanceState(
      entity,
      item.isSelected,
      item.debugMode,
      item.visualScale,
    );
    this.#instanceUintView[offset + 5] = this.crossing.key(entity.id);
  }

  #getInstancedBindGroup(texture: GPUTexture): GPUBindGroup {
    const cached = this.#instanceBindGroupCache.get(texture);
    if (cached) return cached;
    if (!this.#instanceBuffer) throw new Error("Instanced composition buffer is unavailable");

    const bindGroup = this.#device.createBindGroup({
      label: "Instanced composition bind group",
      layout: this.#instancedBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
        { binding: 1, resource: { buffer: this.#instanceBuffer } },
        { binding: 2, resource: this.#getTextureView(texture) },
        { binding: 3, resource: this.#sampler },
        { binding: 4, resource: { buffer: this.#interactionUniformBuffer } },
      ],
    });
    this.#instanceBindGroupCache.set(texture, bindGroup);
    return bindGroup;
  }

  #writeInteractionUniforms(
    offsetX: number,
    offsetY: number,
    scale: number,
    selectionBounds: Bounds | null,
    selectionMode: DragSelectMode | null,
  ): void {
    const selectionModeValue = getDragSelectModeValue(selectionMode);
    const selectionX = selectionBounds?.x ?? 0;
    const selectionY = selectionBounds?.y ?? 0;
    const selectionWidth = selectionBounds?.width ?? 0;
    const selectionHeight = selectionBounds?.height ?? 0;
    if (
      offsetX === this.#interactionOffsetX &&
      offsetY === this.#interactionOffsetY &&
      scale === this.#interactionScale &&
      selectionModeValue === this.#interactionSelectionMode &&
      selectionX === this.#interactionSelectionX &&
      selectionY === this.#interactionSelectionY &&
      selectionWidth === this.#interactionSelectionWidth &&
      selectionHeight === this.#interactionSelectionHeight
    ) {
      return;
    }
    this.#interactionOffsetX = offsetX;
    this.#interactionOffsetY = offsetY;
    this.#interactionScale = scale;
    this.#interactionSelectionMode = selectionModeValue;
    this.#interactionSelectionX = selectionX;
    this.#interactionSelectionY = selectionY;
    this.#interactionSelectionWidth = selectionWidth;
    this.#interactionSelectionHeight = selectionHeight;
    this.#interactionUniformFloats[0] = offsetX;
    this.#interactionUniformFloats[1] = offsetY;
    this.#interactionUniformFloats[2] = scale;
    this.#interactionUniformUints[3] = selectionModeValue;
    this.#interactionUniformFloats[4] = selectionX;
    this.#interactionUniformFloats[5] = selectionY;
    this.#interactionUniformFloats[6] = selectionWidth;
    this.#interactionUniformFloats[7] = selectionHeight;
    this.#device.queue.writeBuffer(this.#interactionUniformBuffer, 0, this.#interactionUniformData);
  }

  #writeLiveEntityUniforms(
    uniformBuffer: GPUBuffer,
    options: PrepareCompositionItemOptions,
    previous?: CompositionUniformState,
  ): CompositionUniformState {
    const { entity, isSelected, debugMode, positionOffsetX, positionOffsetY, visualScale } =
      options;
    const positionX = entity.position.x;
    const positionY = entity.position.y;
    const width = entity.size.width;
    const height = entity.size.height;
    const rotation = entity.rotation;
    if (
      previous &&
      previous.positionX === positionX &&
      previous.positionY === positionY &&
      previous.width === width &&
      previous.height === height &&
      previous.rotation === rotation &&
      previous.isSelected === isSelected &&
      previous.debugMode === debugMode &&
      previous.positionOffsetX === positionOffsetX &&
      previous.positionOffsetY === positionOffsetY &&
      previous.visualScale === visualScale
    ) {
      return previous;
    }

    this.#entityFloatView[0] = positionX + positionOffsetX;
    this.#entityFloatView[1] = positionY + positionOffsetY;
    this.#entityFloatView[2] = width;
    this.#entityFloatView[3] = height;
    this.#entityFloatView[4] = (rotation * Math.PI) / 180;
    this.#entityUintView[5] = this.crossing.key(entity.id);
    this.#entityUintView[6] = isSelected ? 1 : 0;
    this.#entityUintView[7] = debugMode ? 1 : 0;
    this.#entityFloatView[8] = visualScale;
    this.#entityFloatView[9] = 0;
    this.#entityFloatView[10] = 0;
    this.#entityFloatView[11] = 0;

    this.#device.queue.writeBuffer(uniformBuffer, 0, this.#entityUniformData);

    const current = previous ?? {
      positionX,
      positionY,
      width,
      height,
      rotation,
      isSelected,
      debugMode,
      positionOffsetX,
      positionOffsetY,
      visualScale,
    };
    current.positionX = positionX;
    current.positionY = positionY;
    current.width = width;
    current.height = height;
    current.rotation = rotation;
    current.isSelected = isSelected;
    current.debugMode = debugMode;
    current.positionOffsetX = positionOffsetX;
    current.positionOffsetY = positionOffsetY;
    current.visualScale = visualScale;
    return current;
  }

  #getTextureView(texture: GPUTexture): GPUTextureView {
    const cached = this.#textureViewCache.get(texture);
    if (cached) return cached;
    const view = texture.createView();
    this.#textureViewCache.set(texture, view);
    return view;
  }
}
