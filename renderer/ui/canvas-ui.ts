// ---------------------------------------------------------------------------
// Canvas UI — Unified overlay UI singleton
// ---------------------------------------------------------------------------
//
// Manages fixed-position overlay UI (context menu, future tooltips/toasts)
// as a single React root. The canvas renderer calls render() once per frame;
// the React layer sets state directly on this singleton.
//
// Entity labels and debug overlay are NOT managed here — they have different
// rendering requirements (world-anchored, per-entity interleaving).
//

import { createElement } from "react";
import type { UIRenderer } from "./ui-renderer.ts";
import type { ContextMenuActions } from "./context-menu-actions.ts";
import type { CanvasContextMenuProps } from "./components/canvas-context-menu.tsx";
import { contextMenuController } from "./context-menu-controller.ts";
import { CanvasUIRoot } from "./components/canvas-ui-root.tsx";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContextMenuLiveProps = Omit<
  CanvasContextMenuProps,
  "state" | "actions" | "menuX" | "menuY" | "activeSubmenuId"
>;

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

class CanvasUI {
  #uiRenderer: UIRenderer | null = null;

  // Context menu state (set from React layer)
  #contextMenuActions: ContextMenuActions | null = null;
  #contextMenuProps: ContextMenuLiveProps | null = null;

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  initialize(uiRenderer: UIRenderer): void {
    this.#uiRenderer = uiRenderer;
  }

  // ---------------------------------------------------------------------------
  // Public API — React layer calls these directly
  // ---------------------------------------------------------------------------

  contextMenuActions(actions: ContextMenuActions): void {
    this.#contextMenuActions = actions;
  }

  contextMenuProps(props: ContextMenuLiveProps): void {
    this.#contextMenuProps = props;
  }

  // ---------------------------------------------------------------------------
  // State queries
  // ---------------------------------------------------------------------------

  get isReady(): boolean {
    return this.#uiRenderer?.isReady ?? false;
  }

  get hasActiveAnimations(): boolean {
    return this.#uiRenderer?.hasActiveAnimations ?? false;
  }

  // ---------------------------------------------------------------------------
  // Event forwarding
  // ---------------------------------------------------------------------------

  handlePointerEvent(type: "down" | "up" | "move", worldX: number, worldY: number): boolean {
    return this.#uiRenderer?.handlePointerEvent(type, worldX, worldY) ?? false;
  }

  handleWheelEvent(deltaX: number, deltaY: number, worldX: number, worldY: number): boolean {
    return this.#uiRenderer?.handleWheelEvent(deltaX, deltaY, worldX, worldY) ?? false;
  }

  // ---------------------------------------------------------------------------
  // Per-frame render — called once by the canvas renderer
  // ---------------------------------------------------------------------------

  render(
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    viewport: { offset: { x: number; y: number }; zoom: number },
    width: number,
    height: number,
    dpr: number,
  ): void {
    if (!this.#uiRenderer?.isReady) return;

    const viewportInfo = {
      offsetX: viewport.offset.x,
      offsetY: viewport.offset.y,
      zoom: viewport.zoom,
      width,
      height,
      dpr,
    };

    // Build context menu position from world coords → CSS-pixel offsets
    // Layout engine handles viewport clamping via contain="viewport"
    const cmState = contextMenuController.state;
    let contextMenu: CanvasContextMenuProps | null = null;

    if (contextMenuController.isOpen && this.#contextMenuActions && this.#contextMenuProps) {
      // Convert world position to CSS pixels from viewport edge (unclamped)
      const menuX = ((cmState.worldX - viewport.offset.x) * viewport.zoom) / dpr;
      const menuY = ((cmState.worldY - viewport.offset.y) * viewport.zoom) / dpr;

      contextMenu = {
        state: cmState,
        actions: this.#contextMenuActions,
        ...this.#contextMenuProps,
        menuX,
        menuY,
        activeSubmenuId: contextMenuController.activeSubmenuId,
      };
    }

    this.#uiRenderer.updateScene("canvas-ui", createElement(CanvasUIRoot, { contextMenu }));
    this.#uiRenderer.renderScene(
      "canvas-ui",
      0,
      0,
      encoder,
      targetView,
      dpr,
      undefined,
      viewportInfo,
    );
  }
}

export const canvasUI = new CanvasUI();
