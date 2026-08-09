import {
  calculateFitToView,
  clampZoom,
  easings,
  rubberBandZoom,
  screenToWorld,
} from "#lib/canvas-math.ts";
import { config, type TouchConfig } from "#config";
import type { AnimationScheduler } from "#lib/animation-scheduler.ts";
import type { Point, Viewport } from "#types/canvas.ts";
import { canvasStore } from "./canvas-store.ts";
import { MomentumController, type MomentumDeps } from "./momentum-controller.ts";

interface ViewportAnimationPort {
  cancel(): void;
  setContainer(container: HTMLElement): void;
  animateTo(viewport: Viewport, options: { duration: number; easing: (t: number) => number }): void;
}

export class CanvasViewportController {
  readonly #viewportAnimation: ViewportAnimationPort;
  readonly #momentum: MomentumController;
  #container: HTMLElement | null = null;
  #containerRect: DOMRect = new DOMRect(0, 0, 0, 0);
  #savedViewport: { viewport: Viewport; entityId: string } | null = null;
  readonly #panDelta: Point = { x: 0, y: 0 };

  constructor(scheduler: AnimationScheduler, viewportAnimation: ViewportAnimationPort) {
    this.#viewportAnimation = viewportAnimation;
    this.#momentum = new MomentumController(scheduler, this.#constructMomentumDeps());
  }

  setContainer(container: HTMLElement, rect: DOMRect): void {
    this.#container = container;
    this.#containerRect = rect;
    this.#viewportAnimation.setContainer(container);
  }

  setContainerRect(rect: DOMRect): void {
    this.#containerRect = rect;
  }

  setTouchConfig(config: Partial<TouchConfig>): void {
    this.#momentum.setTouchConfig(config);
  }

  cancelInteraction(): void {
    this.#viewportAnimation.cancel();
    this.#momentum.stopZoom();
  }

  cancelTouchInteraction(): void {
    this.#viewportAnimation.cancel();
    this.#momentum.stopScroll();
    this.#momentum.stopZoom();
  }

  stopMomentum(): void {
    this.#momentum.stopAll();
  }

  stopScrollMomentum(): void {
    this.#momentum.stopScroll();
  }

  invalidateSavedViewport(): void {
    this.#savedViewport = null;
  }

  panByScreenDelta(deltaX: number, deltaY: number): void {
    const viewport = canvasStore.getViewport();
    const dpr = window.devicePixelRatio || 1;
    this.#panDelta.x = (-deltaX * dpr) / viewport.zoom;
    this.#panDelta.y = (-deltaY * dpr) / viewport.zoom;
    canvasStore.panBy(this.#panDelta);
  }

  panByWheelDelta(deltaX: number, deltaY: number): void {
    const viewport = canvasStore.getViewport();
    const dpr = window.devicePixelRatio || 1;
    this.#panDelta.x = (deltaX * dpr) / viewport.zoom;
    this.#panDelta.y = (deltaY * dpr) / viewport.zoom;
    canvasStore.panBy(this.#panDelta);
  }

  panByWorldDelta(delta: Point): void {
    canvasStore.panBy(delta);
  }

  zoomByWheel(deltaY: number, screenPoint: Point): void {
    const viewport = canvasStore.getViewport();
    const zoomFactor = deltaY > 0 ? 0.955 : 1.045;
    this.zoomAtScreenPoint(clampZoom(viewport.zoom * zoomFactor), screenPoint);
  }

  zoomAtScreenPoint(newZoom: number, screenPoint: Point): void {
    const viewport = canvasStore.getViewport();
    const dpr = window.devicePixelRatio || 1;
    const worldBefore = screenToWorld(screenPoint, viewport, this.#containerRect, dpr);
    canvasStore.setViewport({ ...viewport, zoom: newZoom });
    const worldAfter = screenToWorld(
      screenPoint,
      canvasStore.getViewport(),
      this.#containerRect,
      dpr,
    );
    canvasStore.panBy({
      x: worldBefore.x - worldAfter.x,
      y: worldBefore.y - worldAfter.y,
    });
  }

  applyDoubleTapHoldZoom(rawZoom: number, focalPoint: Point): void {
    this.zoomAtScreenPoint(rubberBandZoom(rawZoom), focalPoint);
  }

  applyPinchZoom(
    initialPinchDistance: number,
    initialZoom: number,
    touch1: Point,
    touch2: Point,
  ): Point {
    const currentDistance = this.getTouchDistance(touch1, touch2);
    const currentCenter = this.getTouchCenter(touch1, touch2);
    const scale = currentDistance / initialPinchDistance;
    this.zoomAtScreenPoint(rubberBandZoom(initialZoom * scale), currentCenter);
    return currentCenter;
  }

  toggleEntityFit(entityId: string, bottomInset: number): void {
    if (!this.#container) return;

    canvasStore.replaceSelection([entityId]);

    if (this.#savedViewport && this.#savedViewport.entityId === entityId) {
      this.#viewportAnimation.animateTo(this.#savedViewport.viewport, {
        duration: config.canvas.animation.fitToViewDuration,
        easing: easings[config.canvas.animation.easing],
      });
      this.#savedViewport = null;
      return;
    }

    const currentViewport = canvasStore.getViewport();
    this.#savedViewport = {
      viewport: {
        offset: { ...currentViewport.offset },
        zoom: currentViewport.zoom,
      },
      entityId,
    };

    const entity = canvasStore.getState().entities.get(entityId);
    if (!entity) return;

    const dpr = window.devicePixelRatio || 1;
    const target = calculateFitToView({
      entityPosition: entity.position,
      entitySize: entity.size,
      containerWidth: this.#container.clientWidth,
      containerHeight: this.#container.clientHeight,
      dpr,
      padding: config.canvas.fitToViewPadding,
      minZoom: undefined,
      maxZoom: undefined,
      bottomInset,
    });

    this.#viewportAnimation.animateTo(target, {
      duration: config.canvas.animation.fitToViewDuration,
      easing: easings[config.canvas.animation.easing],
    });
  }

  triggerZoomMomentum(velocity: number, focalPoint: Point | null): void {
    this.#momentum.triggerZoom(velocity, focalPoint ? { ...focalPoint } : null);
  }

  triggerScrollMomentum(velocity: Point): void {
    this.#momentum.triggerScroll(velocity);
  }

  screenToWorld(screenPoint: Point): Point {
    return screenToWorld(
      screenPoint,
      canvasStore.getViewport(),
      this.#containerRect,
      window.devicePixelRatio || 1,
    );
  }

  screenDeltaToWorldDelta(deltaX: number, deltaY: number): Point {
    const dpr = window.devicePixelRatio || 1;
    const viewport = canvasStore.getViewport();
    return {
      x: (deltaX * dpr) / viewport.zoom,
      y: (deltaY * dpr) / viewport.zoom,
    };
  }

  getTouchDistance(touch1: Point, touch2: Point): number {
    const dx = touch2.x - touch1.x;
    const dy = touch2.y - touch1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  getTouchCenter(touch1: Point, touch2: Point): Point {
    return {
      x: (touch1.x + touch2.x) / 2,
      y: (touch1.y + touch2.y) / 2,
    };
  }

  get containerRect(): DOMRect {
    return this.#containerRect;
  }

  #constructMomentumDeps(): MomentumDeps {
    return {
      panBy: (delta) => canvasStore.panBy(delta),
      getViewport: () => canvasStore.getViewport(),
      setViewport: (viewport) => canvasStore.setViewport(viewport),
      getContainerRect: () => (this.#container ? this.#containerRect : null),
      getDpr: () => window.devicePixelRatio || 1,
    };
  }
}
