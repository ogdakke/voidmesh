import type React from "react";
import type { Font } from "text-shaper";
import { TextRenderer } from "../text/text-renderer.ts";
import { UIBoxPipeline } from "./ui-box-pipeline.ts";
import { UIIconPipeline } from "./ui-icon-pipeline.ts";
import { getIconRasterSize, UIIconCache } from "./ui-icon-cache.ts";
import { prepareText } from "../text/slug.ts";
import type { UIPointerEvent, UIDragEvent } from "./elements.ts";
import { SceneNode, hasActiveAnimations, pruneExitedNodes } from "./scene-node.ts";
import {
  createCanvasContainer,
  updateCanvasContainer,
  unmountCanvasContainer,
  type CanvasUIFiberRoot,
} from "./canvas-reconciler.ts";
import {
  computeLayout,
  type AnchorTarget,
  type ViewportInfo,
  type TextMeasurer,
  type TextMetrics,
} from "./ui-layout.ts";
import { hitTest } from "./hit-test.ts";
import { UIStyleResolver } from "./style-resolver.ts";

const ICON_RASTER_UPGRADE_THRESHOLD = 1.25;

interface LayoutCacheEntry {
  renderVersion: number;
  anchorX: number;
  anchorY: number;
  scale: number;
  dependsOnViewport: boolean;
  viewportOffsetX: number;
  viewportOffsetY: number;
  viewportZoom: number;
  viewportWidth: number;
  viewportHeight: number;
  viewportDpr: number;
  anchors: Map<string, AnchorTarget> | undefined;
  layout: ReturnType<typeof computeLayout>;
}

// ---------------------------------------------------------------------------
// SlugTextMeasurer — bridges TextMeasurer interface to Slug algorithm
// ---------------------------------------------------------------------------

class SlugTextMeasurer implements TextMeasurer {
  #font: Font;

  constructor(font: Font) {
    this.#font = font;
  }

  measureText(content: string, fontSize: number, maxWidth?: number): TextMetrics {
    if (maxWidth !== undefined && Number.isFinite(maxWidth) && maxWidth > 0) {
      return this.#measureWrappedText(content, fontSize, maxWidth);
    }

    const scale = this.#font.scaleForSize(fontSize);
    const slugData = prepareText(this.#font, content, fontSize);
    const width = slugData.totalAdvance * scale;
    const ascender = this.#font.ascender;
    const descender = this.#font.descender;
    const lineHeight = (ascender - descender) * scale;

    return {
      width,
      height: lineHeight,
      ascender,
      descender,
      lineHeight,
      lines: [{ slugData, width }],
    };
  }

  #measureWrappedText(content: string, fontSize: number, maxWidth: number): TextMetrics {
    const scale = this.#font.scaleForSize(fontSize);
    const ascender = this.#font.ascender;
    const descender = this.#font.descender;
    const lineHeight = (ascender - descender) * scale;
    const lineCache = new Map<
      string,
      { slugData: ReturnType<typeof prepareText>; width: number }
    >();

    const measureLine = (line: string) => {
      const cached = lineCache.get(line);
      if (cached) return cached;
      const slugData = prepareText(this.#font, line, fontSize);
      const measured = { slugData, width: slugData.totalAdvance * scale };
      lineCache.set(line, measured);
      return measured;
    };

    const splitLongToken = (token: string): string[] => {
      if (token.length <= 1) return [token];
      const parts: string[] = [];
      let current = "";

      for (const char of token) {
        const candidate = current + char;
        if (current.length > 0 && measureLine(candidate).width > maxWidth) {
          parts.push(current);
          current = char;
          continue;
        }
        current = candidate;
      }

      if (current.length > 0) {
        parts.push(current);
      }

      return parts;
    };

    const wrappedLines: string[] = [];
    const paragraphs = content.split("\n");

    for (const paragraph of paragraphs) {
      if (paragraph.trim().length === 0) {
        wrappedLines.push("");
        continue;
      }

      const words = paragraph.trim().split(/\s+/);
      let currentLine = "";

      for (const word of words) {
        const candidate = currentLine.length > 0 ? `${currentLine} ${word}` : word;
        if (measureLine(candidate).width <= maxWidth) {
          currentLine = candidate;
          continue;
        }

        if (currentLine.length > 0) {
          wrappedLines.push(currentLine);
          currentLine = "";
        }

        if (measureLine(word).width <= maxWidth) {
          currentLine = word;
          continue;
        }

        const brokenWordParts = splitLongToken(word);
        const lastIndex = brokenWordParts.length - 1;
        for (const [partIndex, part] of brokenWordParts.entries()) {
          if (partIndex === lastIndex) {
            currentLine = part;
          } else {
            wrappedLines.push(part);
          }
        }
      }

      if (currentLine.length > 0) {
        wrappedLines.push(currentLine);
      }
    }

    const lines =
      wrappedLines.length > 0
        ? wrappedLines.map((line) => {
            const measured = measureLine(line);
            return { slugData: measured.slugData, width: measured.width };
          })
        : [{ slugData: measureLine("").slugData, width: 0 }];

    const width = lines.reduce((max, line) => Math.max(max, line.width), 0);

    return {
      width,
      height: lineHeight * lines.length,
      ascender,
      descender,
      lineHeight,
      lines,
    };
  }
}

// ---------------------------------------------------------------------------
// UIRenderer
// ---------------------------------------------------------------------------

export class UIRenderer {
  #textRenderer: TextRenderer;
  #boxPipeline: UIBoxPipeline;
  #iconPipeline: UIIconPipeline;
  #iconCache: UIIconCache;
  #styleResolver: UIStyleResolver;

  #font: Font | null = null;
  #measurer: SlugTextMeasurer | null = null;
  #ready = false;
  #hasPendingIcons = false;
  #justBecameReady = false;

  // Retained scene graph roots — one per unique render target
  #sceneRoots = new Map<string, SceneNode>();
  #sceneLayoutCache = new Map<string, LayoutCacheEntry>();
  // React fiber containers — one per scene key
  #containers = new Map<string, CanvasUIFiberRoot>();

  // Interaction tracking
  #hoveredNode: SceneNode | null = null;
  #activeNode: SceneNode | null = null;
  #dragNode: SceneNode | null = null;
  #dragLastWorld: { x: number; y: number } | null = null;
  #interactionDirty = false;

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat, viewportUniformBuffer: GPUBuffer) {
    this.#textRenderer = new TextRenderer(device, canvasFormat);
    this.#boxPipeline = new UIBoxPipeline(device, canvasFormat, viewportUniformBuffer);
    this.#iconPipeline = new UIIconPipeline(device, canvasFormat, viewportUniformBuffer);
    this.#iconCache = new UIIconCache(device);
    this.#styleResolver = new UIStyleResolver();
    this.#iconCache.onTextureReady = () => {
      this.#hasPendingIcons = true;
    };
  }

  async initialize(): Promise<void> {
    await this.#textRenderer.initialize();
    this.#boxPipeline.initialize();
    this.#iconPipeline.initialize();

    this.#font = this.#textRenderer.font;
    if (this.#font) {
      this.#measurer = new SlugTextMeasurer(this.#font);
    }
    this.#ready = this.#font !== null;
    this.#justBecameReady = this.#ready;
  }

  get isReady(): boolean {
    return this.#ready;
  }

  /** Preload icon SVGs so they're cached before first render. */
  async preloadIcons(svgs: string[]): Promise<void> {
    await this.#iconCache.preloadAll(svgs);
  }

  get hasActiveAnimations(): boolean {
    if (this.#justBecameReady) return true;
    if (this.#interactionDirty) return true;
    if (this.#hasPendingIcons) return true;
    if (this.#styleResolver.isDirty) return true;
    for (const root of this.#sceneRoots.values()) {
      if (hasActiveAnimations(root)) return true;
    }
    return false;
  }

  begin(): void {
    this.#textRenderer.begin();
    this.#boxPipeline.begin();
    this.#iconPipeline.begin();
    this.#justBecameReady = false;
    // NOTE: interactionDirty is NOT cleared here — it must survive until
    // #getCachedLayout reads it in render(). Cleared after layout computation.
    this.#hasPendingIcons = false;
    this.#styleResolver.markClean();
  }

  /**
   * Update a scene's React element tree. Triggers synchronous React reconciliation
   * into the SceneNode tree. Call when inputs change, NOT every frame.
   */
  updateScene(sceneKey: string, element: React.ReactElement | null): void {
    let container = this.#containers.get(sceneKey);
    if (!container) {
      // Root must be type "box" so the layout engine processes it as a container.
      // It has no styling — just a transparent wrapper for React's children.
      const root = new SceneNode("box", null, {});
      this.#sceneRoots.set(sceneKey, root);
      container = createCanvasContainer(root);
      this.#containers.set(sceneKey, container);
    }
    updateCanvasContainer(element, container);
  }

  /**
   * Render a scene's SceneNode tree at a world-space anchor position.
   * Performs layout + GPU draw only (no reconciliation).
   * Can be called multiple times per frame for the same scene key.
   */
  renderScene(
    sceneKey: string,
    anchorX: number,
    anchorY: number,
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    scale = 1,
    anchors?: Map<string, AnchorTarget>,
    viewport?: ViewportInfo,
  ): void {
    if (!this.#ready || !this.#measurer) return;

    const root = this.#sceneRoots.get(sceneKey);
    if (!root) return;

    if (viewport) {
      this.#textRenderer.setViewport({
        offsetX: viewport.offsetX,
        offsetY: viewport.offsetY,
        zoom: viewport.zoom,
        width: viewport.width,
        height: viewport.height,
      });
    }

    const now = performance.now();

    // 1. Prune exited nodes (ghost nodes from removeChild)
    if (pruneExitedNodes(root)) {
      root.bumpRenderVersion();
    }

    // 2. Layout (with scale)
    const layout = this.#getCachedLayout(
      root,
      anchorX,
      anchorY,
      this.#measurer,
      now,
      sceneKey,
      scale,
      anchors,
      viewport,
    );
    this.#interactionDirty = false;

    // ── GPU render pass (boxes, icons, text) ──
    const iconPixelScale = viewport?.zoom ?? 1;

    // Track icon preload state
    for (const layoutIcon of layout.icons) {
      const textureMatch = this.#iconCache.getBest(
        layoutIcon.svg,
        layoutIcon.width,
        layoutIcon.height,
        iconPixelScale,
      );
      if (!textureMatch) {
        this.#hasPendingIcons = true;
        continue;
      }

      const requestedSize = getIconRasterSize(layoutIcon.width, layoutIcon.height, iconPixelScale);
      if (
        !textureMatch.exact &&
        (requestedSize.width > textureMatch.rasterWidth * ICON_RASTER_UPGRADE_THRESHOLD ||
          requestedSize.height > textureMatch.rasterHeight * ICON_RASTER_UPGRADE_THRESHOLD)
      ) {
        this.#hasPendingIcons = true;
      }
    }

    // Single shared render pass for all UI drawing.
    // Three-way merge in strict (zIndex, order) sequence with pipeline switching.
    const pass = encoder.beginRenderPass({
      label: "UI pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "load",
          storeOp: "store",
        },
      ],
    });

    let boxBatch: typeof layout.boxes = [];
    let iconBatch: typeof layout.icons = [];
    let hasQueuedText = false;

    const flushBoxes = () => {
      if (boxBatch.length === 0) return;
      this.#boxPipeline.render(boxBatch, pass);
      boxBatch = [];
    };

    const flushIcons = () => {
      if (iconBatch.length === 0) return;
      this.#iconPipeline.render(iconBatch, this.#iconCache, iconPixelScale, pass);
      iconBatch = [];
    };

    const flushText = () => {
      if (!hasQueuedText) return;
      this.#textRenderer.flush(pass);
      hasQueuedText = false;
    };

    const isBefore = (
      a: { zIndex: number; order: number } | undefined,
      b: { zIndex: number; order: number } | undefined,
    ): boolean => {
      if (!a) return false;
      if (!b) return true;
      return a.zIndex < b.zIndex || (a.zIndex === b.zIndex && a.order <= b.order);
    };

    let boxIndex = 0;
    let iconIndex = 0;
    let textIndex = 0;

    while (
      boxIndex < layout.boxes.length ||
      iconIndex < layout.icons.length ||
      textIndex < layout.texts.length
    ) {
      const nextBox = layout.boxes[boxIndex];
      const nextIcon = layout.icons[iconIndex];
      const nextText = layout.texts[textIndex];

      if (isBefore(nextBox, nextIcon) && isBefore(nextBox, nextText)) {
        flushIcons();
        flushText();
        boxBatch.push(nextBox!);
        boxIndex++;
        continue;
      }

      if (isBefore(nextIcon, nextBox) && isBefore(nextIcon, nextText)) {
        flushBoxes();
        flushText();
        iconBatch.push(nextIcon!);
        iconIndex++;
        continue;
      }

      flushBoxes();
      flushIcons();
      const t = nextText!;
      this.#textRenderer.drawText(
        t.slugData as ReturnType<typeof prepareText>,
        t.x,
        t.y,
        t.fontSize,
        t.color.r,
        t.color.g,
        t.color.b,
        t.color.a * t.opacity,
      );
      hasQueuedText = true;
      textIndex++;
    }

    flushBoxes();
    flushIcons();
    flushText();
    pass.end();
  }

  // ---------------------------------------------------------------------------
  // Event handling
  // ---------------------------------------------------------------------------

  /**
   * Handle a pointer event against all scene roots.
   * Returns true if a UI element consumed the event.
   */
  handlePointerEvent(type: "down" | "up" | "move", worldX: number, worldY: number): boolean {
    // Handle active drag
    if (type === "move" && this.#dragNode) {
      const dx = worldX - (this.#dragLastWorld?.x ?? worldX);
      const dy = worldY - (this.#dragLastWorld?.y ?? worldY);
      this.#dragNode.dragOffset.x += dx;
      this.#dragNode.dragOffset.y += dy;
      this.#dragLastWorld = { x: worldX, y: worldY };
      const onDrag = this.#dragNode.props["onDrag"] as ((e: UIDragEvent) => void) | undefined;
      onDrag?.({ worldX, worldY, deltaX: dx, deltaY: dy });
      this.#interactionDirty = true;
      return true;
    }

    const hit = this.#hitTestAll(worldX, worldY);

    // Update hover state
    if (hit !== this.#hoveredNode) {
      if (this.#hoveredNode) this.#hoveredNode.isHovered = false;
      if (hit) hit.isHovered = true;
      this.#hoveredNode = hit;
      this.#interactionDirty = true;
    }

    if (type === "down") {
      // Set active state
      if (this.#activeNode && this.#activeNode !== hit) {
        this.#activeNode.isActive = false;
      }
      if (hit) {
        hit.isActive = true;
        this.#activeNode = hit;
        this.#interactionDirty = true;

        // Start drag if draggable
        if (hit.props["draggable"]) {
          this.#dragNode = hit;
          this.#dragLastWorld = { x: worldX, y: worldY };
        }

        const handler = hit.props["onPointerDown"] as ((e: UIPointerEvent) => void) | undefined;
        handler?.({ worldX, worldY, type });
      }
      return hit != null;
    }

    if (type === "up") {
      // End drag
      if (this.#dragNode) {
        this.#dragNode = null;
        this.#dragLastWorld = null;
      }

      // Clear active state
      if (this.#activeNode) {
        this.#activeNode.isActive = false;
        this.#activeNode = null;
        this.#interactionDirty = true;
      }

      if (hit) {
        const handler = hit.props["onPointerUp"] as ((e: UIPointerEvent) => void) | undefined;
        handler?.({ worldX, worldY, type });
        const clickHandler = hit.props["onClick"] as ((e: UIPointerEvent) => void) | undefined;
        clickHandler?.({ worldX, worldY, type });
      }
      return hit != null;
    }

    return hit != null;
  }

  /** Hit test across all scene roots. */
  #hitTestAll(worldX: number, worldY: number): SceneNode | null {
    // Check all roots (later-rendered roots are on top)
    const roots = [...this.#sceneRoots.values()];
    for (let i = roots.length - 1; i >= 0; i--) {
      const hit = hitTest(roots[i]!, worldX, worldY);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Destroy a scene — unmounts the React container and removes the SceneNode tree.
   * Call when the scene is no longer needed (e.g. entity deleted).
   */
  destroyScene(sceneKey: string): void {
    const container = this.#containers.get(sceneKey);
    if (container) {
      unmountCanvasContainer(container);
      this.#containers.delete(sceneKey);
    }
    this.#sceneRoots.delete(sceneKey);
    this.#sceneLayoutCache.delete(sceneKey);
  }

  destroy(): void {
    // Unmount all React containers
    for (const container of this.#containers.values()) {
      unmountCanvasContainer(container);
    }
    this.#containers.clear();

    this.#textRenderer.destroy();
    this.#boxPipeline.destroy();
    this.#iconPipeline.destroy();
    this.#iconCache.destroy();
    this.#styleResolver.destroy();
    this.#font = null;
    this.#measurer = null;
    this.#ready = false;
    this.#sceneRoots.clear();
    this.#sceneLayoutCache.clear();
    this.#hoveredNode = null;
  }

  #getCachedLayout(
    root: SceneNode,
    anchorX: number,
    anchorY: number,
    measurer: SlugTextMeasurer,
    now: number,
    sceneKey: string,
    scale: number,
    anchors: Map<string, AnchorTarget> | undefined,
    viewport: ViewportInfo | undefined,
  ): ReturnType<typeof computeLayout> {
    const cache = this.#sceneLayoutCache.get(sceneKey) ?? null;
    const dependsOnViewport = cache?.dependsOnViewport ?? sceneDependsOnViewport(root);
    const structurallyValid =
      !this.#interactionDirty &&
      !this.#styleResolver.isDirty &&
      !hasActiveAnimations(root) &&
      cache !== null &&
      cache.renderVersion === root.renderVersion &&
      cache.anchorX === anchorX &&
      cache.anchorY === anchorY &&
      cache.scale === scale &&
      cache.anchors === anchors;

    // When only viewport offset changed (panning), reuse the cached layout.
    // World-space UI positions don't change during a pan — the viewport uniform
    // in the GPU shaders handles the shift.
    const canReuse =
      structurallyValid &&
      (!dependsOnViewport ||
        (cache!.viewportZoom === (viewport?.zoom ?? 0) &&
          cache!.viewportWidth === (viewport?.width ?? 0) &&
          cache!.viewportHeight === (viewport?.height ?? 0) &&
          cache!.viewportDpr === (viewport?.dpr ?? 0)));

    if (canReuse) {
      return cache.layout;
    }

    const layout = computeLayout(
      root,
      anchorX,
      anchorY,
      measurer,
      now,
      this.#styleResolver,
      anchors,
      scale,
      viewport,
      cache?.layout,
    );

    const nextCache: LayoutCacheEntry = {
      renderVersion: root.renderVersion,
      anchorX,
      anchorY,
      scale,
      dependsOnViewport,
      viewportOffsetX: viewport?.offsetX ?? 0,
      viewportOffsetY: viewport?.offsetY ?? 0,
      viewportZoom: viewport?.zoom ?? 0,
      viewportWidth: viewport?.width ?? 0,
      viewportHeight: viewport?.height ?? 0,
      viewportDpr: viewport?.dpr ?? 0,
      anchors,
      layout,
    };

    this.#sceneLayoutCache.set(sceneKey, nextCache);

    return layout;
  }
}

function sceneDependsOnViewport(root: SceneNode): boolean {
  if ((root.props["position"] as string | undefined) === "fixed") {
    return true;
  }

  for (let i = 0; i < root.children.length; i++) {
    if (sceneDependsOnViewport(root.children[i]!)) {
      return true;
    }
  }

  return false;
}
