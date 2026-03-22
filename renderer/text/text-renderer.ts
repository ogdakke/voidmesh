import { Font } from "text-shaper";
import { prepareText } from "./slug.ts";
import vertexShaderSource from "./text-vertex.wgsl?raw";
import fragmentShaderSource from "./text-fragment.wgsl?raw";

const TEX_WIDTH = 4096;
const MAX_SLUG_CACHE_BYTES = 32 * 1024 * 1024;

/** Uniform buffer offset alignment required by WebGPU (256 bytes on most GPUs). */
const UNIFORM_ALIGN = 256;
/** Number of f32 elements per aligned uniform slot (256 / 4). */
const UNIFORM_SLOT_FLOATS = UNIFORM_ALIGN / Float32Array.BYTES_PER_ELEMENT;
/** Maximum text items per frame batch. */
const MAX_TEXT_BATCH = 256;

interface TextViewport {
  offsetX: number;
  offsetY: number;
  zoom: number;
  width: number;
  height: number;
}

interface TextItem {
  text: string | null;
  slugData?: ReturnType<typeof prepareText>;
  worldX: number;
  worldY: number;
  fontSize: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

interface CachedSlugResources {
  cacheKey: string;
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  curveTexture: GPUTexture;
  curveTextureView: GPUTextureView;
  bandTexture: GPUTexture;
  bandTextureView: GPUTextureView;
  indexCount: number;
  bytes: number;
  bindGroup: GPUBindGroup | null;
}

/**
 * GPU text renderer using the Slug algorithm.
 * Renders resolution-independent vector text directly in the WebGPU pipeline.
 *
 * Usage per frame:
 *   textRenderer.begin()
 *   textRenderer.drawText("Label", worldX, worldY, 14, 1, 1, 1, 1)
 *   textRenderer.flush(pass)
 */
export class TextRenderer {
  #device: GPUDevice;
  #canvasFormat: GPUTextureFormat;

  #pipeline: GPURenderPipeline | null = null;
  #bindGroupLayout: GPUBindGroupLayout | null = null;
  #font: Font | null = null;
  #ready = false;
  #viewport: TextViewport | null = null;

  // Batched uniform staging
  #batchUniformData = new ArrayBuffer(MAX_TEXT_BATCH * UNIFORM_ALIGN);
  #batchF32View = new Float32Array(this.#batchUniformData);
  #batchUniformBuffer: GPUBuffer | null = null;

  // Per-frame text queue
  #queue: TextItem[] = [];

  // GPU resources kept alive between begin() and next begin()
  #slugResourceCache = new Map<string, CachedSlugResources>();
  #slugCacheBytes = 0;

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat) {
    this.#device = device;
    this.#canvasFormat = canvasFormat;
  }

  async initialize(): Promise<void> {
    const fontData = await fetch("/Inter.ttf").then((r) => r.arrayBuffer());
    this.#font = Font.load(fontData);

    this.#batchUniformBuffer = this.#device.createBuffer({
      label: "Text batch uniform buffer",
      size: MAX_TEXT_BATCH * UNIFORM_ALIGN,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
      label: "Text bind group layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform", hasDynamicOffset: true },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "unfilterable-float" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "uint" },
        },
      ],
    });

    const vertexModule = this.#device.createShaderModule({
      label: "Text vertex shader",
      code: vertexShaderSource,
    });
    const fragmentModule = this.#device.createShaderModule({
      label: "Text fragment shader",
      code: fragmentShaderSource,
    });

    this.#pipeline = this.#device.createRenderPipeline({
      label: "Text render pipeline",
      layout: this.#device.createPipelineLayout({
        bindGroupLayouts: [this.#bindGroupLayout],
      }),
      vertex: {
        module: vertexModule,
        entryPoint: "main",
        buffers: [
          {
            arrayStride: 80,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" as const },
              { shaderLocation: 1, offset: 16, format: "float32x4" as const },
              { shaderLocation: 2, offset: 32, format: "float32x4" as const },
              { shaderLocation: 3, offset: 48, format: "float32x4" as const },
              { shaderLocation: 4, offset: 64, format: "float32x4" as const },
            ],
          },
        ],
      },
      fragment: {
        module: fragmentModule,
        entryPoint: "main",
        targets: [
          {
            format: this.#canvasFormat,
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
      primitive: { topology: "triangle-list" },
    });

    this.#ready = true;
  }

  get isReady(): boolean {
    return this.#ready;
  }

  /** The loaded font instance, or null if not yet initialized. */
  get font(): Font | null {
    return this.#font;
  }

  setViewport(viewport: TextViewport): void {
    this.#viewport = viewport;
  }

  /** Clear the text queue for a new frame. */
  begin(): void {
    this.#evictSlugResources();
    this.#currentTextIndex = 0;
    this.#queue.length = 0;
  }

  /** Queue text to be drawn at a world-space position. */
  drawText(
    textOrSlugData: string | ReturnType<typeof prepareText>,
    worldX: number,
    worldY: number,
    fontSize: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    if (!this.#ready) return;
    if (typeof textOrSlugData === "string") {
      if (textOrSlugData.length === 0) return;
      this.#queue.push({ text: textOrSlugData, worldX, worldY, fontSize, r, g, b, a });
    } else {
      this.#queue.push({
        text: null,
        slugData: textOrSlugData,
        worldX,
        worldY,
        fontSize,
        r,
        g,
        b,
        a,
      });
    }
  }

  /** Build GPU buffers from queued text and draw into the provided render pass. */
  flush(pass: GPURenderPassEncoder): void {
    if (
      !this.#ready ||
      !this.#font ||
      !this.#pipeline ||
      !this.#batchUniformBuffer ||
      this.#queue.length === 0
    )
      return;

    // Prepare all uniform data into the staging buffer
    const drawCalls: { resources: CachedSlugResources; slotIndex: number }[] = [];
    for (let i = 0; i < this.#queue.length; i++) {
      const result = this.#prepareItem(this.#queue[i]!);
      if (result) drawCalls.push(result);
    }

    if (drawCalls.length === 0) {
      this.#queue.length = 0;
      return;
    }

    // Single writeBuffer for all text uniforms
    this.#device.queue.writeBuffer(
      this.#batchUniformBuffer,
      0,
      this.#batchUniformData,
      0,
      this.#currentTextIndex * UNIFORM_ALIGN,
    );

    pass.setPipeline(this.#pipeline);

    for (let i = 0; i < drawCalls.length; i++) {
      const { resources, slotIndex } = drawCalls[i]!;
      const bindGroup = this.#getTextBindGroup(resources);
      pass.setBindGroup(0, bindGroup, [slotIndex * UNIFORM_ALIGN]);
      pass.setVertexBuffer(0, resources.vertexBuffer);
      pass.setIndexBuffer(resources.indexBuffer, "uint32");
      pass.drawIndexed(resources.indexCount);
    }
    this.#queue.length = 0;
  }

  #prepareItem(item: TextItem): { resources: CachedSlugResources; slotIndex: number } | null {
    if (!this.#viewport || !this.#font) return null;
    if (this.#currentTextIndex >= MAX_TEXT_BATCH) return null;

    const slugData = item.slugData ?? prepareText(this.#font, item.text!, item.fontSize);
    if (slugData.indices.length === 0) return null;

    const scale = this.#font.scaleForSize(item.fontSize);
    const totalWidth = slugData.totalAdvance * scale;
    const descender = this.#font.descender * scale;

    // Position: centered horizontally on worldX
    const offsetX = item.worldX - totalWidth / 2;
    // Keep the vendor Y-up local glyph space intact and bake the placement into the
    // Slug MVP matrix. worldY denotes the bottom text edge in world-space coordinates.
    const offsetY = item.worldY + descender;

    const sx = (2 * this.#viewport.zoom) / this.#viewport.width;
    const sy = (-2 * this.#viewport.zoom) / this.#viewport.height;
    const tx = sx * offsetX - this.#viewport.offsetX * sx - 1;
    const ty = sy * offsetY - this.#viewport.offsetY * sy + 1;

    const slotIndex = this.#currentTextIndex++;
    const floatOffset = slotIndex * UNIFORM_SLOT_FLOATS;
    const f = this.#batchF32View;

    f[floatOffset] = sx;
    f[floatOffset + 1] = 0;
    f[floatOffset + 2] = 0;
    f[floatOffset + 3] = tx;
    f[floatOffset + 4] = 0;
    f[floatOffset + 5] = -sy;
    f[floatOffset + 6] = 0;
    f[floatOffset + 7] = ty;
    f[floatOffset + 8] = 0;
    f[floatOffset + 9] = 0;
    f[floatOffset + 10] = 0;
    f[floatOffset + 11] = 0;
    f[floatOffset + 12] = 0;
    f[floatOffset + 13] = 0;
    f[floatOffset + 14] = 0;
    f[floatOffset + 15] = 1;
    f[floatOffset + 16] = this.#viewport.width;
    f[floatOffset + 17] = this.#viewport.height;
    f[floatOffset + 18] = 0;
    f[floatOffset + 19] = 0;
    f[floatOffset + 20] = item.r;
    f[floatOffset + 21] = item.g;
    f[floatOffset + 22] = item.b;
    f[floatOffset + 23] = item.a;

    const resources = this.#getOrCreateSlugResources(slugData);
    return { resources, slotIndex };
  }

  #getOrCreateSlugResources(slugData: ReturnType<typeof prepareText>): CachedSlugResources {
    const cacheKey = slugData.cacheKey;
    const cached = this.#slugResourceCache.get(cacheKey);
    if (cached) {
      this.#slugResourceCache.delete(cacheKey);
      this.#slugResourceCache.set(cacheKey, cached);
      return cached;
    }

    const vertexBuffer = this.#device.createBuffer({
      label: "Text vertex buffer",
      size: slugData.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(vertexBuffer, 0, slugData.vertices);

    const indexBuffer = this.#device.createBuffer({
      label: "Text index buffer",
      size: slugData.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(indexBuffer, 0, slugData.indices);

    const curveTexture = this.#device.createTexture({
      label: "Text curve texture",
      size: { width: TEX_WIDTH, height: slugData.curveTexHeight },
      format: "rgba32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#device.queue.writeTexture(
      { texture: curveTexture },
      slugData.curveTexData,
      { bytesPerRow: TEX_WIDTH * 16 },
      { width: TEX_WIDTH, height: slugData.curveTexHeight },
    );

    const bandTexture = this.#device.createTexture({
      label: "Text band texture",
      size: { width: TEX_WIDTH, height: slugData.bandTexHeight },
      format: "rgba32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.#device.queue.writeTexture(
      { texture: bandTexture },
      slugData.bandTexData,
      { bytesPerRow: TEX_WIDTH * 16 },
      { width: TEX_WIDTH, height: slugData.bandTexHeight },
    );

    const curveTextureView = curveTexture.createView();
    const bandTextureView = bandTexture.createView();

    const resources: CachedSlugResources = {
      cacheKey,
      vertexBuffer,
      indexBuffer,
      curveTexture,
      curveTextureView,
      bandTexture,
      bandTextureView,
      indexCount: slugData.indices.length,
      bytes:
        slugData.vertices.byteLength +
        slugData.indices.byteLength +
        TEX_WIDTH * slugData.curveTexHeight * 16 +
        TEX_WIDTH * slugData.bandTexHeight * 16,
      bindGroup: null,
    };

    this.#slugResourceCache.set(cacheKey, resources);
    this.#slugCacheBytes += resources.bytes;
    this.#evictSlugResources(cacheKey);
    return resources;
  }

  destroy(): void {
    this.#batchUniformBuffer?.destroy();
    this.#batchUniformBuffer = null;
    for (const resource of this.#slugResourceCache.values()) {
      this.#destroySlugResources(resource);
    }
    this.#slugResourceCache.clear();
    this.#slugCacheBytes = 0;
    this.#pipeline = null;
    this.#bindGroupLayout = null;
    this.#font = null;
    this.#ready = false;
  }

  #evictSlugResources(preserveKey?: string): void {
    if (this.#slugCacheBytes <= MAX_SLUG_CACHE_BYTES) return;

    for (const [cacheKey, resource] of this.#slugResourceCache) {
      if (this.#slugCacheBytes <= MAX_SLUG_CACHE_BYTES) break;
      if (cacheKey === preserveKey) continue;
      this.#destroySlugResources(resource);
      this.#slugResourceCache.delete(cacheKey);
      this.#slugCacheBytes -= resource.bytes;
    }
  }

  #destroySlugResources(resource: CachedSlugResources): void {
    resource.vertexBuffer.destroy();
    resource.indexBuffer.destroy();
    resource.curveTexture.destroy();
    resource.bandTexture.destroy();
    resource.bindGroup = null;
  }

  #currentTextIndex = 0;

  #getTextBindGroup(resources: CachedSlugResources): GPUBindGroup {
    // One bind group per slug resource — dynamic offset selects the uniform slot.
    const cached = resources.bindGroup;
    if (cached) return cached;

    const bindGroup = this.#device.createBindGroup({
      label: "Text bind group",
      layout: this.#bindGroupLayout!,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.#batchUniformBuffer!,
            size: UNIFORM_ALIGN,
          },
        },
        { binding: 1, resource: resources.curveTextureView },
        { binding: 2, resource: resources.bandTextureView },
      ],
    });
    resources.bindGroup = bindGroup;
    return bindGroup;
  }
}
