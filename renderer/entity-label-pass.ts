import { scheduler, type AnimationHandle } from "#lib/animation-scheduler.ts";
import { boundsIntersect } from "#lib/canvas-math.ts";
import { getCssVarValue, resolveCssColor, resolveCssVarColor } from "#lib/css.ts";
import type { Bounds, ShaderCanvasEntity, Viewport } from "#types/canvas.ts";
import shaderSource from "./entity-label.wgsl?raw";

// ── Constants ────────────────────────────────────────────────────────────────

const FONT_SIZE_DESKTOP = 14; // CSS pixels
const FONT_SIZE_MOBILE = 12;
const PADDING_X = 8;
const PADDING_Y_DESKTOP = 3;
const PADDING_Y_MOBILE = 4;
const GAP = 4;
const MAX_TEXT_WIDTH_DESKTOP = 320; // 20rem at 16px base
const MAX_TEXT_WIDTH_MOBILE = 192; // 12rem
const VERTICAL_MARGIN = 8; // CSS pixels above entity
const ICON_SIZE_RATIO = 1.2;
const MOBILE_BREAKPOINT = 768;
const DRAG_ANIM_RESPONSE = 0.15; // seconds
const DRAG_ANIM_DAMPING = 0.78;
const DRAG_ANIMATION_FRAME_COUNT = 32;
const DRAG_ANIMATION_ATLAS_COLUMNS = 4;
const DRAG_ANIMATION_ATLAS_ROWS = Math.ceil(
  DRAG_ANIMATION_FRAME_COUNT / DRAG_ANIMATION_ATLAS_COLUMNS,
);
const UNIFORM_SIZE = 48; // bytes (position, size, opacity, texture size, atlas origin)
const LABEL_FONT_FAMILY_FALLBACK =
  'ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, Manjari, "Arial Rounded MT", "Arial Rounded MT Bold", Calibri, source-sans-pro, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';

interface LabelColors {
  normalGradientTop: string;
  normalGradientBottom: string;
  normalBorder: string;
  warningGradientTop: string;
  warningGradientBottom: string;
  warningBorder: string;
  warningText: string;
}

function resolveColors(isDark: boolean): LabelColors {
  return {
    normalGradientTop: resolveCssColor("oklch(0.7 0.18 250.78)")!,
    normalGradientBottom: resolveCssColor(
      isDark ? "oklch(62% 0.23 252.87)" : "oklch(61% 0.23 253.3)",
    )!,
    normalBorder: resolveCssColor("oklch(0.66 0.19 251.62)")!,
    warningGradientTop: resolveCssVarColor(isDark ? "--amber-600" : "--amber-500")!,
    warningGradientBottom: resolveCssVarColor(isDark ? "--amber-900" : "--amber-600")!,
    warningBorder: resolveCssVarColor("--amber-1000")!,
    warningText: resolveCssVarColor("--amber-1600")!,
  };
}

function resolveLabelFontFamily(): string {
  return getCssVarValue("--sans-serif-rounded") ?? LABEL_FONT_FAMILY_FALLBACK;
}

// ── Per-entity label cache entry ─────────────────────────────────────────────

interface LabelCacheEntry {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  uniformBuffer: GPUBuffer;
  frameWidths: readonly number[];
  textureHeight: number;
  atlasCellWidth: number;
  atlasCellHeight: number;
  rasterState: LabelRasterState;
  uniformState: LabelUniformState | null;
}

interface LabelUniformState {
  worldX: number;
  worldY: number;
  worldWidth: number;
  worldHeight: number;
  textureWidth: number;
  textureHeight: number;
  atlasOriginX: number;
  atlasOriginY: number;
}

interface LabelRasterState {
  name: string;
  warning: boolean;
  dpr: number;
  isMobile: boolean;
  styleVersion: number;
}

interface LabelAnimationAtlas {
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  frameWidths: readonly number[];
}

interface LabelMetrics {
  warning: boolean;
  dpr: number;
  font: string;
  fontSize: number;
  paddingX: number;
  gap: number;
  text: string;
  textWidth: number;
  iconSize: number;
  shadowPad: number;
  boxHeight: number;
  canvasHeight: number;
  capacityWidth: number;
}

function rasterStatesEqual(a: LabelRasterState, b: LabelRasterState): boolean {
  return (
    a.name === b.name &&
    a.warning === b.warning &&
    a.dpr === b.dpr &&
    a.isMobile === b.isMobile &&
    a.styleVersion === b.styleVersion
  );
}

// ── EntityLabelPass ──────────────────────────────────────────────────────────

export class EntityLabelPass {
  #device: GPUDevice;
  #canvasFormat: GPUTextureFormat;
  #viewportUniformBuffer: GPUBuffer;

  // Shared GPU resources
  #pipeline: GPURenderPipeline | null = null;
  #sampler: GPUSampler | null = null;
  #bindGroupLayout: GPUBindGroupLayout | null = null;

  // Shared Canvas 2D used to bake each label's complete animation atlas once.
  #canvas: OffscreenCanvas;
  #ctx: OffscreenCanvasRenderingContext2D;

  // Per-entity label cache
  #cache = new Map<string, LabelCacheEntry>();

  // Shared animation state (drag icon affects all labels identically)
  #dragIconProgress = 0;
  #dragAnimTarget = 0;
  #dragAnimHandle: AnimationHandle | null = null;

  // Color state
  #colors: LabelColors;
  #fontFamily: string;
  #isDark: boolean;
  #colorSchemeQuery: MediaQueryList;
  #styleVersion = 0;

  // Frame state (set in beginFrame, read in drawLabel)
  #isMobile = false;
  #dpr = 1;
  #viewport: Viewport | null = null;
  #isAnimating = false;
  #hasDrawnLabel = false;
  readonly #drawnLabelBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly #uniformData = new Float32Array(UNIFORM_SIZE / 4);

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat, viewportUniformBuffer: GPUBuffer) {
    this.#device = device;
    this.#canvasFormat = canvasFormat;
    this.#viewportUniformBuffer = viewportUniformBuffer;

    this.#canvas = new OffscreenCanvas(1, 1);
    this.#ctx = this.#canvas.getContext("2d")!;

    this.#colorSchemeQuery = matchMedia("(prefers-color-scheme: dark)");
    this.#fontFamily = resolveLabelFontFamily();
    this.#isDark = this.#colorSchemeQuery.matches;
    this.#colors = resolveColors(this.#isDark);

    this.#colorSchemeQuery.addEventListener("change", (e) => {
      this.#isDark = e.matches;
      this.#colors = resolveColors(this.#isDark);
      this.#styleVersion++;
    });
  }

  initialize(): void {
    this.#sampler = this.#device.createSampler({
      label: "Entity label sampler",
      magFilter: "linear",
      minFilter: "linear",
    });

    this.#bindGroupLayout = this.#device.createBindGroupLayout({
      label: "Entity label bind group layout",
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
      label: "Entity label shader",
      code: shaderSource,
    });

    this.#pipeline = this.#device.createRenderPipeline({
      label: "Entity label pipeline",
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

  /**
   * Update shared animation state for the current frame.
   * Call once per frame before any drawLabel() calls.
   */
  beginFrame(
    viewport: Viewport,
    canvasWidth: number,
    _canvasHeight: number,
    isDragPhase: boolean,
  ): void {
    if (!this.#pipeline) return;

    this.#dpr = devicePixelRatio || 1;
    this.#isMobile = canvasWidth / this.#dpr < MOBILE_BREAKPOINT;
    this.#viewport = viewport;
    this.#syncDragAnimation(isDragPhase);
    this.#isAnimating = this.#dragAnimHandle?.isActive ?? false;
    this.#hasDrawnLabel = false;
  }

  /** Draw a label after all entity draws in the current composition pass. */
  drawLabel(
    pass: GPURenderPassEncoder,
    entity: ShaderCanvasEntity,
    offsetX: number,
    offsetY: number,
  ): void {
    if (!this.#pipeline || !this.#sampler || !this.#bindGroupLayout || !this.#viewport) return;

    const dpr = this.#dpr;
    const viewport = this.#viewport;
    const cached = this.#getLabelEntry(entity);
    const frameIndex = Math.round(this.#dragIconProgress * (DRAG_ANIMATION_FRAME_COUNT - 1));
    const textureWidth = cached.frameWidths[frameIndex]!;
    const atlasOriginX = (frameIndex % DRAG_ANIMATION_ATLAS_COLUMNS) * cached.atlasCellWidth;
    const atlasOriginY =
      Math.floor(frameIndex / DRAG_ANIMATION_ATLAS_COLUMNS) * cached.atlasCellHeight;

    // ── Compute world-space position ───────────────────────────────────────

    const worldWidth = textureWidth / viewport.zoom;
    const worldHeight = cached.textureHeight / viewport.zoom;

    const entityCenterX = entity.position.x + entity.size.width / 2;
    let worldX = entityCenterX - worldWidth / 2 + offsetX;
    let worldY =
      entity.position.y - (VERTICAL_MARGIN * dpr) / viewport.zoom - worldHeight + offsetY;
    this.#drawnLabelBounds.x = worldX;
    this.#drawnLabelBounds.y = worldY;
    this.#drawnLabelBounds.width = worldWidth;
    this.#drawnLabelBounds.height = worldHeight;
    this.#hasDrawnLabel = true;

    // ── Write uniforms and draw ────────────────────────────────────────────

    const previousUniforms = cached.uniformState;
    if (
      !previousUniforms ||
      previousUniforms.worldX !== worldX ||
      previousUniforms.worldY !== worldY ||
      previousUniforms.worldWidth !== worldWidth ||
      previousUniforms.worldHeight !== worldHeight ||
      previousUniforms.textureWidth !== textureWidth ||
      previousUniforms.textureHeight !== cached.textureHeight ||
      previousUniforms.atlasOriginX !== atlasOriginX ||
      previousUniforms.atlasOriginY !== atlasOriginY
    ) {
      const data = this.#uniformData;
      data[0] = worldX;
      data[1] = worldY;
      data[2] = worldWidth;
      data[3] = worldHeight;
      data[4] = 1; // opacity
      data[5] = 0;
      data[6] = textureWidth;
      data[7] = cached.textureHeight;
      data[8] = atlasOriginX;
      data[9] = atlasOriginY;
      data[10] = 0;
      data[11] = 0;
      this.#device.queue.writeBuffer(cached.uniformBuffer, 0, data);
      cached.uniformState = {
        worldX,
        worldY,
        worldWidth,
        worldHeight,
        textureWidth,
        textureHeight: cached.textureHeight,
        atlasOriginX,
        atlasOriginY,
      };
    }

    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, cached.bindGroup);
    pass.draw(6);
  }

  /** Whether the drag icon animation is still in progress. */
  get isAnimating(): boolean {
    return this.#isAnimating;
  }

  intersectsBounds(bounds: Bounds): boolean {
    return this.#hasDrawnLabel && boundsIntersect(this.#drawnLabelBounds, bounds);
  }

  getDrawnBounds(output: Bounds): boolean {
    if (!this.#hasDrawnLabel) return false;
    output.x = this.#drawnLabelBounds.x;
    output.y = this.#drawnLabelBounds.y;
    output.width = this.#drawnLabelBounds.width;
    output.height = this.#drawnLabelBounds.height;
    return true;
  }

  /**
   * Remove cache entries for entities that are no longer selected.
   * Call once per frame after all drawLabel() calls.
   */
  endFrame(selectedEntityIds: ReadonlySet<string>): void {
    for (const [id, entry] of this.#cache) {
      if (!selectedEntityIds.has(id)) {
        entry.texture.destroy();
        entry.uniformBuffer.destroy();
        this.#cache.delete(id);
      }
    }
  }

  #syncDragAnimation(isDragPhase: boolean): void {
    const nextTarget = isDragPhase ? 1 : 0;
    if (nextTarget === this.#dragAnimTarget) return;

    this.#dragAnimTarget = nextTarget;
    this.#dragAnimHandle?.cancel();
    this.#dragAnimHandle = null;

    if (this.#dragIconProgress === nextTarget) return;

    this.#dragAnimHandle = scheduler.spring({
      from: this.#dragIconProgress,
      to: nextTarget,
      response: DRAG_ANIM_RESPONSE,
      damping: DRAG_ANIM_DAMPING,
      onUpdate: (value) => {
        this.#dragIconProgress = Math.max(0, Math.min(1, value));
      },
      onComplete: () => {
        this.#dragIconProgress = nextTarget;
        this.#dragAnimHandle = null;
      },
    });
  }

  #getLabelEntry(entity: ShaderCanvasEntity): LabelCacheEntry {
    const rasterState = this.#getRasterState(entity);
    const cached = this.#cache.get(entity.id);
    if (cached && rasterStatesEqual(cached.rasterState, rasterState)) {
      return cached;
    }

    return this.#rasterizeLabel(entity.id, rasterState);
  }

  #getRasterState(entity: ShaderCanvasEntity): LabelRasterState {
    return {
      name: entity.name,
      warning: entity.shaderParams.showOriginal,
      dpr: this.#dpr,
      isMobile: this.#isMobile,
      styleVersion: this.#styleVersion,
    };
  }

  #rasterizeLabel(entityId: string, rasterState: LabelRasterState): LabelCacheEntry {
    const atlas = this.#rasterizeAtlas(rasterState);
    const cached = this.#cache.get(entityId);
    cached?.texture.destroy();
    cached?.uniformBuffer.destroy();

    const entry = this.#createLabelEntry(entityId, atlas, rasterState);
    this.#cache.set(entityId, entry);

    this.#device.queue.copyExternalImageToTexture(
      { source: this.#canvas },
      { texture: entry.texture },
      [atlas.width, atlas.height],
    );

    return entry;
  }

  #createLabelEntry(
    entityId: string,
    atlas: LabelAnimationAtlas,
    rasterState: LabelRasterState,
  ): LabelCacheEntry {
    const texture = this.#device.createTexture({
      label: `Label ${entityId}`,
      size: [atlas.width, atlas.height],
      format: "rgba8unorm",
      // Safari's external-image copy path requires render-attachment eligibility.
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const uniformBuffer = this.#device.createBuffer({
      label: `Label ${entityId} uniforms`,
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroup = this.#device.createBindGroup({
      label: `Label ${entityId} bind group`,
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
      frameWidths: atlas.frameWidths,
      textureHeight: atlas.cellHeight,
      atlasCellWidth: atlas.cellWidth,
      atlasCellHeight: atlas.cellHeight,
      rasterState,
      uniformState: null,
    };
  }

  // ── Private: Canvas 2D rasterization ─────────────────────────────────────

  #rasterizeAtlas(rasterState: LabelRasterState): LabelAnimationAtlas {
    const metrics = this.#measureLabel(rasterState);
    const cellWidth = metrics.capacityWidth;
    const cellHeight = metrics.canvasHeight;
    const width = cellWidth * DRAG_ANIMATION_ATLAS_COLUMNS;
    const height = cellHeight * DRAG_ANIMATION_ATLAS_ROWS;

    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }

    const ctx = this.#ctx;
    ctx.clearRect(0, 0, width, height);
    ctx.font = metrics.font;

    const frameWidths = new Array<number>(DRAG_ANIMATION_FRAME_COUNT);
    for (let frame = 0; frame < DRAG_ANIMATION_FRAME_COUNT; frame++) {
      const progress = frame / (DRAG_ANIMATION_FRAME_COUNT - 1);
      const originX = (frame % DRAG_ANIMATION_ATLAS_COLUMNS) * cellWidth;
      const originY = Math.floor(frame / DRAG_ANIMATION_ATLAS_COLUMNS) * cellHeight;
      frameWidths[frame] = this.#drawLabelFrame(metrics, progress, originX, originY);
    }

    return { width, height, cellWidth, cellHeight, frameWidths };
  }

  #measureLabel(rasterState: LabelRasterState): LabelMetrics {
    const { name, warning, isMobile, dpr } = rasterState;
    const fontSize = (isMobile ? FONT_SIZE_MOBILE : FONT_SIZE_DESKTOP) * dpr;
    const paddingX = PADDING_X * dpr;
    const paddingY = (isMobile ? PADDING_Y_MOBILE : PADDING_Y_DESKTOP) * dpr;
    const gap = GAP * dpr;
    const maxTextWidth = (isMobile ? MAX_TEXT_WIDTH_MOBILE : MAX_TEXT_WIDTH_DESKTOP) * dpr;
    const font = `${fontSize}px ${this.#fontFamily}`;
    const ctx = this.#ctx;
    ctx.font = font;

    const displayText = warning ? `\u26A0 Original: ${name}` : name;
    const text = this.#truncateText(ctx, displayText, maxTextWidth);
    const textWidth = Math.min(ctx.measureText(text).width, maxTextWidth);
    const iconSize = fontSize * ICON_SIZE_RATIO;
    const shadowPad = Math.ceil(4 * dpr);
    const boxHeight = Math.ceil(paddingY + fontSize + paddingY);
    const canvasHeight = boxHeight + shadowPad * 2;
    const capacityContentWidth = iconSize + gap + textWidth;
    const capacityBoxWidth = Math.ceil(paddingX + capacityContentWidth + paddingX);

    return {
      warning,
      dpr,
      font,
      fontSize,
      paddingX,
      gap,
      text,
      textWidth,
      iconSize,
      shadowPad,
      boxHeight,
      canvasHeight,
      capacityWidth: capacityBoxWidth + shadowPad * 2,
    };
  }

  #drawLabelFrame(
    metrics: LabelMetrics,
    dragProgress: number,
    originX: number,
    originY: number,
  ): number {
    const {
      warning: isWarning,
      dpr,
      fontSize,
      paddingX,
      gap,
      text,
      textWidth,
      iconSize,
      shadowPad,
      boxHeight,
    } = metrics;
    const ctx = this.#ctx;
    const iconWidth = iconSize * dragProgress;
    const iconGap = dragProgress > 0.01 ? gap : 0;
    const contentWidth = iconWidth + iconGap + textWidth;
    const boxWidth = Math.ceil(paddingX + contentWidth + paddingX);
    const canvasWidth = boxWidth + shadowPad * 2;
    const borderRadius = fontSize;
    const ox = originX + shadowPad;
    const oy = originY + shadowPad;
    const colors = this.#colors;

    // Background with drop shadow
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.32)";
    ctx.shadowBlur = 3 * dpr;
    ctx.shadowOffsetY = 1 * dpr;

    const grad = ctx.createLinearGradient(0, oy, 0, oy + boxHeight);
    grad.addColorStop(0, isWarning ? colors.warningGradientTop : colors.normalGradientTop);
    grad.addColorStop(1, isWarning ? colors.warningGradientBottom : colors.normalGradientBottom);
    ctx.fillStyle = grad;

    ctx.beginPath();
    ctx.roundRect(ox, oy, boxWidth, boxHeight, borderRadius);
    ctx.fill();
    ctx.restore();

    // Inset highlight
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.roundRect(
      ox + 0.5 * dpr,
      oy + 0.5 * dpr,
      boxWidth - 1 * dpr,
      boxHeight - 1 * dpr,
      borderRadius,
    );
    ctx.stroke();
    ctx.restore();

    // Outline stroke
    ctx.strokeStyle = isWarning ? colors.warningBorder : colors.normalBorder;
    ctx.lineWidth = 0.5 * dpr;
    ctx.beginPath();
    ctx.roundRect(
      ox + 0.25 * dpr,
      oy + 0.25 * dpr,
      boxWidth - 0.5 * dpr,
      boxHeight - 0.5 * dpr,
      borderRadius,
    );
    ctx.stroke();

    // Icon
    let textX = ox + paddingX;
    if (dragProgress > 0.01) {
      const iconX = ox + paddingX;
      const iconY = oy + (boxHeight - iconSize) / 2;
      this.#drawDragIcon(
        ctx,
        iconX,
        iconY,
        iconWidth,
        iconSize,
        isWarning ? colors.warningText : "#ffffff",
        dpr,
      );
      textX = ox + paddingX + iconWidth + iconGap;
    }

    // Text
    ctx.fillStyle = isWarning ? colors.warningText : "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, textX, oy + boxHeight / 2);

    return canvasWidth;
  }

  #truncateText(ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;

    const ellipsis = "\u2026";
    const ellipsisWidth = ctx.measureText(ellipsis).width;
    const targetWidth = maxWidth - ellipsisWidth;

    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (ctx.measureText(text.slice(0, mid)).width <= targetWidth) low = mid;
      else high = mid - 1;
    }
    return text.slice(0, low) + ellipsis;
  }

  #drawDragIcon(
    ctx: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
    dpr: number,
  ): void {
    const scale = Math.min(width, height) / 24;
    ctx.save();
    ctx.translate(x + (width - 24 * scale) / 2, y + (height - 24 * scale) / 2);
    ctx.scale(scale, scale);
    ctx.strokeStyle = color;
    ctx.lineWidth = (1.5 / scale) * dpr;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // 4 diagonal arrows (iconoir "Drag")
    for (const [cx, cy] of [
      [4, 4],
      [20, 4],
      [4, 20],
      [20, 20],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(12, 12);
      ctx.lineTo(cx, cy);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy === 4 ? 8 : 16);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx === 4 ? 8 : 16, cy);
      ctx.stroke();
    }

    ctx.restore();
  }
  // ── Lifecycle ────────────────────────────────────────────────────────────

  destroy(): void {
    for (const entry of this.#cache.values()) {
      entry.texture.destroy();
      entry.uniformBuffer.destroy();
    }
    this.#cache.clear();
    this.#dragAnimHandle?.cancel();
    this.#pipeline = null;
  }
}
