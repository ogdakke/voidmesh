import { config } from "#config";
import {
  type CanvasStore,
  type GameLoop,
  SpacePanMode,
  type ViewportAnimationController,
} from "#engine";
import {
  calculateCenteredOffset,
  calculateFitToView,
  easings,
  zoomToPoint,
} from "#lib/canvas-math.ts";
import type { Point } from "#types/canvas.ts";

export interface CanvasSurfaceMetrics {
  width: number;
  height: number;
  dpr: number;
}

export interface FitSelectionOptions {
  padding: number;
  bottomInset: number;
}

export interface CanvasInteractionService {
  attach(container: HTMLElement, perfElement: HTMLElement): void;
  start(): void;
  stop(): void;
  markContainerDirty(): void;
  pointerDown(point: Point, shiftKey: boolean): boolean;
  pointerMove(point: Point): void;
  pointerUp(point: Point): void;
  touchStart(points: Point[], eventTime: number): void;
  touchMove(points: Point[], eventTime: number): void;
  touchEnd(points: Point[], cancelled: boolean, eventTime: number): void;
  wheel(deltaX: number, deltaY: number, point: Point, zoomModifier: boolean): void;
  openContextMenu(point: Point): void;
  closeContextMenu(): void;
  beginSpacePan(): void;
  endSpacePan(): boolean;
  initializeViewport(metrics: CanvasSurfaceMetrics): void;
  resetZoom(metrics: CanvasSurfaceMetrics): void;
  fitSelection(metrics: CanvasSurfaceMetrics, options: FitSelectionOptions): boolean;
  selectAll(): void;
  clearSelection(): void;
  setMultiSelectMode(enabled: boolean): void;
}

interface CanvasInteractionDependencies {
  store: CanvasStore;
  gameLoop: GameLoop;
  viewportAnimation: ViewportAnimationController;
}

export function createCanvasInteractionService({
  store,
  gameLoop,
  viewportAnimation,
}: CanvasInteractionDependencies): CanvasInteractionService {
  const animateTo = (viewport: ReturnType<CanvasStore["getViewport"]>, duration: number) => {
    viewportAnimation.animateTo(viewport, {
      duration,
      easing: easings[config.canvas.animation.easing],
    });
  };

  return {
    attach(container, perfElement) {
      gameLoop.setContainer(container);
      gameLoop.setPerfElement(perfElement);
    },
    start: () => gameLoop.start(),
    stop: () => gameLoop.stop(),
    markContainerDirty: () => store.setContainerDirty(),
    pointerDown(point, shiftKey) {
      gameLoop.handlePointerDown(point, shiftKey);
      return gameLoop.getDragSelectMode() !== null;
    },
    pointerMove: (point) => gameLoop.handlePointerMove(point),
    pointerUp: (point) => gameLoop.handlePointerUp(point),
    touchStart: (points, eventTime) => gameLoop.handleTouchStart(points, eventTime),
    touchMove: (points, eventTime) => gameLoop.handleTouchMove(points, eventTime),
    touchEnd: (points, cancelled, eventTime) =>
      gameLoop.handleTouchEnd(points, cancelled, eventTime),
    wheel: (deltaX, deltaY, point, zoomModifier) =>
      gameLoop.handleWheel(deltaX, deltaY, point, zoomModifier),
    openContextMenu: (point) => gameLoop.handleContextMenu(point),
    closeContextMenu() {
      store.setContextMenuClosed();
      gameLoop.handleContextMenuClose();
    },
    beginSpacePan: () => gameLoop.setSpaceHeld(true),
    endSpacePan() {
      const wasReady = gameLoop.spacePanMode === SpacePanMode.ready;
      gameLoop.setSpaceHeld(false);
      return wasReady;
    },
    initializeViewport(metrics) {
      const offset = calculateCenteredOffset(metrics.width, metrics.height, 1, metrics.dpr);
      store.setViewport({ offset, zoom: 1 });
    },
    resetZoom(metrics) {
      const centerPoint = {
        x: (metrics.width * metrics.dpr) / 2,
        y: (metrics.height * metrics.dpr) / 2,
      };
      animateTo(
        zoomToPoint(store.getViewport(), centerPoint, 1),
        config.canvas.animation.zoomResetDuration,
      );
    },
    fitSelection(metrics, options) {
      const entities = store.getSelectedEntities();
      if (entities.length === 0) return false;
      gameLoop.stopMomentum();

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const entity of entities) {
        minX = Math.min(minX, entity.position.x);
        minY = Math.min(minY, entity.position.y);
        maxX = Math.max(maxX, entity.position.x + entity.size.width);
        maxY = Math.max(maxY, entity.position.y + entity.size.height);
      }

      animateTo(
        calculateFitToView({
          entityPosition: { x: minX, y: minY },
          entitySize: { width: maxX - minX, height: maxY - minY },
          containerWidth: metrics.width,
          containerHeight: metrics.height,
          dpr: metrics.dpr,
          padding: options.padding,
          minZoom: undefined,
          maxZoom: undefined,
          bottomInset: options.bottomInset,
        }),
        config.canvas.animation.fitToViewDuration,
      );
      return true;
    },
    selectAll: () => store.selectAll(),
    clearSelection: () => store.clearSelection(),
    setMultiSelectMode: (enabled) => store.setMultiSelectMode(enabled),
  };
}
