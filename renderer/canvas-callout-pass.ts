import type { CanvasCallout, ShaderCanvasEntity, Viewport } from "#types/canvas.ts";
import shaderSource from "./entity-label.wgsl?raw";

const FONT_SIZE_DESKTOP = 15;
const FONT_SIZE_MOBILE = 13;
const PADDING_X = 10;
const PADDING_Y = 7;
const MAX_TEXT_WIDTH_DESKTOP = 300;
const MAX_TEXT_WIDTH_MOBILE = 230;
const LINE_HEIGHT = 1.25;
const ENTITY_GAP = 12;
const SHADOW_PAD = 8;
const UNIFORM_SIZE = 32;
const MOBILE_BREAKPOINT = 768;
const FONT_FAMILY =
  'ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, "Arial Rounded MT", Calibri, system-ui, sans-serif';

interface CalloutRasterState {
  text: string;
  dpr: number;
  isMobile: boolean;
}

interface CalloutCacheEntry {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  uniformBuffer: GPUBuffer;
  textureWidth: number;
  textureHeight: number;
  rasterState: CalloutRasterState;
}

export class CanvasCalloutPass {
  #device: GPUDevice;
  #canvasFormat: GPUTextureFormat;
  #viewportUniformBuffer: GPUBuffer;
  #pipeline: GPURenderPipeline | null = null;
  #sampler: GPUSampler | null = null;
  #bindGroupLayout: GPUBindGroupLayout | null = null;
  #canvas = new OffscreenCanvas(1, 1);
  #ctx = this.#canvas.getContext("2d")!;
  #cache = new Map<string, CalloutCacheEntry>();
  #viewport: Viewport | null = null;
  #dpr = 1;
  #isMobile = false;
  readonly #activeIds = new Set<string>();
  readonly #uniformData = new Float32Array(UNIFORM_SIZE / 4);
  readonly #resolvedPosition = { x: 0, y: 0 };

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat, viewportUniformBuffer: GPUBuffer) {
    this.#device = device;
    this.#canvasFormat = canvasFormat;
    this.#viewportUniformBuffer = viewportUniformBuffer;
  }

  initialize(): void {
    this.#sampler = this.#device.createSampler({
      label: "Canvas callout sampler",
      magFilter: "linear",
      minFilter: "linear",
    });

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
      label: "Canvas callout bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });

    const shaderModule = this.#device.createShaderModule({
      label: "Canvas callout shader",
      code: shaderSource,
    });

    this.#pipeline = this.#device.createRenderPipeline({
      label: "Canvas callout pipeline",
      layout: this.#device.createPipelineLayout({
        bindGroupLayouts: [this.#bindGroupLayout],
      }),
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.#canvasFormat,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  beginFrame(viewport: Viewport, canvasWidth: number): void {
    this.#viewport = viewport;
    this.#dpr = devicePixelRatio || 1;
    this.#isMobile = canvasWidth / this.#dpr < MOBILE_BREAKPOINT;
  }

  drawCallouts(
    pass: GPURenderPassEncoder,
    callouts: readonly CanvasCallout[],
    entities: readonly ShaderCanvasEntity[],
    entityIndices: ReadonlyMap<string, number>,
  ): void {
    if (!this.#pipeline || !this.#viewport) return;

    const activeIds = this.#activeIds;
    activeIds.clear();
    for (const callout of callouts) {
      activeIds.add(callout.id);
      const entry = this.#getEntry(callout);
      const position = this.#resolveWorldPosition(callout, entry, entities, entityIndices);
      if (!position) continue;

      const data = this.#uniformData;
      data[0] = position.x;
      data[1] = position.y;
      data[2] = entry.textureWidth / this.#viewport.zoom;
      data[3] = entry.textureHeight / this.#viewport.zoom;
      data[4] = 1;
      this.#device.queue.writeBuffer(entry.uniformBuffer, 0, data);

      pass.setPipeline(this.#pipeline);
      pass.setBindGroup(0, entry.bindGroup);
      pass.draw(6);
    }

    for (const [id, entry] of this.#cache) {
      if (activeIds.has(id)) continue;
      entry.texture.destroy();
      entry.uniformBuffer.destroy();
      this.#cache.delete(id);
    }
  }

  destroy(): void {
    for (const entry of this.#cache.values()) {
      entry.texture.destroy();
      entry.uniformBuffer.destroy();
    }
    this.#cache.clear();
    this.#pipeline = null;
  }

  #resolveWorldPosition(
    callout: CanvasCallout,
    entry: CalloutCacheEntry,
    entities: readonly ShaderCanvasEntity[],
    entityIndices: ReadonlyMap<string, number>,
  ): { x: number; y: number } | null {
    const viewport = this.#viewport;
    if (!viewport) return null;

    const worldWidth = entry.textureWidth / viewport.zoom;
    const worldHeight = entry.textureHeight / viewport.zoom;
    const offsetX = ((callout.offset?.x ?? 0) * this.#dpr) / viewport.zoom;
    const offsetY = ((callout.offset?.y ?? 0) * this.#dpr) / viewport.zoom;

    if (callout.anchor.type === "screen") {
      const x = viewport.offset.x + (callout.anchor.position.x * this.#dpr) / viewport.zoom;
      const y = viewport.offset.y + (callout.anchor.position.y * this.#dpr) / viewport.zoom;
      const result = this.#resolvedPosition;
      result.x = x - (callout.anchor.align === "center" ? worldWidth / 2 : 0) + offsetX;
      result.y = y + offsetY;
      return result;
    }

    const entityIndex = entityIndices.get(callout.anchor.entityId);
    const entity = entityIndex === undefined ? undefined : entities[entityIndex];
    if (!entity) return null;

    const x = entity.position.x + entity.size.width / 2 - worldWidth / 2 + offsetX;
    const result = this.#resolvedPosition;
    result.x = x;
    if (callout.anchor.placement === "top") {
      result.y =
        entity.position.y - (ENTITY_GAP * this.#dpr) / viewport.zoom - worldHeight + offsetY;
      return result;
    }

    result.y =
      entity.position.y + entity.size.height + (ENTITY_GAP * this.#dpr) / viewport.zoom + offsetY;
    return result;
  }

  #getEntry(callout: CanvasCallout): CalloutCacheEntry {
    const rasterState = {
      text: callout.text,
      dpr: this.#dpr,
      isMobile: this.#isMobile,
    };
    const cached = this.#cache.get(callout.id);
    if (cached && rasterStatesEqual(cached.rasterState, rasterState)) return cached;
    return this.#rasterizeCallout(callout.id, rasterState);
  }

  #rasterizeCallout(id: string, rasterState: CalloutRasterState): CalloutCacheEntry {
    const { width, height } = this.#rasterize(rasterState);
    let cached = this.#cache.get(id);

    if (!cached || cached.textureWidth !== width || cached.textureHeight !== height) {
      cached?.texture.destroy();
      cached?.uniformBuffer.destroy();
      cached = this.#createEntry(id, width, height, rasterState);
      this.#cache.set(id, cached);
    } else {
      cached.rasterState = rasterState;
    }

    this.#device.queue.copyExternalImageToTexture(
      { source: this.#canvas },
      { texture: cached.texture },
      [width, height],
    );

    return cached;
  }

  #createEntry(
    id: string,
    width: number,
    height: number,
    rasterState: CalloutRasterState,
  ): CalloutCacheEntry {
    const texture = this.#device.createTexture({
      label: `Canvas callout ${id}`,
      size: [width, height],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const uniformBuffer = this.#device.createBuffer({
      label: `Canvas callout ${id} uniforms`,
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroup = this.#device.createBindGroup({
      label: `Canvas callout ${id} bind group`,
      layout: this.#bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: texture.createView() },
        { binding: 3, resource: this.#sampler! },
      ],
    });

    return {
      texture,
      bindGroup,
      uniformBuffer,
      textureWidth: width,
      textureHeight: height,
      rasterState,
    };
  }

  #rasterize(rasterState: CalloutRasterState): { width: number; height: number } {
    const { text, dpr, isMobile } = rasterState;
    const ctx = this.#ctx;
    const fontSize = (isMobile ? FONT_SIZE_MOBILE : FONT_SIZE_DESKTOP) * dpr;
    const lineHeight = fontSize * LINE_HEIGHT;
    const paddingX = PADDING_X * dpr;
    const paddingY = PADDING_Y * dpr;
    const maxTextWidth = (isMobile ? MAX_TEXT_WIDTH_MOBILE : MAX_TEXT_WIDTH_DESKTOP) * dpr;
    const font = `600 ${fontSize}px ${FONT_FAMILY}`;

    ctx.font = font;
    const lines = wrapText(ctx, text, maxTextWidth);
    const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const boxWidth = Math.ceil(textWidth + paddingX * 2);
    const boxHeight = Math.ceil(lines.length * lineHeight + paddingY * 2);
    const canvasWidth = boxWidth + SHADOW_PAD * dpr * 2;
    const canvasHeight = boxHeight + SHADOW_PAD * dpr * 2;

    if (this.#canvas.width !== canvasWidth || this.#canvas.height !== canvasHeight) {
      this.#canvas.width = canvasWidth;
      this.#canvas.height = canvasHeight;
    }

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.font = font;
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.28)";
    ctx.shadowBlur = 5 * dpr;
    ctx.shadowOffsetY = 2 * dpr;
    ctx.fillStyle = "rgba(16, 20, 22, 0.92)";
    ctx.beginPath();
    ctx.roundRect(SHADOW_PAD * dpr, SHADOW_PAD * dpr, boxWidth, boxHeight, 8 * dpr);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.roundRect(
      SHADOW_PAD * dpr + 0.5 * dpr,
      SHADOW_PAD * dpr + 0.5 * dpr,
      boxWidth - dpr,
      boxHeight - dpr,
      8 * dpr,
    );
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "top";
    lines.forEach((line, index) => {
      ctx.fillText(
        line,
        SHADOW_PAD * dpr + paddingX,
        SHADOW_PAD * dpr + paddingY + index * lineHeight,
      );
    });

    return { width: canvasWidth, height: canvasHeight };
  }
}

function rasterStatesEqual(a: CalloutRasterState, b: CalloutRasterState): boolean {
  return a.text === b.text && a.dpr === b.dpr && a.isMobile === b.isMobile;
}

function wrapText(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !current) {
      current = next;
      continue;
    }
    lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [text];
}
