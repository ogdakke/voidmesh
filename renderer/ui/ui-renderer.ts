import type React from "react";
import type { Font } from "text-shaper";
import { TextRenderer } from "../text/text-renderer.ts";
import { UIBoxPipeline } from "./ui-box-pipeline.ts";
import { UIBlurPipeline } from "./ui-blur-pipeline.ts";
import { UIFilterCompositePipeline } from "./ui-filter-composite-pipeline.ts";
import { UIIconPipeline } from "./ui-icon-pipeline.ts";
import { UILinePipeline } from "./ui-line-pipeline.ts";
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
  type UILayoutBox,
  type UILayoutIcon,
  type UILayoutLine,
  type UILayoutText,
  type ViewportInfo,
  type TextMeasurer,
  type TextMetrics,
} from "./ui-layout.ts";
import { hitTest, findScrollableNode } from "./hit-test.ts";
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

type UIRenderItem =
  | { kind: "box"; data: UILayoutBox }
  | { kind: "text"; data: UILayoutText }
  | { kind: "icon"; data: UILayoutIcon }
  | { kind: "line"; data: UILayoutLine };

interface RectBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function buildRenderItems(layout: ReturnType<typeof computeLayout>): UIRenderItem[] {
  const items: UIRenderItem[] = [];
  for (const box of layout.boxes) items.push({ kind: "box", data: box });
  for (const text of layout.texts) items.push({ kind: "text", data: text });
  for (const icon of layout.icons) items.push({ kind: "icon", data: icon });
  for (const line of layout.lines) items.push({ kind: "line", data: line });
  items.sort((a, b) => {
    const z = a.data.zIndex - b.data.zIndex;
    if (z !== 0) return z;
    return a.data.order - b.data.order;
  });
  return items;
}

function expandBounds(bounds: RectBounds, amount: number): RectBounds {
  return {
    left: bounds.left - amount,
    top: bounds.top - amount,
    right: bounds.right + amount,
    bottom: bounds.bottom + amount,
  };
}

function getItemBounds(item: UIRenderItem): RectBounds | null {
  switch (item.kind) {
    case "box":
      return {
        left: item.data.x,
        top: item.data.y,
        right: item.data.x + item.data.width,
        bottom: item.data.y + item.data.height,
      };
    case "icon":
      return {
        left: item.data.x,
        top: item.data.y,
        right: item.data.x + item.data.width,
        bottom: item.data.y + item.data.height,
      };
    case "line": {
      const halfStroke = item.data.strokeWidth * 0.5;
      return {
        left: Math.min(item.data.startX, item.data.endX) - halfStroke,
        top: Math.min(item.data.startY, item.data.endY) - halfStroke,
        right: Math.max(item.data.startX, item.data.endX) + halfStroke,
        bottom: Math.max(item.data.startY, item.data.endY) + halfStroke,
      };
    }
    case "text": {
      const estimatedHeight = Math.max(
        item.data.fontSize,
        item.data.fontSize - item.data.descender,
      );
      return {
        left: item.data.x - item.data.totalWidth * 0.5,
        top: item.data.y - estimatedHeight,
        right: item.data.x + item.data.totalWidth * 0.5,
        bottom: item.data.y + item.data.fontSize * 0.25,
      };
    }
  }
}

function mergeBounds(a: RectBounds | null, b: RectBounds | null): RectBounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

function collectAncestorChain(node: SceneNode | null): SceneNode[] {
  const chain: SceneNode[] = [];
  let cursor = node;
  while (cursor) {
    chain.push(cursor);
    cursor = cursor.parent;
  }
  return chain;
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
  #device: GPUDevice;
  #canvasFormat: GPUTextureFormat;
  #textRenderer: TextRenderer;
  #boxPipeline: UIBoxPipeline;
  #blurPipeline: UIBlurPipeline;
  #filterCompositePipeline: UIFilterCompositePipeline;
  #iconPipeline: UIIconPipeline;
  #linePipeline: UILinePipeline;
  #iconCache: UIIconCache;
  #styleResolver: UIStyleResolver;
  #scratchTextures = new Map<string, { texture: GPUTexture; width: number; height: number }>();

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
    this.#device = device;
    this.#canvasFormat = canvasFormat;
    this.#textRenderer = new TextRenderer(device, canvasFormat);
    this.#boxPipeline = new UIBoxPipeline(device, canvasFormat, viewportUniformBuffer);
    this.#blurPipeline = new UIBlurPipeline(device, canvasFormat);
    this.#filterCompositePipeline = new UIFilterCompositePipeline(
      device,
      canvasFormat,
      viewportUniformBuffer,
    );
    this.#iconPipeline = new UIIconPipeline(device, canvasFormat, viewportUniformBuffer);
    this.#linePipeline = new UILinePipeline(device, canvasFormat, viewportUniformBuffer);
    this.#iconCache = new UIIconCache(device);
    this.#styleResolver = new UIStyleResolver();
    this.#iconCache.onTextureReady = () => {
      this.#hasPendingIcons = true;
    };
  }

  async initialize(): Promise<void> {
    await this.#textRenderer.initialize();
    this.#boxPipeline.initialize();
    this.#blurPipeline.initialize();
    this.#filterCompositePipeline.initialize();
    this.#iconPipeline.initialize();
    this.#linePipeline.initialize();

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
    this.#blurPipeline.begin();
    this.#filterCompositePipeline.begin();
    this.#iconPipeline.begin();
    this.#linePipeline.begin();
    this.#justBecameReady = false;
    this.#hasPendingIcons = false;
    this.#styleResolver.markClean();
  }

  /** Call after all renderScene calls for this frame. Clears per-frame dirty flags. */
  endFrame(): void {
    this.#interactionDirty = false;
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
  // TODO: GPU scissor clipping for overflow:scroll containers
  renderScene(
    sceneKey: string,
    anchorX: number,
    anchorY: number,
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    targetTexture?: GPUTexture,
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

    const items = buildRenderItems(layout);
    if (items.length === 0) return;

    let activeTargetPass: GPURenderPassEncoder | null = null;
    let backdropSourceTexture: GPUTexture | null = null;
    const backdropBlurEntries: { radius: number; texture: GPUTexture }[] = [];

    if (targetTexture && viewport) {
      backdropSourceTexture = this.#getOrCreateScratchTexture(
        "backdrop-source",
        "UI backdrop source",
        viewport.width,
        viewport.height,
      );
      encoder.copyTextureToTexture(
        { texture: targetTexture },
        { texture: backdropSourceTexture },
        { width: viewport.width, height: viewport.height },
      );
    }

    const beginTargetPass = () => {
      if (activeTargetPass) return activeTargetPass;
      activeTargetPass = encoder.beginRenderPass({
        label: "UI pass",
        colorAttachments: [
          {
            view: targetView,
            loadOp: "load",
            storeOp: "store",
          },
        ],
      });
      return activeTargetPass;
    };

    const endTargetPass = () => {
      if (!activeTargetPass) return;
      activeTargetPass.end();
      activeTargetPass = null;
    };

    const renderDirectItem = (item: UIRenderItem) => {
      const pass = beginTargetPass();
      if (item.kind === "box") {
        if (!item.data.background && item.data.borderWidth <= 0) return;
        this.#boxPipeline.render([item.data], pass);
        return;
      }

      if (item.kind === "icon") {
        this.#iconPipeline.render([item.data], this.#iconCache, iconPixelScale, pass);
        return;
      }

      if (item.kind === "line") {
        this.#linePipeline.render([item.data], pass);
        return;
      }

      this.#textRenderer.drawText(
        item.data.slugData as ReturnType<typeof prepareText>,
        item.data.x,
        item.data.y,
        item.data.fontSize,
        item.data.color.r,
        item.data.color.g,
        item.data.color.b,
        item.data.color.a * item.data.opacity,
      );
      this.#textRenderer.flush(pass);
    };

    const getBackdropBlurTexture = (blurRadius: number): GPUTexture | null => {
      if (!viewport || !backdropSourceTexture) return null;
      endTargetPass();

      for (const entry of backdropBlurEntries) {
        if (Math.abs(entry.radius - blurRadius) < 0.001) {
          return entry.texture;
        }
      }

      const blurTexture = this.#getOrCreateScratchTexture(
        `backdrop-blur-${backdropBlurEntries.length}`,
        `UI backdrop blur output ${backdropBlurEntries.length}`,
        viewport.width,
        viewport.height,
      );
      this.#blurPipeline.encodeBlur(
        encoder,
        backdropSourceTexture,
        blurTexture,
        viewport.width,
        viewport.height,
        blurRadius,
      );
      backdropBlurEntries.push({ radius: blurRadius, texture: blurTexture });
      return blurTexture;
    };

    let itemIndex = 0;
    while (itemIndex < items.length) {
      const item = items[itemIndex]!;

      if (item.kind === "box" && item.data.filterBlurRadius > 0) {
        endTargetPass();
        const subtreeEndIndex = this.#findSubtreeEndIndex(
          items,
          itemIndex,
          item.data.subtreeEndOrder,
        );
        const bounds = this.#getSubtreeBounds(items, itemIndex, subtreeEndIndex);

        if (viewport && bounds) {
          const filterSource = this.#getOrCreateScratchTexture(
            "filter-source",
            "UI filter source",
            viewport.width,
            viewport.height,
          );
          const filterOutput = this.#getOrCreateScratchTexture(
            "filter-output",
            "UI filter output",
            viewport.width,
            viewport.height,
          );

          this.#renderItemsToTexture(
            items,
            itemIndex,
            subtreeEndIndex,
            encoder,
            filterSource.createView(),
          );
          this.#blurPipeline.encodeBlur(
            encoder,
            filterSource,
            filterOutput,
            viewport.width,
            viewport.height,
            item.data.filterBlurRadius,
          );

          const paddedBounds = expandBounds(bounds, Math.max(2, item.data.filterBlurRadius * 2));
          this.#filterCompositePipeline.render(
            encoder,
            targetView,
            filterOutput,
            {
              x: paddedBounds.left,
              y: paddedBounds.top,
              width: paddedBounds.right - paddedBounds.left,
              height: paddedBounds.bottom - paddedBounds.top,
            },
            0,
            false,
          );
        }

        itemIndex = subtreeEndIndex;
        continue;
      }

      if (item.kind === "box" && item.data.backdropBlurRadius > 0) {
        const backdropBlurTexture = getBackdropBlurTexture(item.data.backdropBlurRadius);
        if (backdropBlurTexture) {
          this.#filterCompositePipeline.render(
            encoder,
            targetView,
            backdropBlurTexture,
            {
              x: item.data.x,
              y: item.data.y,
              width: item.data.width,
              height: item.data.height,
            },
            item.data.borderRadius,
            true,
          );
        }
      }

      renderDirectItem(item);
      itemIndex++;
    }

    endTargetPass();
  }

  #getOrCreateScratchTexture(
    key: string,
    label: string,
    width: number,
    height: number,
  ): GPUTexture {
    const cached = this.#scratchTextures.get(key);
    if (cached && cached.width === width && cached.height === height) {
      return cached.texture;
    }

    cached?.texture.destroy();
    const texture = this.#device.createTexture({
      label: `${label} (${width}x${height})`,
      size: [width, height],
      format: this.#canvasFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });
    this.#scratchTextures.set(key, { texture, width, height });
    return texture;
  }

  #renderItemsToTexture(
    items: UIRenderItem[],
    startIndex: number,
    endIndex: number,
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
  ): void {
    const pass = encoder.beginRenderPass({
      label: "UI offscreen subtree pass",
      colorAttachments: [
        {
          view: targetView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });

    let hasQueuedText = false;
    for (let index = startIndex; index < endIndex; index++) {
      const item = items[index]!;
      if (item.kind === "box") {
        if (!item.data.background && item.data.borderWidth <= 0) continue;
        if (hasQueuedText) {
          this.#textRenderer.flush(pass);
          hasQueuedText = false;
        }
        this.#boxPipeline.render([item.data], pass);
        continue;
      }
      if (item.kind === "icon") {
        if (hasQueuedText) {
          this.#textRenderer.flush(pass);
          hasQueuedText = false;
        }
        this.#iconPipeline.render([item.data], this.#iconCache, 1, pass);
        continue;
      }
      if (item.kind === "line") {
        if (hasQueuedText) {
          this.#textRenderer.flush(pass);
          hasQueuedText = false;
        }
        this.#linePipeline.render([item.data], pass);
        continue;
      }

      this.#textRenderer.drawText(
        item.data.slugData as ReturnType<typeof prepareText>,
        item.data.x,
        item.data.y,
        item.data.fontSize,
        item.data.color.r,
        item.data.color.g,
        item.data.color.b,
        item.data.color.a * item.data.opacity,
      );
      hasQueuedText = true;
    }

    if (hasQueuedText) {
      this.#textRenderer.flush(pass);
    }
    pass.end();
  }

  #findSubtreeEndIndex(items: UIRenderItem[], startIndex: number, subtreeEndOrder: number): number {
    let endIndex = startIndex + 1;
    while (endIndex < items.length && items[endIndex]!.data.order <= subtreeEndOrder) {
      endIndex++;
    }
    return endIndex;
  }

  #getSubtreeBounds(
    items: UIRenderItem[],
    startIndex: number,
    endIndex: number,
  ): RectBounds | null {
    let bounds: RectBounds | null = null;
    for (let index = startIndex; index < endIndex; index++) {
      bounds = mergeBounds(bounds, getItemBounds(items[index]!));
    }
    return bounds;
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
      const oldNode = this.#hoveredNode;
      const newNode = hit;
      const oldChain = collectAncestorChain(oldNode);
      const newChain = collectAncestorChain(newNode);
      const oldSet = new Set(oldChain);
      const newSet = new Set(newChain);

      for (const node of oldChain) {
        if (!newSet.has(node)) {
          node.isHovered = false;
        }
      }
      for (const node of newChain) {
        if (!oldSet.has(node)) {
          node.isHovered = true;
        }
      }
      this.#hoveredNode = newNode;
      this.#interactionDirty = true;

      // Fire onHoverLeave for nodes that actually left the hover chain.
      for (const node of oldChain) {
        if (!newSet.has(node)) {
          const leave = node.props["onHoverLeave"] as ((node: SceneNode) => void) | undefined;
          leave?.(node);
        }
      }

      // Fire onHoverEnter for nodes that actually entered the hover chain.
      for (const node of newChain) {
        if (!oldSet.has(node)) {
          const enter = node.props["onHoverEnter"] as ((node: SceneNode) => void) | undefined;
          enter?.(node);
        }
      }
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
   * Handle a wheel event against all scene roots.
   * Finds the frontmost scrollable container under the pointer and applies scroll delta.
   * Returns true if the event was consumed (a scrollable node was found and scroll changed).
   */
  handleWheelEvent(_deltaX: number, deltaY: number, worldX: number, worldY: number): boolean {
    const roots = [...this.#sceneRoots.values()];
    for (let i = roots.length - 1; i >= 0; i--) {
      const scrollable = findScrollableNode(roots[i]!, worldX, worldY);
      if (scrollable) {
        const maxScroll = Math.max(0, scrollable.contentSize.height - scrollable.layout.height);
        const oldOffset = scrollable.scrollOffset.y;
        scrollable.scrollOffset.y = Math.max(0, Math.min(maxScroll, oldOffset + deltaY));
        if (scrollable.scrollOffset.y !== oldOffset) {
          this.#interactionDirty = true;
          return true;
        }
        // Scrollable found but at boundary — still consume to prevent canvas pan
        return true;
      }
    }
    return false;
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
    this.#blurPipeline.destroy();
    this.#filterCompositePipeline.destroy();
    this.#iconPipeline.destroy();
    this.#linePipeline.destroy();
    this.#iconCache.destroy();
    this.#styleResolver.destroy();
    for (const entry of this.#scratchTextures.values()) {
      entry.texture.destroy();
    }
    this.#scratchTextures.clear();
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

    // World-space UI positions don't change during a pan, but fixed-position UI
    // is resolved against viewport offset during layout. Fixed scenes therefore
    // must relayout when viewport offset changes.
    const canReuse =
      structurallyValid &&
      (!dependsOnViewport ||
        (cache!.viewportOffsetX === (viewport?.offsetX ?? 0) &&
          cache!.viewportOffsetY === (viewport?.offsetY ?? 0) &&
          cache!.viewportZoom === (viewport?.zoom ?? 0) &&
          cache!.viewportWidth === (viewport?.width ?? 0) &&
          cache!.viewportHeight === (viewport?.height ?? 0) &&
          cache!.viewportDpr === (viewport?.dpr ?? 0)));

    if (canReuse) {
      return cache.layout;
    }

    // Note: interactionDirty is NOT cleared here — it must remain true for all
    // scenes within the same frame. Cleared at the end of all renderScene calls
    // via the endFrame() method.
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
