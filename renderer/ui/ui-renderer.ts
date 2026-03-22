import type { Font } from "text-shaper";
import { TextRenderer } from "../text/text-renderer.ts";
import { UIBoxPipeline } from "./ui-box-pipeline.ts";
import { UIIconPipeline } from "./ui-icon-pipeline.ts";
import { UIIconCache } from "./ui-icon-cache.ts";
import { prepareText } from "../text/slug.ts";
import type { UIElement, UIPointerEvent, UIDragEvent } from "./elements.ts";
import { SceneNode, hasActiveAnimations } from "./scene-node.ts";
import { reconcile, pruneExitedNodes } from "./reconciler.ts";
import {
  computeLayout,
  type AnchorTarget,
  type ViewportInfo,
  type TextMeasurer,
  type TextMetrics,
} from "./ui-layout.ts";
import { hitTest } from "./hit-test.ts";
import { UIStyleResolver } from "./style-resolver.ts";

// ---------------------------------------------------------------------------
// SlugTextMeasurer — bridges TextMeasurer interface to Slug algorithm
// ---------------------------------------------------------------------------

class SlugTextMeasurer implements TextMeasurer {
  #font: Font;

  constructor(font: Font) {
    this.#font = font;
  }

  measureText(content: string, fontSize: number): TextMetrics {
    const scale = this.#font.scaleForSize(fontSize);
    const slugData = prepareText(this.#font, content, fontSize);
    const width = slugData.totalAdvance * scale;
    const ascender = this.#font.ascender;
    const descender = this.#font.descender;
    const height = (ascender - descender) * scale;

    return {
      width,
      height,
      ascender,
      descender,
      slugData,
      totalAdvance: slugData.totalAdvance,
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
  #defaultRoot: SceneNode | null = null;

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
    if (this.#defaultRoot && hasActiveAnimations(this.#defaultRoot)) return true;
    return false;
  }

  begin(): void {
    this.#textRenderer.begin();
    this.#boxPipeline.begin();
    this.#iconPipeline.begin();
    this.#justBecameReady = false;
    this.#interactionDirty = false;
    this.#hasPendingIcons = false;
    this.#styleResolver.markClean();
  }

  /**
   * Render a UIElement tree at a world-space anchor position.
   *
   * @param tree       UIElement tree (from JSX)
   * @param anchorX    Center-X in world space
   * @param anchorY    Bottom-edge Y in world space
   * @param encoder    GPU command encoder
   * @param targetView Render target
   * @param sceneKey   Key for retaining separate scene graph roots
   * @param scale      Size multiplier (dpr/zoom for screen-space, 1 for world-space)
   * @param anchors    Entity bounds for anchor resolution
   * @param viewport   Viewport info for resolving position: "fixed" elements
   */
  render(
    tree: UIElement,
    anchorX: number,
    anchorY: number,
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    sceneKey?: string,
    scale = 1,
    anchors?: Map<string, AnchorTarget>,
    viewport?: ViewportInfo,
  ): void {
    if (!this.#ready || !this.#measurer) return;
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

    // 1. Reconcile
    let existingRoot: SceneNode | null;
    if (sceneKey) {
      existingRoot = this.#sceneRoots.get(sceneKey) ?? null;
    } else {
      existingRoot = this.#defaultRoot;
    }

    const root = reconcile(tree, existingRoot);
    if (!root) return;

    if (sceneKey) {
      this.#sceneRoots.set(sceneKey, root);
    } else {
      this.#defaultRoot = root;
    }

    // 2. Layout (with scale)
    const layout = computeLayout(
      root,
      anchorX,
      anchorY,
      this.#measurer,
      now,
      this.#styleResolver,
      anchors,
      scale,
      viewport,
    );
    const iconPixelScale = viewport?.zoom ?? 1;

    // Track icon preload state
    for (const layoutIcon of layout.icons) {
      if (
        !this.#iconCache.has(layoutIcon.svg, layoutIcon.width, layoutIcon.height, iconPixelScale)
      ) {
        this.#hasPendingIcons = true;
      }
    }

    type RenderCommand =
      | { kind: "box"; order: number; zIndex: number; item: (typeof layout.boxes)[number] }
      | { kind: "icon"; order: number; zIndex: number; item: (typeof layout.icons)[number] }
      | { kind: "text"; order: number; zIndex: number; item: (typeof layout.texts)[number] };

    const commands: RenderCommand[] = [
      ...layout.boxes.map((item) => ({
        kind: "box" as const,
        order: item.order,
        zIndex: item.zIndex,
        item,
      })),
      ...layout.icons.map((item) => ({
        kind: "icon" as const,
        order: item.order,
        zIndex: item.zIndex,
        item,
      })),
      ...layout.texts.map((item) => ({
        kind: "text" as const,
        order: item.order,
        zIndex: item.zIndex,
        item,
      })),
    ].sort((a, b) => a.zIndex - b.zIndex || a.order - b.order);

    let boxBatch: typeof layout.boxes = [];
    let iconBatch: typeof layout.icons = [];
    let hasQueuedText = false;

    const flushBoxes = () => {
      if (boxBatch.length === 0) return;
      this.#boxPipeline.render(boxBatch, encoder, targetView);
      boxBatch = [];
    };

    const flushIcons = () => {
      if (iconBatch.length === 0) return;
      this.#iconPipeline.render(iconBatch, this.#iconCache, iconPixelScale, encoder, targetView);
      iconBatch = [];
    };

    const flushText = () => {
      if (!hasQueuedText) return;
      this.#textRenderer.flush(encoder, targetView);
      hasQueuedText = false;
    };

    for (const command of commands) {
      if (command.kind === "box") {
        flushIcons();
        flushText();
        boxBatch.push(command.item);
        continue;
      }

      if (command.kind === "icon") {
        flushBoxes();
        flushText();
        iconBatch.push(command.item);
        continue;
      }

      flushBoxes();
      flushIcons();
      const t = command.item;
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
    }

    flushBoxes();
    flushIcons();
    flushText();

    // 6. Prune exited nodes
    pruneExitedNodes(root);
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
    if (this.#defaultRoot) roots.push(this.#defaultRoot);

    for (let i = roots.length - 1; i >= 0; i--) {
      const hit = hitTest(roots[i]!, worldX, worldY);
      if (hit) return hit;
    }
    return null;
  }

  removeScene(sceneKey: string): void {
    const root = this.#sceneRoots.get(sceneKey);
    if (root) root.beginExit();
    this.#sceneRoots.delete(sceneKey);
  }

  destroy(): void {
    this.#textRenderer.destroy();
    this.#boxPipeline.destroy();
    this.#iconPipeline.destroy();
    this.#iconCache.destroy();
    this.#styleResolver.destroy();
    this.#font = null;
    this.#measurer = null;
    this.#ready = false;
    this.#sceneRoots.clear();
    this.#defaultRoot = null;
    this.#hoveredNode = null;
  }
}
