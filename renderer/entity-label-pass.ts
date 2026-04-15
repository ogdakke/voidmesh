import { entityDragVisual } from "../engine/entity-drag-visual.ts";
import { scheduler, type AnimationHandle } from "../lib/animation-scheduler.ts";
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
const DRAG_ANIM_DURATION = 0.15; // seconds
const UNIFORM_SIZE = 32; // bytes (2x vec2f + f32 + 3x f32 padding)

// ── Color resolution ─────────────────────────────────────────────────────────

interface LabelColors {
  normalGradientTop: string;
  normalGradientBottom: string;
  normalBorder: string;
  warningGradientTop: string;
  warningGradientBottom: string;
  warningBorder: string;
  warningText: string;
}

function resolveCSSColor(value: string): string {
  const el = document.createElement("div");
  el.style.color = value;
  document.documentElement.appendChild(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  return resolved;
}

function resolveCSSVar(varName: string): string {
  const el = document.createElement("div");
  el.style.color = `var(${varName})`;
  document.documentElement.appendChild(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  return resolved;
}

function resolveColors(isDark: boolean): LabelColors {
  return {
    normalGradientTop: resolveCSSColor("oklch(0.7 0.18 250.78)"),
    normalGradientBottom: resolveCSSColor(
      isDark ? "oklch(62% 0.23 252.87)" : "oklch(61% 0.23 253.3)",
    ),
    normalBorder: resolveCSSColor("oklch(0.66 0.19 251.62)"),
    warningGradientTop: resolveCSSVar(isDark ? "--amber-600" : "--amber-500"),
    warningGradientBottom: resolveCSSVar(isDark ? "--amber-900" : "--amber-600"),
    warningBorder: resolveCSSVar("--amber-1000"),
    warningText: resolveCSSVar("--amber-1600"),
  };
}

// ── Cubic bezier easing ──────────────────────────────────────────────────────

function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) * 0.5;
    const inv = 1 - mid;
    const x = 3 * x1 * mid * inv * inv + 3 * x2 * mid * mid * inv + mid * mid * mid;
    if (x < t) low = mid;
    else high = mid;
  }
  const u = (low + high) * 0.5;
  const inv = 1 - u;
  return 3 * y1 * u * inv * inv + 3 * y2 * u * u * inv + u * u * u;
}

function springEase(t: number): number {
  return cubicBezier(0.34, 1.56, 0.64, 1, t);
}

// ── Per-entity label cache entry ─────────────────────────────────────────────

interface LabelCacheEntry {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  uniformBuffer: GPUBuffer;
  textureWidth: number;
  textureHeight: number;
  // Dirty-checking
  name: string;
  warning: boolean;
  dragProgress: number;
  dpr: number;
  isMobile: boolean;
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
  #dragAnimStartTime = 0;
  #dragAnimFrom = 0;
  #dragAnimTarget = 0;
  #dragAnimHandle: AnimationHandle | null = null;

  // Color state
  #colors: LabelColors;
  #isDark: boolean;
  #colorSchemeQuery: MediaQueryList;

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
    this.#isDark = this.#colorSchemeQuery.matches;
    this.#colors = resolveColors(this.#isDark);

    this.#colorSchemeQuery.addEventListener("change", (e) => {
      this.#isDark = e.matches;
      this.#colors = resolveColors(this.#isDark);
      // Invalidate all cached labels on color scheme change
      for (const entry of this.#cache.values()) {
        entry.name = "";
      }
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
  beginFrame(viewport: Viewport, canvasWidth: number, _canvasHeight: number): void {
    if (!this.#pipeline) return;

    this.#dpr = devicePixelRatio || 1;
    this.#isMobile = canvasWidth / this.#dpr < MOBILE_BREAKPOINT;
    this.#viewport = viewport;
    this.#isAnimating = false;

    // ── Drag icon animation (shared across all labels) ───────────────────

    const isDragPhase = entityDragVisual.isDragPhase();
    const newDragTarget = isDragPhase ? 1 : 0;

    if (newDragTarget !== this.#dragAnimTarget) {
      this.#dragAnimFrom = this.#dragIconProgress;
      this.#dragAnimTarget = newDragTarget;
      this.#dragAnimStartTime = performance.now();
      this.#dragAnimHandle?.cancel();
      this.#dragAnimHandle = scheduler.tween({
        from: 0,
        to: 1,
        duration: DRAG_ANIM_DURATION * 1000,
        onUpdate: () => {},
        onComplete: () => {
          this.#dragAnimHandle = null;
        },
      });
    }

    if (this.#dragIconProgress !== this.#dragAnimTarget) {
      const elapsed = (performance.now() - this.#dragAnimStartTime) / 1000;
      const t = Math.min(elapsed / DRAG_ANIM_DURATION, 1);
      this.#dragIconProgress =
        this.#dragAnimFrom + (this.#dragAnimTarget - this.#dragAnimFrom) * springEase(t);
      this.#dragIconProgress = Math.max(0, Math.min(1, this.#dragIconProgress));
      if (t >= 1) this.#dragIconProgress = this.#dragAnimTarget;
      this.#isAnimating = true;
    }
  }

  /**
   * Draw a label for a single entity. Call within the entity composition loop
   * (after the entity's own draw call) so labels respect z-ordering.
   */
  drawLabel(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    entity: ShaderCanvasEntity,
    offsetX: number,
    offsetY: number,
  ): void {
    if (!this.#pipeline || !this.#sampler || !this.#bindGroupLayout || !this.#viewport) return;

    const dpr = this.#dpr;
    const viewport = this.#viewport;
    const isWarning = entity.shaderParams.showOriginal;
    const dragProgress = this.#dragIconProgress;

    // ── Rasterize if dirty ─────────────────────────────────────────────────

    let cached = this.#cache.get(entity.id);
    const needsRaster =
      !cached ||
      cached.name !== entity.name ||
      cached.warning !== isWarning ||
      cached.dragProgress !== dragProgress ||
      cached.dpr !== dpr ||
      cached.isMobile !== this.#isMobile;

    if (needsRaster) {
      const { width, height } = this.#rasterize(
        entity.name,
        isWarning,
        dragProgress,
        this.#isMobile,
        dpr,
      );

      if (!cached || cached.textureWidth !== width || cached.textureHeight !== height) {
        // Destroy old resources if dimensions changed
        cached?.texture.destroy();
        cached?.uniformBuffer.destroy();

        const texture = this.#device.createTexture({
          label: `Label ${entity.id}`,
          size: [width, height],
          format: "rgba8unorm",
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
        });

        const uniformBuffer = this.#device.createBuffer({
          label: `Label ${entity.id} uniforms`,
          size: UNIFORM_SIZE,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const bindGroup = this.#device.createBindGroup({
          label: `Label ${entity.id} bind group`,
          layout: this.#bindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
            { binding: 1, resource: { buffer: uniformBuffer } },
            { binding: 2, resource: texture.createView() },
            { binding: 3, resource: this.#sampler },
          ],
        });

        cached = {
          texture,
          bindGroup,
          uniformBuffer,
          textureWidth: width,
          textureHeight: height,
          name: entity.name,
          warning: isWarning,
          dragProgress,
          dpr,
          isMobile: this.#isMobile,
        };
        this.#cache.set(entity.id, cached);
      } else {
        // Same dimensions — update metadata only
        cached.name = entity.name;
        cached.warning = isWarning;
        cached.dragProgress = dragProgress;
        cached.dpr = dpr;
        cached.isMobile = this.#isMobile;
      }

      // Upload rasterized canvas to texture
      this.#device.queue.copyExternalImageToTexture(
        { source: this.#canvas },
        { texture: cached.texture },
        [width, height],
      );
    }

    if (!cached) return;

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

    const pass = encoder.beginRenderPass({
      label: `Label ${entity.id} pass`,
      colorAttachments: [{ view: targetView, loadOp: "load", storeOp: "store" }],
    });

    pass.setPipeline(this.#pipeline!);
    pass.setBindGroup(0, cached.bindGroup);
    pass.draw(6);
    pass.end();
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

  // ── Private: Canvas 2D rasterization ─────────────────────────────────────

  #rasterize(
    name: string,
    isWarning: boolean,
    dragProgress: number,
    isMobile: boolean,
    dpr: number,
  ): { width: number; height: number } {
    const ctx = this.#ctx;
    const fontSize = (isMobile ? FONT_SIZE_MOBILE : FONT_SIZE_DESKTOP) * dpr;
    const paddingX = PADDING_X * dpr;
    const paddingY = (isMobile ? PADDING_Y_MOBILE : PADDING_Y_DESKTOP) * dpr;
    const gap = GAP * dpr;
    const maxTextWidth = (isMobile ? MAX_TEXT_WIDTH_MOBILE : MAX_TEXT_WIDTH_DESKTOP) * dpr;
    const borderRadius = fontSize;

    const fontStr = `${fontSize}px system-ui, -apple-system, sans-serif`;
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
