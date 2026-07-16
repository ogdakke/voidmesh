import { config } from "#config";
import type { DragSelectMode } from "#engine";
import type { Bounds, ShaderCanvasEntity } from "#types/canvas.ts";
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

const INSTANCE_STRIDE_BYTES = 32;
const INSTANCE_STRIDE_VALUES = INSTANCE_STRIDE_BYTES / 4;
const INITIAL_INSTANCE_CAPACITY = 256;
const INSTANCE_FLAG_DEBUG = 1;
const INSTANCE_FLAG_LOCKED = 2;

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

function getInstanceFlags(entity: ShaderCanvasEntity, debugMode: boolean): number {
  return (debugMode ? INSTANCE_FLAG_DEBUG : 0) | (entity.locked ? INSTANCE_FLAG_LOCKED : 0);
}

function createExternalCompositionShaderSource(source: string): string {
  const rewritten = source
    .replace(
      /@group\(0\)\s+@binding\(2\)\s+var\s+entityTexture\s*:\s*texture_2d<f32>;/,
      "@group(0) @binding(2) var entityTexture: texture_external;",
    )
    .replace(
      /textureSample\(entityTexture,\s*entitySampler,/g,
      "textureSampleBaseClampToEdge(entityTexture, entitySampler,",
    );

  if (rewritten === source || !rewritten.includes("texture_external")) {
    throw new Error("Failed to rewrite composition shader source for external texture input.");
  }
  return rewritten;
}

export class CompositionPass {
  readonly #device: GPUDevice;
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
    this.#device = options.device;
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
          visibility: GPUShaderStage.VERTEX,
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
      bindGroupLayouts: [this.#bindGroupLayout],
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
      bindGroupLayouts: [this.#instancedBindGroupLayout],
    });
    this.#instancedPipeline = this.#device.createRenderPipeline({
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
    });
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
      bindGroupLayouts: [this.#externalBindGroupLayout],
    });

    this.#externalPipeline = this.#device.createRenderPipeline({
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
    });
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
    this.#instanceWriteCursor = 0;
    if (maximumInstanceCount > 0) this.#ensureInstanceCapacity(maximumInstanceCount);
  }

  getStats(): CompositionPassStats {
    return {
      fullSceneBatchRebuilds: this.#fullSceneBatchRebuilds,
      fullSceneBatchUploadBytes: this.#fullSceneBatchUploadBytes,
      normalInstanceUploadBytes: this.#normalInstanceUploadBytes,
    };
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
      pass.draw(6, range.instanceCount, 0, range.firstInstance);
    }
    return true;
  }

  drawItems(pass: GPURenderPassEncoder, items: readonly CompositionDrawItem[]): void {
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
          pass.setPipeline(this.#instancedPipeline);
          currentPipeline = "texture";
        }
        pass.setBindGroup(0, this.#getInstancedBindGroup(texture));
        pass.draw(6, command.instanceCount, 0, command.firstInstance);
      } else {
        const item = command.item;
        if (!item?.bindGroup) continue;
        if (currentPipeline !== "external") {
          pass.setPipeline(this.#externalPipeline);
          currentPipeline = "external";
        }
        pass.setBindGroup(0, item.bindGroup);
        pass.draw(6);
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
    pass.draw(6);
  }

  removeEntity(entityId: string): void {
    const externalCached = this.#entityExternalCompositionCache.get(entityId);
    if (externalCached) {
      externalCached.uniformBuffer.destroy();
      this.#entityExternalCompositionCache.delete(entityId);
    }
  }

  destroy(): void {
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
    this.#instanceFloatView[offset + 4] = (entity.rotation * Math.PI) / 180;
    this.#instanceUintView[offset + 5] = isSelected ? 1 : 0;
    this.#instanceUintView[offset + 6] = getInstanceFlags(entity, debugMode);
    this.#instanceFloatView[offset + 7] = 1;
  }

  #writeInstance(index: number, item: CompositionDrawItem): void {
    const offset = index * INSTANCE_STRIDE_VALUES;
    const entity = item.entity;
    this.#instanceFloatView[offset] = entity.position.x + item.offsetX;
    this.#instanceFloatView[offset + 1] = entity.position.y + item.offsetY;
    this.#instanceFloatView[offset + 2] = entity.size.width;
    this.#instanceFloatView[offset + 3] = entity.size.height;
    this.#instanceFloatView[offset + 4] = (entity.rotation * Math.PI) / 180;
    this.#instanceUintView[offset + 5] = item.isSelected ? 1 : 0;
    this.#instanceUintView[offset + 6] = getInstanceFlags(entity, item.debugMode);
    this.#instanceFloatView[offset + 7] = item.visualScale;
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
    this.#entityUintView[5] = 0;
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
