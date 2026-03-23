// ---------------------------------------------------------------------------
// Canvas UI — Unified overlay UI singleton
// ---------------------------------------------------------------------------
//
// Manages fixed-position overlay UI (context menu, perf HUD, future tooltips/toasts)
// as a single React root. The canvas renderer calls render() once per frame;
// the React layer sets state directly on this singleton, but React reconciliation
// only runs when scene inputs actually change.

import { createElement } from "react";
import type { PerfOverlaySnapshot } from "../../engine/perf-overlay.ts";
import type { UIRenderer } from "./ui-renderer.ts";
import type { ContextMenuActions } from "./context-menu-actions.ts";
import type { CanvasContextMenuProps } from "./components/canvas-context-menu.tsx";
import { CanvasContextMenu, SHOW_SAFE_POLYGON_DEBUG } from "./components/canvas-context-menu.tsx";
import { PerfHud } from "./debug-ui.tsx";
import { contextMenuController } from "./context-menu-controller.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContextMenuLiveProps = Omit<
  CanvasContextMenuProps,
  "state" | "actions" | "menuX" | "menuY" | "activeSubmenuId" | "screenScale" | "debugTick"
>;

type ViewportInfo = {
  offsetX: number;
  offsetY: number;
  zoom: number;
  width: number;
  height: number;
  dpr: number;
};

type ContextMenuSceneInputs = {
  actions: ContextMenuActions | null;
  activeSubmenuId: string | null;
  menuX: number;
  menuY: number;
  screenScale: number;
  debugTick: number;
  props: ContextMenuLiveProps | null;
  state: Readonly<CanvasContextMenuProps["state"]> | null;
};

const PERF_SCENE_KEY = "canvas-ui-perf-hud";
const CONTEXT_MENU_SCENE_KEY = "canvas-ui-context-menu";
const CONTEXT_MENU_ACTION_KEYS = [
  "paste",
  "saveWorkspace",
  "saveAsWorkspace",
  "openWorkspace",
  "toggleSnapToGrid",
  "changeShaderType",
  "changeShape",
  "changeDitheringKind",
  "changeAsciiKind",
  "toggleAsciiInvert",
  "changeGlassKind",
  "changeGlitchKind",
  "changePalette",
  "triggerPaletteUpload",
  "toggleShowOriginal",
  "togglePreserveColors",
  "toggleReversePalette",
  "copyImage",
  "saveAsFormat",
  "saveAll",
  "copyEffects",
  "pasteEffects",
  "bringToFront",
  "sendToBack",
  "duplicate",
  "upscale",
  "exportAnimated",
  "reset",
  "deleteEntity",
  "close",
] as const satisfies readonly (keyof ContextMenuActions)[];

type BooleanOptionState = CanvasContextMenuProps["showOriginal"];
type StringOptionState = CanvasContextMenuProps["shape"];

function sameArray<T>(current: readonly T[], next: readonly T[]): boolean {
  if (current === next) return true;
  if (current.length !== next.length) return false;
  for (let index = 0; index < current.length; index++) {
    if (!Object.is(current[index], next[index])) return false;
  }
  return true;
}

function sameBooleanOptionState(current: BooleanOptionState, next: BooleanOptionState): boolean {
  return (
    current.supported === next.supported &&
    current.value === next.value &&
    current.mixed === next.mixed
  );
}

function sameStringOptionState(current: StringOptionState, next: StringOptionState): boolean {
  return (
    current.supported === next.supported &&
    current.value === next.value &&
    current.mixed === next.mixed &&
    sameArray(current.values, next.values)
  );
}

function sameContextMenuProps(
  current: ContextMenuLiveProps | null,
  next: ContextMenuLiveProps | null,
): boolean {
  if (current === next) return true;
  if (!current || !next) return false;

  return (
    sameArray(current.customPalettes, next.customPalettes) &&
    current.snapToGrid === next.snapToGrid &&
    sameBooleanOptionState(current.showOriginal, next.showOriginal) &&
    sameBooleanOptionState(current.preserveColors, next.preserveColors) &&
    sameBooleanOptionState(current.reversePalette, next.reversePalette) &&
    sameBooleanOptionState(current.asciiInvert, next.asciiInvert) &&
    sameStringOptionState(current.shaderType, next.shaderType) &&
    sameStringOptionState(current.shape, next.shape) &&
    sameStringOptionState(current.ditheringKind, next.ditheringKind) &&
    sameStringOptionState(current.asciiKind, next.asciiKind) &&
    sameStringOptionState(current.glassKind, next.glassKind) &&
    sameStringOptionState(current.glitchKind, next.glitchKind) &&
    current.currentPaletteId === next.currentPaletteId &&
    current.paletteMixed === next.paletteMixed &&
    sameArray(current.paletteValues, next.paletteValues) &&
    current.hasEntities === next.hasEntities &&
    current.submenuGutter === next.submenuGutter
  );
}

function createContextMenuActionsProxy(
  getCurrent: () => ContextMenuActions | null,
): ContextMenuActions {
  const proxy = {} as ContextMenuActions;
  const proxyRecord = proxy as Record<keyof ContextMenuActions, (...args: unknown[]) => unknown>;

  for (const key of CONTEXT_MENU_ACTION_KEYS) {
    proxyRecord[key] = (...args: unknown[]) => {
      const current = getCurrent();
      const handler = current?.[key] as ((...handlerArgs: unknown[]) => unknown) | undefined;
      return handler?.(...args);
    };
  }

  return proxy;
}

function sameContextMenuInputs(
  current: ContextMenuSceneInputs | null,
  next: ContextMenuSceneInputs | null,
): boolean {
  if (current === next) return true;
  if (!current || !next) return false;

  // Force re-reconciliation every frame when debug overlay is active
  // so the polygon/trough/exit point update during pointer moves
  if (SHOW_SAFE_POLYGON_DEBUG && contextMenuController.submenu.isOpen) return false;

  return (
    current.activeSubmenuId === next.activeSubmenuId &&
    current.menuX === next.menuX &&
    current.menuY === next.menuY &&
    sameContextMenuProps(current.props, next.props) &&
    current.state === next.state
  );
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

class CanvasUI {
  #uiRenderer: UIRenderer | null = null;

  // Context menu state (set from React layer)
  #liveContextMenuActions: ContextMenuActions | null = null;
  #contextMenuActionsProxy = createContextMenuActionsProxy(() => this.#liveContextMenuActions);
  #contextMenuProps: ContextMenuLiveProps | null = null;
  #lastPerfSnapshot: PerfOverlaySnapshot | null = null;
  #debugType: string | null = null;
  #perfVisible = false;
  #debugTick = 0;
  #lastContextMenuInputs: ContextMenuSceneInputs | null = null;
  #contextMenuVisible = false;

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
    this.#liveContextMenuActions = actions;
  }

  contextMenuProps(props: ContextMenuLiveProps): void {
    this.#contextMenuProps = props;
  }

  setDebugType(debugType: string | null): void {
    this.#debugType = debugType;
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

  get debugType(): string | null {
    return this.#debugType;
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
    targetTexture: GPUTexture,
    viewport: { offset: { x: number; y: number }; zoom: number },
    width: number,
    height: number,
    dpr: number,
    debugMode: boolean,
    perf: PerfOverlaySnapshot,
  ): void {
    if (!this.#uiRenderer?.isReady) return;

    const viewportInfo: ViewportInfo = {
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
    let nextContextMenuInputs: ContextMenuSceneInputs | null = null;

    if (contextMenuController.isOpen) {
      const actions = this.#liveContextMenuActions ? this.#contextMenuActionsProxy : null;
      const props = this.#contextMenuProps;
      if (actions && props) {
        // Convert world position to CSS pixels from viewport edge (unclamped)
        const menuX = ((cmState.worldX - viewport.offset.x) * viewport.zoom) / dpr;
        const menuY = ((cmState.worldY - viewport.offset.y) * viewport.zoom) / dpr;

        // Increment debugTick every frame when debug overlay is active to
        // break React Compiler memoization for the debug-only singleton reads.
        const debugTick =
          SHOW_SAFE_POLYGON_DEBUG && contextMenuController.submenu.isOpen ? ++this.#debugTick : 0;

        nextContextMenuInputs = {
          state: cmState,
          actions,
          props,
          menuX,
          menuY,
          screenScale: dpr / viewport.zoom,
          activeSubmenuId: contextMenuController.activeSubmenuId,
          debugTick,
        };
      }
    }

    this.#renderPerfHudScene(
      debugMode,
      perf,
      encoder,
      targetView,
      targetTexture,
      dpr,
      viewportInfo,
    );
    this.#renderContextMenuScene(
      nextContextMenuInputs,
      encoder,
      targetView,
      targetTexture,
      dpr,
      viewportInfo,
    );
  }

  #renderPerfHudScene(
    debugMode: boolean,
    perf: PerfOverlaySnapshot,
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    targetTexture: GPUTexture,
    scale: number,
    viewportInfo: ViewportInfo,
  ): void {
    if (debugMode) {
      if (!this.#perfVisible || this.#lastPerfSnapshot !== perf) {
        this.#uiRenderer!.updateScene(PERF_SCENE_KEY, createElement(PerfHud, { perf }));
        this.#lastPerfSnapshot = perf;
        this.#perfVisible = true;
      }
      this.#uiRenderer!.renderScene(
        PERF_SCENE_KEY,
        0,
        0,
        encoder,
        targetView,
        targetTexture,
        scale,
        undefined,
        viewportInfo,
      );
      return;
    }

    if (this.#perfVisible) {
      this.#uiRenderer!.updateScene(PERF_SCENE_KEY, null);
      this.#perfVisible = false;
      this.#lastPerfSnapshot = null;
    }
  }

  #renderContextMenuScene(
    nextInputs: ContextMenuSceneInputs | null,
    encoder: GPUCommandEncoder,
    targetView: GPUTextureView,
    targetTexture: GPUTexture,
    scale: number,
    viewportInfo: ViewportInfo,
  ): void {
    if (!sameContextMenuInputs(this.#lastContextMenuInputs, nextInputs)) {
      this.#lastContextMenuInputs = nextInputs;

      if (!nextInputs) {
        this.#uiRenderer!.updateScene(CONTEXT_MENU_SCENE_KEY, null);
        this.#contextMenuVisible = false;
      } else {
        this.#uiRenderer!.updateScene(
          CONTEXT_MENU_SCENE_KEY,
          createElement(CanvasContextMenu, {
            state: nextInputs.state!,
            actions: nextInputs.actions!,
            ...nextInputs.props!,
            menuX: nextInputs.menuX,
            menuY: nextInputs.menuY,
            activeSubmenuId: nextInputs.activeSubmenuId,
            screenScale: nextInputs.screenScale,
            debugTick: nextInputs.debugTick,
          }),
        );
        this.#contextMenuVisible = true;
      }
    }

    if (this.#contextMenuVisible) {
      this.#uiRenderer!.renderScene(
        CONTEXT_MENU_SCENE_KEY,
        0,
        0,
        encoder,
        targetView,
        targetTexture,
        scale,
        undefined,
        viewportInfo,
      );
    }
  }
}

export const canvasUI = new CanvasUI();
