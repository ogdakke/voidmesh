import { scheduler, type AnimationHandle } from "#lib/animation-scheduler.ts";
import { getCssVarValue, resolveCssColor, resolveCssVarColor } from "#lib/css.ts";
import type { ShaderCanvasEntity, Viewport } from "#types/canvas.ts";
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
const UNIFORM_SIZE = 32; // bytes (2x vec2f + f32 + 3x f32 padding)
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
  textureWidth: number;
  textureHeight: number;
  rasterState: LabelRasterState;
}

interface LabelRasterState {
  name: string;
  warning: boolean;
  dragProgress: number;
  dpr: number;
  isMobile: boolean;
  styleVersion: number;
}

function rasterStatesEqual(a: LabelRasterState, b: LabelRasterState): boolean {
  return (
    a.name === b.name &&
    a.warning === b.warning &&
    a.dragProgress === b.dragProgress &&
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

  // Shared Canvas 2D (resized per rasterization)
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
  }

  /** Draw a label in the dedicated scene-overlay pass after all entity draws. */
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

    // ── Compute world-space position ───────────────────────────────────────

    const worldWidth = cached.textureWidth / viewport.zoom;
    const worldHeight = cached.textureHeight / viewport.zoom;

    const entityCenterX = entity.position.x + entity.size.width / 2;
    let worldX = entityCenterX - worldWidth / 2 + offsetX;
    let worldY =
      entity.position.y - (VERTICAL_MARGIN * dpr) / viewport.zoom - worldHeight + offsetY;

    // ── Write uniforms and draw ────────────────────────────────────────────

    const data = new Float32Array(UNIFORM_SIZE / 4);
    data[0] = worldX;
    data[1] = worldY;
    data[2] = worldWidth;
    data[3] = worldHeight;
    data[4] = 1; // opacity
    this.#device.queue.writeBuffer(cached.uniformBuffer, 0, data);

    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, cached.bindGroup);
    pass.draw(6);
  }

  /** Whether the drag icon animation is still in progress. */
  get isAnimating(): boolean {
    return this.#isAnimating;
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
      dragProgress: this.#dragIconProgress,
      dpr: this.#dpr,
      isMobile: this.#isMobile,
      styleVersion: this.#styleVersion,
    };
  }

  #rasterizeLabel(entityId: string, rasterState: LabelRasterState): LabelCacheEntry {
    const { width, height } = this.#rasterize(rasterState);
    let cached = this.#cache.get(entityId);

    if (!cached || cached.textureWidth !== width || cached.textureHeight !== height) {
      cached?.texture.destroy();
      cached?.uniformBuffer.destroy();

      cached = this.#createLabelEntry(entityId, width, height, rasterState);
      this.#cache.set(entityId, cached);
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

  #createLabelEntry(
    entityId: string,
    width: number,
    height: number,
    rasterState: LabelRasterState,
  ): LabelCacheEntry {
    const texture = this.#device.createTexture({
      label: `Label ${entityId}`,
      size: [width, height],
      format: "rgba8unorm",
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
      textureWidth: width,
      textureHeight: height,
      rasterState,
    };
  }

  // ── Private: Canvas 2D rasterization ─────────────────────────────────────

  #rasterize(rasterState: LabelRasterState): { width: number; height: number } {
    const { name, warning: isWarning, dragProgress, isMobile, dpr } = rasterState;
    const ctx = this.#ctx;
    const fontSize = (isMobile ? FONT_SIZE_MOBILE : FONT_SIZE_DESKTOP) * dpr;
    const paddingX = PADDING_X * dpr;
    const paddingY = (isMobile ? PADDING_Y_MOBILE : PADDING_Y_DESKTOP) * dpr;
    const gap = GAP * dpr;
    const maxTextWidth = (isMobile ? MAX_TEXT_WIDTH_MOBILE : MAX_TEXT_WIDTH_DESKTOP) * dpr;
    const borderRadius = fontSize;

    const fontStr = `${fontSize}px ${this.#fontFamily}`;
    ctx.font = fontStr;

    const displayText = isWarning ? `\u26A0 Original: ${name}` : name;
    const truncated = this.#truncateText(ctx, displayText, maxTextWidth);

    const iconSize = fontSize * ICON_SIZE_RATIO;
    const iconWidth = iconSize * dragProgress;
    const iconGap = dragProgress > 0.01 ? gap : 0;

    const textMetrics = ctx.measureText(truncated);
    const textWidth = Math.min(textMetrics.width, maxTextWidth);

    const shadowPad = Math.ceil(4 * dpr);
    const contentWidth = iconWidth + iconGap + textWidth;
    const boxWidth = Math.ceil(paddingX + contentWidth + paddingX);
    const boxHeight = Math.ceil(paddingY + fontSize + paddingY);
    const canvasWidth = boxWidth + shadowPad * 2;
    const canvasHeight = boxHeight + shadowPad * 2;

    if (this.#canvas.width !== canvasWidth || this.#canvas.height !== canvasHeight) {
      this.#canvas.width = canvasWidth;
      this.#canvas.height = canvasHeight;
    }

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.font = fontStr;

    const ox = shadowPad;
    const oy = shadowPad;
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
    ctx.fillText(truncated, textX, oy + boxHeight / 2);

    return { width: canvasWidth, height: canvasHeight };
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
