import type { RenderState } from "../engine/canvas-store.ts";
import { entityDragVisual } from "../engine/entity-drag-visual.ts";
import { actionLayerController } from "../engine/action-layer-controller.ts";
import { scheduler, type AnimationHandle } from "../lib/animation-scheduler.ts";
import type { Viewport } from "#types/canvas.ts";
import shaderSource from "./entity-label.wgsl?raw";

// ── Constants ────────────────────────────────────────────────────────────────

const FONT_SIZE_DESKTOP = 14; // CSS pixels
const FONT_SIZE_MOBILE = 12;
const PADDING_X = 8; // CSS pixels
const PADDING_Y_DESKTOP = 3;
const PADDING_Y_MOBILE = 4;
const GAP = 4;
const MAX_TEXT_WIDTH_DESKTOP = 320; // CSS pixels (20rem = 320px at 16px base)
const MAX_TEXT_WIDTH_MOBILE = 192; // 12rem
const VERTICAL_MARGIN = 8; // CSS pixels above entity
const ICON_SIZE_RATIO = 1.2; // Icon width = fontSize * 1.2
const MOBILE_BREAKPOINT = 768; // CSS pixels
const DRAG_ANIM_DURATION = 0.15; // seconds
const OPACITY_SPEED = 12; // exponential approach rate
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

/** Resolve a CSS value (potentially with oklch, var(), etc.) to a usable color string. */
function resolveCSSColor(value: string): string {
  const el = document.createElement("div");
  el.style.color = value;
  document.documentElement.appendChild(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  return resolved;
}

function resolveColors(isDark: boolean): LabelColors {
  return {
    normalGradientTop: resolveCSSColor(
      "oklch(0.7 0.18 250.78)", // --primary-lighter (same for light/dark)
    ),
    normalGradientBottom: resolveCSSColor(
      isDark ? "oklch(62% 0.23 252.87)" : "oklch(61% 0.23 253.3)",
    ),
    normalBorder: resolveCSSColor("oklch(0.66 0.19 251.62)"),
    // Warning uses CSS variables that include relative color functions —
    // resolve via getComputedStyle to let the browser compute the final value
    warningGradientTop: resolveCSSVar(isDark ? "--amber-600" : "--amber-500"),
    warningGradientBottom: resolveCSSVar(isDark ? "--amber-900" : "--amber-600"),
    warningBorder: resolveCSSVar("--amber-1000"),
    warningText: resolveCSSVar("--amber-1600"),
  };
}

function resolveCSSVar(varName: string): string {
  const el = document.createElement("div");
  el.style.color = `var(${varName})`;
  document.documentElement.appendChild(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  return resolved;
}

// ── Cubic bezier easing ──────────────────────────────────────────────────────

/** Evaluate cubic-bezier(x1, y1, x2, y2) at input t ∈ [0,1]. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // Binary search for bezier parameter u where B_x(u) ≈ t
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

/** CSS cubic-bezier(0.34, 1.56, 0.64, 1) — spring overshoot easing. */
function springEase(t: number): number {
  return cubicBezier(0.34, 1.56, 0.64, 1, t);
}

// ── EntityLabelPass ──────────────────────────────────────────────────────────

export class EntityLabelPass {
  #device: GPUDevice;
  #canvasFormat: GPUTextureFormat;
  #viewportUniformBuffer: GPUBuffer;

  // GPU resources
  #pipeline: GPURenderPipeline | null = null;
  #uniformBuffer: GPUBuffer | null = null;
  #uniformData = new ArrayBuffer(UNIFORM_SIZE);
  #uniformFloatView = new Float32Array(this.#uniformData);
  #sampler: GPUSampler | null = null;
  #texture: GPUTexture | null = null;
  #bindGroup: GPUBindGroup | null = null;
  #bindGroupLayout: GPUBindGroupLayout | null = null;

  // Canvas 2D resources
  #canvas: OffscreenCanvas;
  #ctx: OffscreenCanvasRenderingContext2D;

  // Texture dimensions (canvas pixels)
  #textureWidth = 0;
  #textureHeight = 0;

  // Dirty-checking cache
  #cachedEntityId: string | null = null;
  #cachedName = "";
  #cachedWarning = false;
  #cachedDpr = 0;
  #cachedDragProgress = -1; // Track last rasterized drag progress
  #needsUpload = false;

  // Animation state
  #dragIconProgress = 0; // Current animated value 0–1
  #dragAnimStartTime = 0; // Wall-clock time (performance.now()) when animation started
  #dragAnimFrom = 0; // Start value of current animation
  #dragAnimTarget = 0; // 0 or 1
  #dragAnimHandle: AnimationHandle | null = null; // Keeps render loop alive
  #opacity = 0;

  // Color state
  #colors: LabelColors;
  #isDark: boolean;
  #colorSchemeQuery: MediaQueryList;

  // PWA safe-area handling
  #safeAreaInsetTop: number | undefined;
  #isStandalone = !!(navigator as any)?.standalone;

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat, viewportUniformBuffer: GPUBuffer) {
    this.#device = device;
    this.#canvasFormat = canvasFormat;
    this.#viewportUniformBuffer = viewportUniformBuffer;

    // Initial canvas (will be resized during rasterization)
    this.#canvas = new OffscreenCanvas(1, 1);
    this.#ctx = this.#canvas.getContext("2d")!;

    // Resolve colors based on current color scheme
    this.#colorSchemeQuery = matchMedia("(prefers-color-scheme: dark)");
    this.#isDark = this.#colorSchemeQuery.matches;
    this.#colors = resolveColors(this.#isDark);

    this.#colorSchemeQuery.addEventListener("change", (e) => {
      this.#isDark = e.matches;
      this.#colors = resolveColors(this.#isDark);
      this.#cachedName = ""; // Force re-rasterize
    });
  }

  initialize(): void {
    // Create GPU resources
    this.#sampler = this.#device.createSampler({
      label: "Entity label sampler",
      magFilter: "linear",
      minFilter: "linear",
    });

    this.#uniformBuffer = this.#device.createBuffer({
      label: "Entity label uniforms",
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: this.#canvasFormat,
            blend: {
              // Premultiplied alpha blending
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
   * Render the entity label for the current frame.
   * Returns true if an animation is in progress (opacity or drag icon transitioning).
   */
  render(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    state: RenderState,
    viewport: Viewport,
    canvasWidth: number,
    canvasHeight: number,
    frameDt: number,
  ): boolean {
    if (!this.#pipeline || !this.#uniformBuffer || !this.#sampler || !this.#bindGroupLayout) {
      return false;
    }

    const { selectedEntityIds, entities } = state;

    // Only show label when exactly one entity is selected
    const selectedId =
      selectedEntityIds.size === 1 ? selectedEntityIds.values().next().value : null;
    const entity = selectedId ? entities.find((e) => e.id === selectedId) : null;

    // Update opacity target
    this.#opacityTarget = entity ? 1 : 0;

    // Animate opacity
    const opacityDelta = this.#opacityTarget - this.#opacity;
    if (Math.abs(opacityDelta) > 0.001) {
      // Cap frameDt to prevent instant snap after idle periods
      this.#opacity += opacityDelta * Math.min(1, Math.min(frameDt, 1 / 30) * OPACITY_SPEED);
    } else {
      this.#opacity = this.#opacityTarget;
    }

    // Skip rendering if fully transparent
    if (this.#opacity < 0.01 || !entity) {
      // Reset cached entity when hiding
      if (!entity) this.#cachedEntityId = null;
      return this.#opacity > 0.01; // Still animating if fading out
    }

    const dpr = devicePixelRatio || 1;
    const isMobile = canvasWidth / dpr < MOBILE_BREAKPOINT;

    // ── Drag icon animation ────────────────────────────────────────────────

    const isDragPhase = entityDragVisual.isDragPhase();
    const newDragTarget = isDragPhase ? 1 : 0;

    if (newDragTarget !== this.#dragAnimTarget) {
      this.#dragAnimFrom = this.#dragIconProgress;
      this.#dragAnimTarget = newDragTarget;
      this.#dragAnimStartTime = performance.now();
      // Schedule a tween on the animation scheduler to keep the render loop alive
      // during the label's icon transition (the game loop checks scheduler.hasActive)
      this.#dragAnimHandle?.cancel();
      this.#dragAnimHandle = scheduler.tween({
        from: 0,
        to: 1,
        duration: DRAG_ANIM_DURATION * 1000,
        onUpdate: () => {}, // No-op — we compute progress ourselves
        onComplete: () => {
          this.#dragAnimHandle = null;
        },
      });
    }

    const dragAnimating = this.#dragIconProgress !== this.#dragAnimTarget;
    if (dragAnimating) {
      // Use wall-clock time, not accumulated frameDt — frameDt can be huge after
      // an idle period (e.g. render loop paused during mobile long-press hold),
      // which would cause the animation to complete in a single frame.
      const elapsed = (performance.now() - this.#dragAnimStartTime) / 1000;
      const t = Math.min(elapsed / DRAG_ANIM_DURATION, 1);
      const eased = springEase(t);
      this.#dragIconProgress =
        this.#dragAnimFrom + (this.#dragAnimTarget - this.#dragAnimFrom) * eased;
      // Clamp to [0,1] — spring easing overshoots, prevent negative icon width
      this.#dragIconProgress = Math.max(0, Math.min(1, this.#dragIconProgress));
      if (t >= 1) this.#dragIconProgress = this.#dragAnimTarget;
    }

    // ── Rasterize label if dirty ───────────────────────────────────────────

    const isWarning = entity.shaderParams.showOriginal;
    const nameChanged = entity.name !== this.#cachedName;
    const warningChanged = isWarning !== this.#cachedWarning;
    const entityChanged = entity.id !== this.#cachedEntityId;
    const dprChanged = dpr !== this.#cachedDpr;
    // Re-rasterize when drag progress changed (including the final snap to target)
    const dragProgressChanged = this.#dragIconProgress !== this.#cachedDragProgress;

    if (nameChanged || warningChanged || entityChanged || dprChanged || dragProgressChanged) {
      this.#rasterize(entity.name, isWarning, this.#dragIconProgress, isMobile, dpr);
      this.#needsUpload = true;
      this.#cachedEntityId = entity.id;
      this.#cachedName = entity.name;
      this.#cachedWarning = isWarning;
      this.#cachedDpr = dpr;
      this.#cachedDragProgress = this.#dragIconProgress;
    }

    // ── Upload texture if needed ───────────────────────────────────────────

    if (this.#needsUpload && this.#textureWidth > 0 && this.#textureHeight > 0) {
      this.#uploadTexture();
      this.#needsUpload = false;
    }

    if (!this.#texture || !this.#bindGroup) return dragAnimating;

    // ── Compute world-space position ───────────────────────────────────────

    // Label size in world coordinates = texture pixels / zoom
    const worldWidth = this.#textureWidth / viewport.zoom;
    const worldHeight = this.#textureHeight / viewport.zoom;

    // Center horizontally on entity, position above with margin
    const entityCenterX = entity.position.x + entity.size.width / 2;
    let worldX = entityCenterX - worldWidth / 2;
    let worldY = entity.position.y - (VERTICAL_MARGIN * dpr) / viewport.zoom - worldHeight;

    // Apply action layer rubber-band offset (CSS pixels → world coords)
    if (actionLayerController.isActive()) {
      const cssOffset = actionLayerController.getEntityOffset();
      worldX += (cssOffset.x * dpr) / viewport.zoom;
      worldY += (cssOffset.y * dpr) / viewport.zoom;
    }

    // Apply safe area inset for PWA standalone mode
    if (this.#isStandalone) {
      const safeArea = this.#getSafeAreaInsetTop();
      if (safeArea > 0) {
        worldY += (safeArea * dpr) / viewport.zoom;
      }
    }

    // ── Write uniforms and draw ────────────────────────────────────────────

    const f = this.#uniformFloatView;
    f[0] = worldX;
    f[1] = worldY;
    f[2] = worldWidth;
    f[3] = worldHeight;
    f[4] = this.#opacity;
    this.#device.queue.writeBuffer(this.#uniformBuffer, 0, this.#uniformData);

    const pass = encoder.beginRenderPass({
      label: "Entity label render pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "load",
          storeOp: "store",
        },
      ],
    });

    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    pass.draw(6);
    pass.end();

    return dragAnimating || Math.abs(this.#opacity - this.#opacityTarget) > 0.01;
  }

  // ── Private: Canvas 2D rasterization ─────────────────────────────────────

  #rasterize(
    name: string,
    isWarning: boolean,
    dragProgress: number,
    isMobile: boolean,
    dpr: number,
  ): void {
    const ctx = this.#ctx;
    const fontSize = (isMobile ? FONT_SIZE_MOBILE : FONT_SIZE_DESKTOP) * dpr;
    const paddingX = PADDING_X * dpr;
    const paddingY = (isMobile ? PADDING_Y_MOBILE : PADDING_Y_DESKTOP) * dpr;
    const gap = GAP * dpr;
    const maxTextWidth = (isMobile ? MAX_TEXT_WIDTH_MOBILE : MAX_TEXT_WIDTH_DESKTOP) * dpr;
    const borderRadius = fontSize; // Large enough for full pill shape (CSS uses 999px)

    // Font setup (must be set before measureText)
    const fontStr = `${fontSize}px system-ui, -apple-system, sans-serif`;
    ctx.font = fontStr;

    // Prepare display text
    const displayText = isWarning ? `\u26A0 Original: ${name}` : name;
    const truncated = this.#truncateText(ctx, displayText, maxTextWidth);

    // Compute icon width
    const iconSize = fontSize * ICON_SIZE_RATIO;
    const iconWidth = iconSize * dragProgress;
    const iconGap = dragProgress > 0.01 ? gap : 0;

    // Measure text
    const textMetrics = ctx.measureText(truncated);
    const textWidth = Math.min(textMetrics.width, maxTextWidth);

    // Compute canvas dimensions (with shadow padding so drop shadow isn't clipped)
    const shadowPad = Math.ceil(4 * dpr); // Enough for blur=3 + offset=1
    const contentWidth = iconWidth + iconGap + textWidth;
    const boxWidth = Math.ceil(paddingX + contentWidth + paddingX);
    const boxHeight = Math.ceil(paddingY + fontSize + paddingY);
    const canvasWidth = boxWidth + shadowPad * 2;
    const canvasHeight = boxHeight + shadowPad * 2;

    // Resize canvas if needed
    if (this.#canvas.width !== canvasWidth || this.#canvas.height !== canvasHeight) {
      this.#canvas.width = canvasWidth;
      this.#canvas.height = canvasHeight;
    }
    this.#textureWidth = canvasWidth;
    this.#textureHeight = canvasHeight;

    // Clear
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Re-set font (cleared on canvas resize)
    ctx.font = fontStr;

    // Offset all drawing by shadowPad so the box is centered with room for shadow
    const ox = shadowPad;
    const oy = shadowPad;

    const colors = this.#colors;

    // ── Background box ───────────────────────────────────────────────────

    // Drop shadow
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.32)";
    ctx.shadowBlur = 3 * dpr;
    ctx.shadowOffsetY = 1 * dpr;

    // Gradient fill
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

    // ── Icon (draw Drag icon paths directly for dynamic color) ─────────

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

    // ── Text ─────────────────────────────────────────────────────────────

    ctx.fillStyle = isWarning ? colors.warningText : "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(truncated, textX, oy + boxHeight / 2);
  }

  #truncateText(ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;

    const ellipsis = "\u2026"; // …
    const ellipsisWidth = ctx.measureText(ellipsis).width;
    const targetWidth = maxWidth - ellipsisWidth;

    // Binary search for longest fitting prefix
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (ctx.measureText(text.slice(0, mid)).width <= targetWidth) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return text.slice(0, low) + ellipsis;
  }

  /** Draw the iconoir "Drag" icon (4 diagonal arrows) using Canvas 2D paths. */
  #drawDragIcon(
    ctx: OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
    dpr: number,
  ): void {
    // The icon viewBox is 0 0 24 24. Scale to fit within width × height.
    const scale = Math.min(width, height) / 24;
    ctx.save();
    ctx.translate(x + (width - 24 * scale) / 2, y + (height - 24 * scale) / 2);
    ctx.scale(scale, scale);
    ctx.strokeStyle = color;
    ctx.lineWidth = (1.5 / scale) * dpr; // Maintain consistent stroke weight
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Top-left arrow: M12 12L4 4M4 4V8M4 4H8
    ctx.beginPath();
    ctx.moveTo(12, 12);
    ctx.lineTo(4, 4);
    ctx.moveTo(4, 4);
    ctx.lineTo(4, 8);
    ctx.moveTo(4, 4);
    ctx.lineTo(8, 4);
    ctx.stroke();

    // Top-right arrow: M12 12L20 4M20 4V8M20 4H16
    ctx.beginPath();
    ctx.moveTo(12, 12);
    ctx.lineTo(20, 4);
    ctx.moveTo(20, 4);
    ctx.lineTo(20, 8);
    ctx.moveTo(20, 4);
    ctx.lineTo(16, 4);
    ctx.stroke();

    // Bottom-left arrow: M12 12L4 20M4 20V16M4 20H8
    ctx.beginPath();
    ctx.moveTo(12, 12);
    ctx.lineTo(4, 20);
    ctx.moveTo(4, 20);
    ctx.lineTo(4, 16);
    ctx.moveTo(4, 20);
    ctx.lineTo(8, 20);
    ctx.stroke();

    // Bottom-right arrow: M12 12L20 20M20 20V16M20 20H16
    ctx.beginPath();
    ctx.moveTo(12, 12);
    ctx.lineTo(20, 20);
    ctx.moveTo(20, 20);
    ctx.lineTo(20, 16);
    ctx.moveTo(20, 20);
    ctx.lineTo(16, 20);
    ctx.stroke();

    ctx.restore();
  }

  // ── Private: GPU texture management ──────────────────────────────────────

  #uploadTexture(): void {
    const w = this.#textureWidth;
    const h = this.#textureHeight;

    // Recreate texture if dimensions changed
    if (!this.#texture || this.#texture.width !== w || this.#texture.height !== h) {
      this.#texture?.destroy();
      this.#texture = this.#device.createTexture({
        label: "Entity label texture",
        size: [w, h],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      // Recreate bind group with new texture
      this.#bindGroup = this.#device.createBindGroup({
        label: "Entity label bind group",
        layout: this.#bindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.#viewportUniformBuffer } },
          { binding: 1, resource: { buffer: this.#uniformBuffer! } },
          { binding: 2, resource: this.#texture.createView() },
          { binding: 3, resource: this.#sampler! },
        ],
      });
    }

    this.#device.queue.copyExternalImageToTexture(
      { source: this.#canvas },
      { texture: this.#texture },
      [w, h],
    );
  }

  // ── Private: PWA safe area ───────────────────────────────────────────────

  #getSafeAreaInsetTop(): number {
    if (this.#safeAreaInsetTop && this.#safeAreaInsetTop > 0) return this.#safeAreaInsetTop;
    const top = +getComputedStyle(document.documentElement)
      .getPropertyValue("--safe-area-top")
      .slice(0, -2);
    if (this.#isStandalone && top <= 0) return 0;
    this.#safeAreaInsetTop = top;
    return top;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  #opacityTarget = 0;

  destroy(): void {
    this.#texture?.destroy();
    this.#uniformBuffer?.destroy();
    this.#texture = null;
    this.#uniformBuffer = null;
    this.#bindGroup = null;
    this.#pipeline = null;
  }
}
