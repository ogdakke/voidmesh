import { analytics } from "#lib/analytics.ts";
import { logger } from "#lib/client.logger.ts";
import {
  boundsIntersect,
  calculateFitToView,
  clampZoom,
  createBounds,
  easings,
  pointInBounds,
  rubberBandZoom,
  screenToWorld,
  SNAP_GRID_SIZE,
  snapToGrid,
} from "../lib/canvas-math.ts";
import { config, type TouchConfig } from "../lib/config/index.ts";
import {
  DampedSpring2D,
  Scroller,
  SpringBack,
  VelocityTracker,
} from "../lib/touch-scroll/index.ts";
import type { InfiniteCanvasRenderer } from "../renderer/canvas-renderer.ts";
import {
  DragTargetType,
  isAnimatedEntity,
  MediaType,
  type Bounds,
  type Point,
  type Viewport,
} from "#types/canvas.ts";
import { createEnum } from "#types/index.ts";
import { canvasStore } from "./canvas-store.ts";
import { disintegrationController } from "./disintegration-controller.ts";
import { entityDragVisual } from "./entity-drag-visual.ts";
import { actionLayerController } from "./action-layer-controller.ts";
import { entityLabel } from "./entity-label.ts";
import { perfOverlay } from "./perf-overlay.ts";
import { viewportAnimation } from "./viewport-animation.ts";
import { haptic } from "#lib/haptic.ts";

export interface InputState {
  pointerPosition: Point | null;
  pointerDown: boolean;
  lastWorldPoint: Point | null;
  pointerDownPosition: Point | null;
  pointerDownEntityId: string | null;
  contextOpenEntityId: string | null;
  pointerDownWasSelected: boolean;
  contextOpen: boolean;
}

/** State for tracking multi-touch gestures */
export interface TouchGestureState {
  /** Number of active touch points */
  touchCount: number;
  /** Initial distance between two fingers (for pinch) */
  initialPinchDistance: number | null;
  /** Initial zoom level when pinch started */
  initialZoom: number | null;
  /** Center point of the pinch gesture (screen coords) */
  pinchCenter: Point | null;
  /** Last center point for calculating pan delta during pinch */
  lastPinchCenter: Point | null;
  /** Last positions of touches for calculating deltas */
  lastTouchPosition: Point | null;
  /** Whether we've detected a pinch gesture */
  isPinching: boolean;
  /** Whether we're panning with single finger */
  isPanning: boolean;
  /** Whether we're moving selected entities with two fingers */
  isMovingEntities: boolean;
  /** Whether multi-touch occurred during this session (suppresses tap on final lift) */
  hadMultiTouch: boolean;
  /** Whether we're in long-press entity drag mode */
  isDraggingEntity: boolean;
  /** Timer ID for the long-press detection timeout */
  longPressTimerId: ReturnType<typeof setTimeout> | null;
  /** Entity ID that the long-press is targeting */
  longPressEntityId: string | null;
  /** Whether the action layer (radial context menu) is active */
  isActionLayerActive: boolean;
}

/** State machine for space+drag canvas panning */
export const SpacePanMode = createEnum({
  idle: "idle",
  ready: "ready",
  panning: "panning",
  panned: "panned",
});
type SpacePanMode = typeof SpacePanMode.infer;

/** Drag-select mode determines how selection is modified */
export type DragSelectMode = "replace" | "additive" | "subtractive";

/** State for drag-to-select rectangle */
export interface DragSelectState {
  isActive: boolean;
  startPoint: Point;
  currentPoint: Point;
  /** Selection mode: 'replace' (no shift), 'additive' (shift, no prior selection), 'subtractive' (shift, has prior selection) */
  mode: DragSelectMode;
  /** Entity IDs that were selected before drag started (for additive/subtractive modes) */
  previousSelection: Set<string>;
}

export class GameLoop {
  #logger = logger;
  private renderer: InfiniteCanvasRenderer | null = null;
  private container: HTMLElement | null = null;
  private running = false;
  private animationFrameId: number | null = null;
  private firstFrameRendered = false;
  private lastFrameTime: number | null = null;

  private inputState: InputState = {
    pointerPosition: null,
    pointerDown: false,
    lastWorldPoint: null,
    pointerDownPosition: null,
    pointerDownEntityId: null,
    contextOpenEntityId: null,
    pointerDownWasSelected: false,
    contextOpen: false,
  };

  private dragTarget: { type: DragTargetType; entityId?: string } | null = null;
  private dragSelect: DragSelectState | null = null;
  /** Accumulated unsnapped position during snap-to-grid drag (avoids losing fractional movement) */
  private snapAccumulator: Point | null = null;
  /** Touch gesture state for mobile interactions */
  private touchState: TouchGestureState = {
    touchCount: 0,
    initialPinchDistance: null,
    initialZoom: null,
    pinchCenter: null,
    lastPinchCenter: null,
    lastTouchPosition: null,
    isPinching: false,
    isPanning: false,
    isMovingEntities: false,
    hadMultiTouch: false,
    isDraggingEntity: false,
    longPressTimerId: null,
    longPressEntityId: null,
    isActionLayerActive: false,
  };

  /** Catch-up spring for compensating deadzone distance on action layer → drag transition */
  #dragCatchUp = { spring: new DampedSpring2D(), active: false, lastTime: 0 };

  /** Snap-settle spring: animates entity to nearest grid point after catch-up completes */
  #snapSettle = { spring: new DampedSpring2D(), active: false, lastTime: 0 };

  /** Entity IDs for springs that continue after finger lift (catch-up / snap-settle) */
  #springEntityIds: ReadonlySet<string> | null = null;

  /** Reusable velocity trackers for momentum scrolling (avoids GC) */
  private readonly velocityTrackerX = new VelocityTracker();
  private readonly velocityTrackerY = new VelocityTracker();

  /** Reusable scrollers for momentum animation (avoids GC) */
  private readonly scrollerX = new Scroller(config.touch.decelerationRate);
  private readonly scrollerY = new Scroller(config.touch.decelerationRate);

  /** Whether momentum scrolling is currently active */
  private momentumActive = false;
  /** Time when momentum scrolling started */
  private momentumStartTime = 0;
  /** Last momentum offset to calculate delta */
  private lastMomentumOffset: Point = { x: 0, y: 0 };

  /** Reusable velocity tracker for zoom rate in log(zoom) space */
  private readonly velocityTrackerZoom = new VelocityTracker();

  /** Reusable scroller for zoom momentum deceleration (log-space needs smaller velocity threshold) */
  private readonly scrollerZoom = new Scroller(config.touch.zoomMomentum.decelerationRate, 0.0001);

  /** Spring-back for elastic bounce at zoom boundaries */
  private readonly springBackZoom = new SpringBack();

  /** Whether zoom momentum (fling or spring) is currently active */
  private zoomMomentumActive = false;
  /** Time when zoom momentum fling started */
  private zoomMomentumStartTime = 0;
  /** Last zoom momentum offset (log-space) to calculate delta */
  private lastZoomMomentumOffset = 0;
  /** Screen-space focal point for zoom momentum (last pinch center) */
  private zoomMomentumFocalPoint: Point | null = null;
  /** Whether spring-back phase is active (after fling overshoots boundary) */
  private zoomSpringActive = false;
  /** Time when spring-back started */
  private zoomSpringStartTime = 0;
  /** The zoom boundary value the spring is settling toward */
  private zoomSpringBoundary = 1;

  /** Touch sensitivity configuration */
  #touchConfig: TouchConfig = { ...config.touch };

  /** Space+drag canvas pan state machine */
  #spacePanMode: SpacePanMode = SpacePanMode.idle;

  /** Double-tap detection state */
  private lastTapTime = 0;
  private lastTapEntityId: string | null = null;
  private lastTapPosition: Point | null = null;
  private doubleTapTimerId: ReturnType<typeof setTimeout> | null = null;

  /** Saved viewport for double-tap zoom-back toggle */
  private savedViewport: { viewport: Viewport; entityId: string } | null = null;

  /** Double-tap + hold + drag zoom state (iOS Maps-style one-finger zoom) */
  private doubleTapHoldZoom = {
    isCandidate: false,
    isZooming: false,
    anchorPoint: null as Point | null,
    lastY: 0,
    /** Raw unclamped zoom — rubber-band is applied once per frame for display */
    rawZoom: 1,
  };

  /** Multi-select mode is stored in canvasStore for React reactivity */

  setRenderer(renderer: InfiniteCanvasRenderer): void {
    this.renderer = renderer;
    // Reset first frame flag when renderer changes
    this.firstFrameRendered = false;
  }

  setContainer(container: HTMLElement): void {
    this.container = container;
    viewportAnimation.setContainer(container);
    entityLabel.setContainer(container);
  }

  setLabelElement(element: HTMLDivElement): void {
    entityLabel.setLabelElement(element);
  }

  setTextElement(element: HTMLSpanElement): void {
    entityLabel.setTextElement(element);
  }

  setPerfElement(element: HTMLElement): void {
    perfOverlay.setElement(element);
  }

  /** Configure touch sensitivity parameters for tuning */
  setTouchConfig(config: Partial<TouchConfig>): void {
    this.#touchConfig = { ...this.#touchConfig, ...config };
    // Update scrollers with new deceleration rate
    this.scrollerX.setDecelerationRate(this.#touchConfig.decelerationRate);
    this.scrollerY.setDecelerationRate(this.#touchConfig.decelerationRate);
    if (config.zoomMomentum) {
      this.scrollerZoom.setDecelerationRate(this.#touchConfig.zoomMomentum.decelerationRate);
    }
  }

  /** Get current touch configuration */
  getTouchConfig(): TouchConfig {
    return { ...this.#touchConfig };
  }

  /** Set whether the spacebar is held for canvas panning */
  setSpaceHeld(held: boolean): void {
    this.#spacePanMode = held ? SpacePanMode.ready : SpacePanMode.idle;
  }

  /** Current space+drag pan state */
  get spacePanMode(): SpacePanMode {
    return this.#spacePanMode;
  }

  /** Check if multi-select mode is active (reads from canvas store) */
  private isInMultiSelectMode(): boolean {
    return canvasStore.getState().multiSelectMode;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  stop(): void {
    this.running = false;
    this.lastFrameTime = null;
    this.cancelLongPressTimer();
    this.cancelDoubleTapTimer();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private tick = (): void => {
    if (!this.running) return;

    // 1. Compute delta time for GIF playback advancement
    const now = performance.now();
    const deltaSeconds = this.lastFrameTime !== null ? (now - this.lastFrameTime) / 1000 : 0;
    this.lastFrameTime = now;

    let hasPlayingMedia = false;
    let hasContinuousShaderRender = false;

    // 2. Advance GIF playback and update video time for all playing animated entities.
    // Uses entity refs directly — getRenderState() is deferred until after all ticks
    // so the viewport snapshot reflects this frame's updates, not the previous frame's.
    for (const entity of canvasStore.getState().entities.values()) {
      if (entity.mediaSource.type === MediaType.gif && entity.playback?.isPlaying) {
        canvasStore.advanceGifPlayback(entity.id, deltaSeconds);
        // Notify playback subscribers for real-time time display updates
        canvasStore.updateGifPlaybackTime(entity.id, entity.playback.currentTime);
        hasPlayingMedia = true;
      }
      // Update video playback time continuously
      if (entity.mediaSource.type === MediaType.video && entity.playback?.isPlaying) {
        const video = entity.mediaSource.videoElement;
        canvasStore.updatePlaybackTime(entity.id, video.currentTime);
        hasPlayingMedia = true;
      }
      // Check if any shader needs continuous re-rendering (e.g., time-based animation)
      if (!hasContinuousShaderRender && this.renderer?.needsContinuousRenderForEntity(entity)) {
        hasContinuousShaderRender = true;
      }
    }

    // 3. Update viewport animation (returns true if animation is active)
    const animationActive = viewportAnimation.tick(now);

    // 3b. Process momentum scrolling (touch fling)
    const momentumActive = this.processMomentumScrolling(now);

    // 3c. Process zoom momentum (pinch fling + spring-back)
    const zoomMomentumActive = this.processZoomMomentum(now);

    // 4. Process input (hover detection, drag updates)
    this.processInput();

    // 4b. Advance drag visual spring animation
    const dragVisualActive = entityDragVisual.tick(now);

    // 4c. Advance action layer animations (rubber-band, blur)
    const actionLayerActive = actionLayerController.tick(now);

    // 4d. Advance drag catch-up spring (deadzone compensation after action layer → drag)
    const dragCatchUpActive = this.#tickDragCatchUp(now);

    // 4e. Advance snap-settle spring (grid alignment after catch-up)
    const snapSettleActive = this.#tickSnapSettle(now);

    // 4f. Advance disintegration animations
    const disintegrationActive = disintegrationController.tick(now);

    // 5. Snapshot render state AFTER all ticks so the viewport reflects
    // this frame's animation/momentum/input updates, not the previous frame's.
    const renderState = canvasStore.getRenderState();

    // 6. Add selection bounds to render state (managed by game-loop, not store)
    renderState.dragSelectBounds = this.getDragSelectBounds();
    renderState.multiSelectBounds = this.getMultiSelectBounds();

    // 7. Determine if we need to render this frame
    // Render when: first frame, dirty flag is set, media playing, viewport animating, momentum scrolling, dragging entity/selection, drag-selecting, or drag visual animating
    const needsRender =
      !this.firstFrameRendered ||
      renderState.dirty ||
      hasPlayingMedia ||
      hasContinuousShaderRender ||
      animationActive ||
      momentumActive ||
      zoomMomentumActive ||
      dragVisualActive ||
      actionLayerActive ||
      dragCatchUpActive ||
      snapSettleActive ||
      disintegrationActive ||
      (this.inputState.pointerDown && !!this.dragTarget) ||
      this.dragSelect?.isActive;

    // 8. Update entity label position (only when rendering)
    if (needsRender) {
      entityLabel.tick(renderState);
    }

    // 9. Render only when needed (skip idle frames)
    if (this.renderer?.isReady && needsRender) {
      if (renderState.debugMode) performance.mark("studio-render-start");
      this.renderer.render(renderState);
      this.firstFrameRendered = true;
      if (renderState.debugMode) {
        performance.mark("studio-render-end");
        performance.measure("studio-render", "studio-render-start", "studio-render-end");
      }
      perfOverlay.tick(this.renderer.getFrameStats(), renderState.debugMode);
    }

    // 10. Clear dirty flags
    canvasStore.clearDirtyFlags();

    // 11. Schedule next frame
    this.animationFrameId = requestAnimationFrame(this.tick);
  };

  /**
   * Process momentum scrolling animation.
   * Called each frame to update viewport position during fling.
   * @returns true if momentum is active, false otherwise
   */
  private processMomentumScrolling(now: number): boolean {
    if (!this.momentumActive) {
      return false;
    }

    const elapsed = now - this.momentumStartTime;
    const valX = this.scrollerX.value(elapsed);
    const valY = this.scrollerY.value(elapsed);

    // Continue if either axis is still animating
    if (valX || valY) {
      // Calculate delta from last frame for each axis independently
      // Negate to match live panning direction (content follows finger)
      const deltaX = valX ? -(valX.offset - this.lastMomentumOffset.x) : 0;
      const deltaY = valY ? -(valY.offset - this.lastMomentumOffset.y) : 0;

      const viewport = canvasStore.getViewport();
      const dpr = window.devicePixelRatio || 1;
      canvasStore.panBy({
        x: (deltaX * dpr) / viewport.zoom,
        y: (deltaY * dpr) / viewport.zoom,
      });

      // Update offset for each axis only if still active
      this.lastMomentumOffset = {
        x: valX ? valX.offset : this.lastMomentumOffset.x,
        y: valY ? valY.offset : this.lastMomentumOffset.y,
      };
      return true;
    } else {
      // Both axes complete
      this.cancelMomentum();
      return false;
    }
  }

  /** Stop any active momentum scrolling and zoom momentum (public API for external callers) */
  stopMomentum(): void {
    this.cancelMomentum();
    this.cancelZoomMomentum();
  }

  /** Cancel any active momentum scrolling */
  private cancelMomentum(): void {
    this.momentumActive = false;
    this.scrollerX.reset();
    this.scrollerY.reset();
    this.momentumStartTime = 0;
    this.lastMomentumOffset = { x: 0, y: 0 };
  }

  /**
   * Calculate zoom velocity and start zoom momentum if fast enough.
   * Called when a pinch gesture or double-tap-hold zoom ends.
   *
   * If the zoom is currently out of bounds (from rubber-band stretching),
   * goes directly to spring-back. Otherwise starts a fling.
   *
   * @param focalPoint Optional screen-space focal point override (used by double-tap-hold zoom).
   *                   Falls back to pinch center if not provided.
   */
  private triggerZoomMomentum(focalPoint?: Point | null): void {
    const zoomConfig = this.#touchConfig.zoomMomentum;
    const vel = this.velocityTrackerZoom.calculate();

    // Use provided focal point, or fall back to pinch center
    this.zoomMomentumFocalPoint = focalPoint
      ? { ...focalPoint }
      : this.touchState.pinchCenter
        ? { ...this.touchState.pinchCenter }
        : null;

    // Check if zoom is currently out of bounds (from rubber-band during pinch)
    const currentZoom = canvasStore.getViewport().zoom;
    const boundary = clampZoom(currentZoom);

    if (currentZoom !== boundary) {
      // Out of bounds — go directly to spring-back toward the nearest limit
      const logOvershoot = Math.log(currentZoom) - Math.log(boundary);
      this.springBackZoom.reset();
      this.springBackZoom.absorb(vel, logOvershoot, zoomConfig.springResponse);
      this.zoomMomentumActive = false;
      this.zoomSpringActive = true;
      this.zoomSpringStartTime = performance.now();
      this.zoomSpringBoundary = boundary;
      return;
    }

    // In bounds — start fling if velocity is high enough
    if (Math.abs(vel) > zoomConfig.velocityThreshold) {
      const clampedVel = Math.max(-zoomConfig.maxVelocity, Math.min(zoomConfig.maxVelocity, vel));

      this.scrollerZoom.reset();
      this.scrollerZoom.setDecelerationRate(zoomConfig.decelerationRate);
      this.scrollerZoom.fling(clampedVel * zoomConfig.velocityScale);

      this.zoomMomentumActive = true;
      this.zoomSpringActive = false;
      this.zoomMomentumStartTime = performance.now();
      this.lastZoomMomentumOffset = 0;
    }
  }

  /**
   * Process zoom momentum animation (fling + spring-back at boundaries).
   * Operates in log(zoom) space for perceptually uniform deceleration.
   * @returns true if zoom momentum is active, false otherwise
   */
  private processZoomMomentum(now: number): boolean {
    if (!this.zoomMomentumActive && !this.zoomSpringActive) {
      return false;
    }

    const focalPoint = this.zoomMomentumFocalPoint;
    if (!focalPoint || !this.container) {
      this.cancelZoomMomentum();
      return false;
    }

    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    if (this.zoomMomentumActive) {
      // Fling phase: exponential deceleration in log-space
      const elapsed = now - this.zoomMomentumStartTime;
      const val = this.scrollerZoom.value(elapsed);

      if (!val) {
        this.cancelZoomMomentum();
        return false;
      }

      const logDelta = val.offset - this.lastZoomMomentumOffset;
      this.lastZoomMomentumOffset = val.offset;

      const viewport = canvasStore.getViewport();
      const newZoomUnclamped = viewport.zoom * Math.exp(logDelta);
      const newZoom = clampZoom(newZoomUnclamped);

      // Check if fling hit or overshot a boundary
      if (newZoom !== newZoomUnclamped) {
        // Transition to spring-back: bounce elastically from the boundary
        const overshootLog = Math.log(newZoomUnclamped) - Math.log(newZoom);
        this.springBackZoom.reset();
        this.springBackZoom.absorb(
          val.velocity,
          overshootLog,
          this.#touchConfig.zoomMomentum.springResponse,
        );
        this.zoomMomentumActive = false;
        this.zoomSpringActive = true;
        this.zoomSpringStartTime = now;
        this.zoomSpringBoundary = newZoom;

        // Apply the clamped zoom for this frame
        const worldBefore = screenToWorld(focalPoint, viewport, rect, dpr);
        canvasStore.setViewport({ ...viewport, zoom: newZoom });
        const worldAfter = screenToWorld(focalPoint, canvasStore.getViewport(), rect, dpr);
        canvasStore.panBy({
          x: worldBefore.x - worldAfter.x,
          y: worldBefore.y - worldAfter.y,
        });
        return true;
      }

      // Apply zoom toward focal point
      const worldBefore = screenToWorld(focalPoint, viewport, rect, dpr);
      canvasStore.setViewport({ ...viewport, zoom: newZoom });
      const worldAfter = screenToWorld(focalPoint, canvasStore.getViewport(), rect, dpr);
      canvasStore.panBy({
        x: worldBefore.x - worldAfter.x,
        y: worldBefore.y - worldAfter.y,
      });
      return true;
    }

    if (this.zoomSpringActive) {
      // Spring-back phase: damped oscillation toward boundary
      const elapsed = now - this.zoomSpringStartTime;
      const val = this.springBackZoom.value(elapsed);

      if (!val) {
        // Spring settled — snap exactly to boundary
        const viewport = canvasStore.getViewport();
        if (viewport.zoom !== this.zoomSpringBoundary) {
          const worldBefore = screenToWorld(focalPoint, viewport, rect, dpr);
          canvasStore.setViewport({
            ...viewport,
            zoom: this.zoomSpringBoundary,
          });
          const worldAfter = screenToWorld(focalPoint, canvasStore.getViewport(), rect, dpr);
          canvasStore.panBy({
            x: worldBefore.x - worldAfter.x,
            y: worldBefore.y - worldAfter.y,
          });
        }
        this.cancelZoomMomentum();
        return false;
      }

      // Spring offset is in log-space relative to boundary
      // Allow oscillation past the near boundary (that's the bounce) but
      // clamp at the opposite boundary as a safety net
      const viewport = canvasStore.getViewport();
      const springZoom = this.zoomSpringBoundary * Math.exp(val.offset);
      const { minZoom, maxZoom } = config.canvas;
      const oppositeClamp =
        this.zoomSpringBoundary <= minZoom
          ? Math.max(0, Math.min(maxZoom, springZoom)) // springing from min — don't exceed max
          : Math.max(minZoom, springZoom); // springing from max — don't go below min
      const clampedZoom = oppositeClamp;

      const worldBefore = screenToWorld(focalPoint, viewport, rect, dpr);
      canvasStore.setViewport({ ...viewport, zoom: clampedZoom });
      const worldAfter = screenToWorld(focalPoint, canvasStore.getViewport(), rect, dpr);
      canvasStore.panBy({
        x: worldBefore.x - worldAfter.x,
        y: worldBefore.y - worldAfter.y,
      });
      return true;
    }

    return false;
  }

  /** Cancel any active zoom momentum and spring-back */
  private cancelZoomMomentum(): void {
    this.zoomMomentumActive = false;
    this.zoomSpringActive = false;
    this.scrollerZoom.reset();
    this.springBackZoom.reset();
    this.zoomMomentumStartTime = 0;
    this.zoomSpringStartTime = 0;
    this.lastZoomMomentumOffset = 0;
    this.zoomMomentumFocalPoint = null;
    this.zoomSpringBoundary = 1;
  }

  /** Advance the drag catch-up spring. Returns true while animating. */
  #tickDragCatchUp(now: number): boolean {
    if (!this.#dragCatchUp.active) return false;

    const dt = (now - this.#dragCatchUp.lastTime) / 1000;
    this.#dragCatchUp.lastTime = now;

    const delta = this.#dragCatchUp.spring.step(dt);
    this.#moveEntitiesRaw(delta);

    // Start snap-settle early: when remaining catch-up offset is small enough
    // that the snap-settle spring can absorb it (avoids waiting for the long tail)
    const offset = this.#dragCatchUp.spring.offset;
    const remainingSmall = Math.abs(offset.x) < 1 && Math.abs(offset.y) < 1;

    if (!this.#dragCatchUp.spring.active || (remainingSmall && canvasStore.getState().snapToGrid)) {
      this.#moveEntitiesRaw(this.#dragCatchUp.spring.flush());
      this.#dragCatchUp.active = false;

      // If snap-to-grid is on, spring to nearest grid point
      if (canvasStore.getState().snapToGrid) {
        this.#initSnapSettle();
      }
      return false;
    }

    return true;
  }

  /** Move current drag target entities without snap-to-grid (raw world-space delta).
   *  Falls back to #springEntityIds when dragTarget is null (finger lifted, spring still running). */
  #moveEntitiesRaw(delta: Point): void {
    if (this.dragTarget?.type === DragTargetType.multiSelection) {
      for (const entityId of canvasStore.getSelectedEntityIds()) {
        canvasStore.moveEntity(entityId, delta);
      }
    } else if (this.dragTarget?.type === DragTargetType.entity && this.dragTarget.entityId) {
      canvasStore.moveEntity(this.dragTarget.entityId, delta);
    } else if (this.#springEntityIds) {
      for (const entityId of this.#springEntityIds) {
        canvasStore.moveEntity(entityId, delta);
      }
    }
  }

  /** Get the anchor entity ID for snap calculations (works during and after drag) */
  #getAnchorEntityId(): string | undefined {
    if (this.dragTarget?.type === DragTargetType.multiSelection) {
      return canvasStore.getSelectedEntityIds().values().next().value;
    }
    if (this.dragTarget?.type === DragTargetType.entity) {
      return this.dragTarget.entityId;
    }
    return this.#springEntityIds?.values().next().value;
  }

  /** Initialize snap-settle spring to animate entity to nearest grid point */
  #initSnapSettle(): void {
    const anchorId = this.#getAnchorEntityId();
    if (!anchorId) return;

    const anchor = canvasStore.getState().entities.get(anchorId);
    if (!anchor) return;

    const gridSize = this.getSnapGridSize();
    const snapped = snapToGrid(anchor.position, gridSize);
    const dx = snapped.x - anchor.position.x;
    const dy = snapped.y - anchor.position.y;

    // Already on grid — skip settle
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      this.snapAccumulator = { ...snapped };
      this.#springEntityIds = null;
      return;
    }

    // Fast, slightly-underdamped spring (snappy grid click)
    this.#snapSettle.spring.start({ x: dx, y: dy }, { x: 0, y: 0 }, 0.1, 0.9);
    this.#snapSettle.active = true;
    this.#snapSettle.lastTime = performance.now();
  }

  /** Advance snap-settle spring. Returns true while animating. */
  #tickSnapSettle(now: number): boolean {
    if (!this.#snapSettle.active) return false;

    const dt = (now - this.#snapSettle.lastTime) / 1000;
    this.#snapSettle.lastTime = now;

    const delta = this.#snapSettle.spring.step(dt);
    this.#moveEntitiesRaw(delta);

    if (!this.#snapSettle.spring.active) {
      // Flush remaining offset to land exactly on grid
      this.#moveEntitiesRaw(this.#snapSettle.spring.flush());
      this.#snapSettle.active = false;

      // Initialize snapAccumulator at the grid-aligned position for clean handoff
      const anchorId = this.#getAnchorEntityId();
      if (anchorId) {
        const anchor = canvasStore.getState().entities.get(anchorId);
        if (anchor) {
          this.snapAccumulator = { ...anchor.position };
        }
      }
      this.#springEntityIds = null;
      return false;
    }

    return true;
  }

  private processInput(): void {
    const { pointerPosition, pointerDown } = this.inputState;
    if (!pointerPosition || !this.container) return;

    const rect = this.container.getBoundingClientRect();
    const state = canvasStore.getState();
    const viewport = canvasStore.getViewport(); // Always get fresh viewport
    const dpr = window.devicePixelRatio || 1;
    const worldPoint = screenToWorld(pointerPosition, viewport, rect, dpr);

    // Update hover state
    if (!pointerDown) {
      const hoveredId = this.findEntityAtPoint(worldPoint, state);
      canvasStore.setHoveredEntity(hoveredId);
    }

    // Handle dragging (skip if context menu is open or touch is handling drag directly)
    if (
      pointerDown &&
      !this.inputState.contextOpen &&
      this.dragTarget &&
      !this.touchState.isDraggingEntity
    ) {
      const lastPoint = this.inputState.lastWorldPoint;
      if (lastPoint) {
        const delta = {
          x: worldPoint.x - lastPoint.x,
          y: worldPoint.y - lastPoint.y,
        };

        // Activate drag visual on first actual movement (desktop — mobile uses long-press)
        if ((delta.x !== 0 || delta.y !== 0) && !entityDragVisual.isDragPhase()) {
          entityDragVisual.activateDrag(canvasStore.getSelectedEntityIds());
        }

        if (this.dragTarget.type === DragTargetType.multiSelection) {
          // Move all selected entities together
          this.moveSelectedEntities(delta);
        } else if (this.dragTarget.type === DragTargetType.entity && this.dragTarget.entityId) {
          if (canvasStore.getState().snapToGrid) {
            this.moveEntitySnapped(this.dragTarget.entityId, delta);
          } else {
            canvasStore.moveEntity(this.dragTarget.entityId, delta);
          }
        }
      }
      this.inputState.lastWorldPoint = worldPoint;
    }
  }

  /** Get the snap grid size (constant major grid) */
  private getSnapGridSize(): number {
    return SNAP_GRID_SIZE;
  }

  /** Move a single entity with snap-to-grid */
  private moveEntitySnapped(entityId: string, delta: Point): void {
    const entity = canvasStore.getState().entities.get(entityId);
    if (!entity) return;

    // Initialize accumulator on first frame of drag
    if (!this.snapAccumulator) {
      this.snapAccumulator = { ...entity.position };
    }

    // Accumulate raw movement (preserves fractional deltas across frames)
    this.snapAccumulator.x += delta.x;
    this.snapAccumulator.y += delta.y;

    const gridSize = this.getSnapGridSize();
    const snapped = snapToGrid(this.snapAccumulator, gridSize);
    const snappedDelta = {
      x: snapped.x - entity.position.x,
      y: snapped.y - entity.position.y,
    };

    if (snappedDelta.x === 0 && snappedDelta.y === 0) return;
    canvasStore.moveEntity(entityId, snappedDelta);
  }

  /** Move all selected entities by the given delta */
  private moveSelectedEntities(delta: Point): void {
    const state = canvasStore.getState();
    const selectedIds = canvasStore.getSelectedEntityIds();

    if (state.snapToGrid) {
      // Snap as a group: snap the anchor entity, apply same delta to all
      const anchorId = selectedIds.values().next().value;
      if (!anchorId) return;
      const anchor = state.entities.get(anchorId);
      if (!anchor) return;

      // Initialize accumulator on first frame of drag
      if (!this.snapAccumulator) {
        this.snapAccumulator = { ...anchor.position };
      }

      // Accumulate raw movement (preserves fractional deltas across frames)
      this.snapAccumulator.x += delta.x;
      this.snapAccumulator.y += delta.y;

      const gridSize = this.getSnapGridSize();
      const snapped = snapToGrid(this.snapAccumulator, gridSize);
      const snappedDelta = {
        x: snapped.x - anchor.position.x,
        y: snapped.y - anchor.position.y,
      };

      if (snappedDelta.x === 0 && snappedDelta.y === 0) return;

      for (const entityId of selectedIds) {
        canvasStore.moveEntity(entityId, snappedDelta);
      }
    } else {
      for (const entityId of selectedIds) {
        canvasStore.moveEntity(entityId, delta);
      }
    }
  }

  private findEntityAtPoint(
    worldPoint: Point,
    state: ReturnType<typeof canvasStore.getState>,
  ): string | null {
    const sortedEntities = state.entities
      .values()
      .toArray()
      .sort((a, b) => b.zIndex - a.zIndex);

    for (const entity of sortedEntities) {
      if (entity.locked) continue;
      const bounds = createBounds(entity.position, entity.size);
      if (pointInBounds(worldPoint, bounds)) {
        return entity.id;
      }
    }
    return null;
  }

  // Input event handlers (called from React component)
  handlePointerDown(screenPoint: Point, shiftKey: boolean = false): void {
    // Cancel any viewport animation when user starts interacting
    viewportAnimation.cancel();
    this.cancelZoomMomentum();

    if (!this.container) return;

    this.inputState.pointerDown = true;
    this.inputState.pointerPosition = screenPoint;
    this.inputState.pointerDownPosition = screenPoint;

    if (this.#spacePanMode === SpacePanMode.ready || this.#spacePanMode === SpacePanMode.panned) {
      this.#spacePanMode = SpacePanMode.panning;
      this.stopMomentum();
      return;
    }

    const rect = this.container.getBoundingClientRect();
    const state = canvasStore.getState();
    const viewport = canvasStore.getViewport(); // Always get fresh viewport
    const dpr = window.devicePixelRatio || 1;
    const worldPoint = screenToWorld(screenPoint, viewport, rect, dpr);

    this.inputState.lastWorldPoint = worldPoint;

    const entityId = this.findEntityAtPoint(worldPoint, state);
    const multiSelectBounds = this.computeMultiSelectBounds(state);
    const isInMultiSelectBounds = multiSelectBounds && pointInBounds(worldPoint, multiSelectBounds);

    if (entityId) {
      this.inputState.pointerDownEntityId = entityId;
      this.inputState.pointerDownWasSelected = state.selectedEntityIds.has(entityId);

      if (this.isInMultiSelectMode()) {
        // Multi-select mode: toggle on pointer down, allow drag of selection
        this.dragTarget = { type: DragTargetType.entity, entityId };
        canvasStore.toggleSelection(entityId);
      } else if (shiftKey) {
        // Shift+click: toggle selection (not undoable)
        this.dragTarget = { type: DragTargetType.entity, entityId };
        canvasStore.toggleSelection(entityId);
      } else if (state.selectedEntityIds.has(entityId) && state.selectedEntityIds.size > 1) {
        // Clicked on an entity that's part of a multi-selection: drag all selected
        this.dragTarget = { type: DragTargetType.multiSelection };
      } else {
        // Regular click: replace selection with just this entity
        this.dragTarget = { type: DragTargetType.entity, entityId };
        canvasStore.replaceSelection([entityId]);
      }

      // Start possible-drag visual with longer delay than mobile (200ms vs 100ms)
      // to avoid icon flash on quick clicks
      const currentState = canvasStore.getState();
      const dragEntityIds =
        currentState.selectedEntityIds.has(entityId) && currentState.selectedEntityIds.size > 1
          ? currentState.selectedEntityIds
          : new Set([entityId]);
      entityDragVisual.startPossibleDrag(dragEntityIds, {
        directToDrag: true,
        delay: 200,
      });
    } else if (isInMultiSelectBounds && !shiftKey) {
      // Clicked on empty space within multi-select bounds: drag all selected
      this.inputState.pointerDownEntityId = null;
      this.inputState.pointerDownWasSelected = false;
      this.dragTarget = { type: DragTargetType.multiSelection };
    } else if (this.isInMultiSelectMode()) {
      // Multi-select mode: empty space click does nothing (preserve selection)
      this.inputState.pointerDownEntityId = null;
      this.inputState.pointerDownWasSelected = false;
      this.dragTarget = null;
      this.snapAccumulator = null;
    } else {
      // Clicked on empty space outside selection
      this.inputState.pointerDownEntityId = null;
      this.inputState.pointerDownWasSelected = false;
      this.dragTarget = null;
      this.snapAccumulator = null;

      // Determine drag-select mode based on shift and existing selection
      const hasExistingSelection = state.selectedEntityIds.size > 0;
      let mode: DragSelectMode;
      if (!shiftKey) {
        mode = "replace";
      } else if (hasExistingSelection) {
        mode = "subtractive";
      } else {
        mode = "additive";
      }

      // Start drag-select rectangle
      this.dragSelect = {
        isActive: true,
        startPoint: worldPoint,
        currentPoint: worldPoint,
        mode,
        previousSelection: new Set(state.selectedEntityIds),
      };

      if (mode === "replace") {
        // Regular drag-select: start fresh
        canvasStore.clearSelection();
      }
      // For additive/subtractive modes, keep existing selection
    }

    this.#logger.info("Pointer down", {
      entityId,
      shiftKey,
      selectedEntityIds: [...state.selectedEntityIds],
      screenPoint,
      worldPoint,
    });
  }

  handlePointerMove(screenPoint: Point): void {
    const lastPos = this.inputState.pointerPosition;
    this.inputState.pointerPosition = screenPoint;

    if (this.#spacePanMode === SpacePanMode.panning) {
      if (lastPos) {
        const viewport = canvasStore.getViewport();
        const dpr = window.devicePixelRatio || 1;
        canvasStore.panBy({
          x: (-(screenPoint.x - lastPos.x) * dpr) / viewport.zoom,
          y: (-(screenPoint.y - lastPos.y) * dpr) / viewport.zoom,
        });
      }
      return;
    }

    // Update drag-select rectangle if active
    if (this.dragSelect?.isActive && this.container) {
      const rect = this.container.getBoundingClientRect();
      const viewport = canvasStore.getViewport();
      const dpr = window.devicePixelRatio || 1;
      const worldPoint = screenToWorld(screenPoint, viewport, rect, dpr);

      this.dragSelect.currentPoint = worldPoint;

      // Live update selection based on entities in rectangle
      this.updateDragSelection();
    }
  }

  private updateDragSelection(): void {
    if (!this.dragSelect) return;

    const state = canvasStore.getState();
    const selectionRect = this.computeDragSelectBounds();
    const entitiesInRect = this.findEntitiesIntersectingBounds(selectionRect, state);

    // Compute the new selection based on mode
    let newSelection: Set<string>;
    switch (this.dragSelect.mode) {
      case "additive":
        // Additive mode: combine previous selection with new entities
        newSelection = new Set(this.dragSelect.previousSelection);
        for (const entityId of entitiesInRect) {
          newSelection.add(entityId);
        }
        break;
      case "subtractive":
        // Subtractive mode: remove entities in rectangle from previous selection
        newSelection = new Set(this.dragSelect.previousSelection);
        for (const entityId of entitiesInRect) {
          newSelection.delete(entityId);
        }
        break;
      case "replace":
      default:
        // Replace mode: select only entities in rectangle
        newSelection = new Set(entitiesInRect);
        break;
    }

    // Only update if selection actually changed (avoid spamming logs/notifications)
    const currentSelection = canvasStore.getSelectedEntityIds();
    if (!this.setsEqual(newSelection, currentSelection)) {
      canvasStore.replaceSelection([...newSelection]);
    }
  }

  /** Check if two sets have the same elements */
  private setsEqual<T>(a: Set<T>, b: ReadonlySet<T>): boolean {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }

  /** Compute bounding box of all selected entities (for input hit testing) */
  private computeMultiSelectBounds(state: ReturnType<typeof canvasStore.getState>): Bounds | null {
    if (state.selectedEntityIds.size <= 1) return null;

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;
    let count = 0;

    for (const id of state.selectedEntityIds) {
      const entity = state.entities.get(id);
      if (!entity) continue;
      minX = Math.min(minX, entity.position.x);
      minY = Math.min(minY, entity.position.y);
      maxX = Math.max(maxX, entity.position.x + entity.size.width);
      maxY = Math.max(maxY, entity.position.y + entity.size.height);
      count++;
    }

    if (count < 2) return null;

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  handlePointerUp(screenPoint: Point): void {
    if (this.#spacePanMode === SpacePanMode.panning) {
      this.#spacePanMode = SpacePanMode.panned;
      this.inputState.pointerDown = false;
      this.inputState.pointerDownPosition = null;
      this.inputState.lastWorldPoint = null;
      return;
    }

    // Context menu flag should already be reset by handleContextMenuClose(),
    // but keep this check as a safety net for edge cases where the menu
    // might still be animating closed while a pointer event occurs
    if (this.inputState.contextOpen) {
      this.inputState.contextOpen = false;
      this.inputState.pointerDown = false;
      this.inputState.lastWorldPoint = null;
      this.inputState.pointerDownPosition = null;
      this.inputState.pointerDownEntityId = null;
      this.inputState.pointerDownWasSelected = false;
      this.dragTarget = null;
      this.snapAccumulator = null;
      this.dragSelect = null;
      entityDragVisual.release();
      return;
    }

    // Complete drag-select if active
    if (this.dragSelect?.isActive) {
      // Selection was already updated during drag via updateDragSelection
      this.dragSelect = null;
      // Force re-render to clear the drag-select rectangle from screen
      canvasStore.setContainerDirty();
      this.inputState.pointerDown = false;
      this.inputState.lastWorldPoint = null;
      this.inputState.pointerDownPosition = null;
      return;
    }

    // Calculate distance moved in screen space
    const downPos = this.inputState.pointerDownPosition;
    const downEntityId = this.inputState.pointerDownEntityId;

    // 5 pixels is the threshold for distinguishing click from drag
    const CLICK_THRESHOLD = 5;

    // Check if this was a click (not a drag) on an entity
    if (downPos && downEntityId && this.container) {
      const dx = screenPoint.x - downPos.x;
      const dy = screenPoint.y - downPos.y;
      const distanceMoved = Math.sqrt(dx * dx + dy * dy);

      if (distanceMoved < CLICK_THRESHOLD) {
        // This was a click, not a drag
        // Check if pointer is still over the same entity
        const rect = this.container.getBoundingClientRect();
        const state = canvasStore.getState();
        const viewport = canvasStore.getViewport();
        const dpr = window.devicePixelRatio || 1;
        const worldPoint = screenToWorld(screenPoint, viewport, rect, dpr);
        const currentEntityId = this.findEntityAtPoint(worldPoint, state);

        if (currentEntityId === downEntityId) {
          // If clicking on entity that was already part of a multi-selection, select just that entity
          // (Skip if entity wasn't selected before - that means this was a shift+click to add it)
          if (
            this.inputState.pointerDownWasSelected &&
            state.selectedEntityIds.size > 1 &&
            state.selectedEntityIds.has(currentEntityId)
          ) {
            canvasStore.replaceSelection([currentEntityId]);
            // Don't toggle video - the click was for changing selection
          } else if (this.inputState.pointerDownWasSelected) {
            // Toggle playback only if:
            // 1. Entity was already the sole selection (not collapsing multi-selection)
            // 2. Entity is animated (video or GIF)
            const entity = state.entities.get(currentEntityId);
            if (entity && isAnimatedEntity(entity)) {
              // fire-and-forget the promise
              canvasStore.togglePlayback(currentEntityId).catch((e) => logger.error(e));
            }
          }
        }
      }
    }

    // Check if this was a click (not a drag) on empty space within multi-select bounds
    if (
      downPos &&
      !downEntityId &&
      this.dragTarget?.type === DragTargetType.multiSelection &&
      !this.isInMultiSelectMode()
    ) {
      const dx = screenPoint.x - downPos.x;
      const dy = screenPoint.y - downPos.y;
      const distanceMoved = Math.sqrt(dx * dx + dy * dy);

      if (distanceMoved < CLICK_THRESHOLD) {
        // Clicked (not dragged) on empty space in selection bounds - clear selection
        canvasStore.clearSelection();
      }
    }

    // Always spring back gracefully — release() handles both drag and hold-without-drag.
    // If the possible-drag timer hasn't fired yet (phase is idle), release() is a no-op.
    entityDragVisual.release();

    // Reset input state
    this.inputState.pointerDown = false;
    this.inputState.lastWorldPoint = null;
    this.inputState.pointerDownPosition = null;
    this.inputState.pointerDownEntityId = null;
    this.inputState.pointerDownWasSelected = false;
    this.dragTarget = null;
    this.snapAccumulator = null;
  }

  handleWheel(deltaX: number, deltaY: number, screenPoint: Point, ctrlKey: boolean): void {
    // Cancel any viewport animation when user starts panning/zooming
    viewportAnimation.cancel();
    this.cancelZoomMomentum();
    // Manual viewport change invalidates double-tap zoom-back
    this.savedViewport = null;

    if (!this.container) return;

    const viewport = canvasStore.getViewport(); // Always get fresh viewport
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    if (ctrlKey) {
      // Zoom
      const zoomFactor = deltaY > 0 ? 0.955 : 1.045;
      const newZoom = clampZoom(viewport.zoom * zoomFactor);

      // Zoom towards mouse position
      const worldBefore = screenToWorld(screenPoint, viewport, rect, dpr);
      canvasStore.setViewport({ ...viewport, zoom: newZoom });
      const worldAfter = screenToWorld(screenPoint, canvasStore.getViewport(), rect, dpr);

      canvasStore.panBy({
        x: worldBefore.x - worldAfter.x,
        y: worldBefore.y - worldAfter.y,
      });
    } else {
      // Pan
      canvasStore.panBy({
        x: (deltaX * dpr) / viewport.zoom,
        y: (deltaY * dpr) / viewport.zoom,
      });
    }
  }

  handleContextMenu(screenPoint: Point): void {
    if (!this.container) return;

    // Reset any drag state from preceding pointerdown
    this.inputState.pointerDown = false;
    this.dragTarget = null;
    this.snapAccumulator = null;
    this.dragSelect = null;

    this.inputState.contextOpen = true;
    this.inputState.pointerPosition = screenPoint;
    this.inputState.pointerDownPosition = screenPoint;

    const rect = this.container.getBoundingClientRect();
    const state = canvasStore.getState();
    const viewport = canvasStore.getViewport(); // Always get fresh viewport
    const dpr = window.devicePixelRatio || 1;
    const worldPoint = screenToWorld(screenPoint, viewport, rect, dpr);

    this.inputState.lastWorldPoint = worldPoint;

    const entityId = this.findEntityAtPoint(worldPoint, state);
    if (entityId) {
      this.inputState.pointerDownEntityId = entityId;
      this.inputState.contextOpenEntityId = entityId;
      this.inputState.pointerDownWasSelected = state.selectedEntityIds.has(entityId);
      this.dragTarget = { type: DragTargetType.entity, entityId };

      // Only replace selection if clicked entity is NOT already selected
      // This preserves multi-selection when right-clicking on a selected entity
      if (!state.selectedEntityIds.has(entityId)) {
        canvasStore.setSelectedEntity(entityId);
      }
      // Always set context open entity (for menu positioning reference)
      canvasStore.setContextOpenEntity(entityId);
    } else {
      this.inputState.pointerDownEntityId = null;
      this.inputState.pointerDownWasSelected = false;
      this.inputState.contextOpenEntityId = null;
      this.dragTarget = null;
      this.snapAccumulator = null;
      canvasStore.setSelectedEntity(null);
      canvasStore.setContextOpenEntity(null);
    }
  }

  handleContextMenuClose(): void {
    // Reset context menu flag when menu closes (via button click or otherwise)
    this.inputState.contextOpen = false;
    // Keep other input state intact - user may have clicked an action that modified
    // the entity (like send to front/back), and the entity should remain selected
    // and ready for immediate interaction
  }

  // ============================================================================
  // Drag-to-Select Helper Methods
  // ============================================================================

  /** Compute bounding box from drag-select start and current points */
  private computeDragSelectBounds(): Bounds {
    if (!this.dragSelect) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    const { startPoint, currentPoint } = this.dragSelect;
    return {
      x: Math.min(startPoint.x, currentPoint.x),
      y: Math.min(startPoint.y, currentPoint.y),
      width: Math.abs(currentPoint.x - startPoint.x),
      height: Math.abs(currentPoint.y - startPoint.y),
    };
  }

  /** Find all entity IDs that intersect with the given bounds */
  private findEntitiesIntersectingBounds(
    bounds: Bounds,
    state: ReturnType<typeof canvasStore.getState>,
  ): string[] {
    const result: string[] = [];

    for (const [id, entity] of state.entities) {
      if (entity.locked) continue;

      const entityBounds = createBounds(entity.position, entity.size);
      if (boundsIntersect(bounds, entityBounds)) {
        result.push(id);
      }
    }

    return result;
  }

  /** Get the current drag-select bounds for rendering (null if not active) */
  getDragSelectBounds(): Bounds | null {
    if (!this.dragSelect?.isActive) return null;
    return this.computeDragSelectBounds();
  }

  /** Get current drag-select mode */
  getDragSelectMode(): DragSelectMode | null {
    return this.dragSelect?.mode ?? null;
  }

  /** Compute bounding box for a set of entity IDs */
  private computeBoundsForEntityIds(entityIds: Set<string>): Bounds | null {
    if (entityIds.size <= 1) return null;

    const state = canvasStore.getState();
    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;
    let count = 0;

    for (const id of entityIds) {
      const entity = state.entities.get(id);
      if (!entity) continue;
      minX = Math.min(minX, entity.position.x);
      minY = Math.min(minY, entity.position.y);
      maxX = Math.max(maxX, entity.position.x + entity.size.width);
      maxY = Math.max(maxY, entity.position.y + entity.size.height);
      count++;
    }

    if (count < 2) return null;

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  /** Get bounding box of all selected entities (for multi-select visual) */
  getMultiSelectBounds(): Bounds | null {
    // Hide during action layer (context menu) — rect doesn't track entity rubber-band offset
    if (actionLayerController.isActive()) return null;

    // During subtractive drag-select, show bounds of CURRENT selection
    // (updates in real-time as entities are deselected)
    if (this.dragSelect?.isActive && this.dragSelect.mode === "subtractive") {
      const currentSelection = canvasStore.getSelectedEntityIds();
      return this.computeBoundsForEntityIds(new Set(currentSelection));
    }

    // Don't show multi-select bounds during other drag-select modes
    if (this.dragSelect?.isActive) return null;

    const selectedIds = canvasStore.getSelectedEntityIds();
    if (selectedIds.size <= 1) return null; // Only show for multi-select

    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return null;

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    const isDragVisualActive = entityDragVisual.isActive();

    for (const entity of entities) {
      if (isDragVisualActive) {
        // Use visually scaled bounds so the bounding box matches the scaled entities
        const scale = entityDragVisual.getScale(entity.id);
        const offsetX = ((1 - scale) * entity.size.width) / 2;
        const offsetY = ((1 - scale) * entity.size.height) / 2;
        minX = Math.min(minX, entity.position.x + offsetX);
        minY = Math.min(minY, entity.position.y + offsetY);
        maxX = Math.max(maxX, entity.position.x + offsetX + entity.size.width * scale);
        maxY = Math.max(maxY, entity.position.y + offsetY + entity.size.height * scale);
      } else {
        minX = Math.min(minX, entity.position.x);
        minY = Math.min(minY, entity.position.y);
        maxX = Math.max(maxX, entity.position.x + entity.size.width);
        maxY = Math.max(maxY, entity.position.y + entity.size.height);
      }
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  // ============================================================================
  // Long-Press Entity Drag (Mobile)
  // ============================================================================

  /** Cancel any pending double-tap delayed action timer */
  private cancelDoubleTapTimer(): void {
    if (this.doubleTapTimerId !== null) {
      clearTimeout(this.doubleTapTimerId);
      this.doubleTapTimerId = null;
    }
  }

  /** Handle double-tap on an entity: zoom-to-fit or toggle back to saved viewport */
  private handleDoubleTapOnEntity(entityId: string): void {
    if (!this.container) return;

    // Ensure the entity is selected
    canvasStore.replaceSelection([entityId]);

    if (this.savedViewport && this.savedViewport.entityId === entityId) {
      // Toggle back to saved viewport
      viewportAnimation.animateTo(this.savedViewport.viewport, {
        duration: config.canvas.animation.fitToViewDuration,
        easing: easings[config.canvas.animation.easing],
      });
      this.savedViewport = null;
    } else {
      // Save current viewport and zoom to fit
      const currentViewport = canvasStore.getViewport();
      this.savedViewport = {
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
        containerWidth: this.container.clientWidth,
        containerHeight: this.container.clientHeight,
        dpr,
        padding: config.canvas.fitToViewPadding,
        minZoom: undefined,
        maxZoom: undefined,
        bottomInset: config.canvas.mobile.bottomInset,
      });

      viewportAnimation.animateTo(target, {
        duration: config.canvas.animation.fitToViewDuration,
        easing: easings[config.canvas.animation.easing],
      });
    }
  }

  /** Cancel any pending long-press timer. Releases drag visual with spring animation if active. */
  private cancelLongPressTimer(): void {
    const timerId = this.touchState.longPressTimerId;
    if (timerId !== null) {
      clearTimeout(timerId);
      this.touchState.longPressTimerId = null;
      // If the entity is visually scaled (possible-drag fired), spring back gracefully.
      // If the timer hadn't fired yet, release() is a no-op (phase is still idle).
      entityDragVisual.release();
    }
    this.touchState.longPressEntityId = null;
  }

  /** Activate entity drag mode after long-press timer fires */
  private activateLongPressDrag(): void {
    this.touchState.longPressTimerId = null;

    const entityId = this.touchState.longPressEntityId;
    if (!entityId) return;

    // Only activate if still in single-finger state
    if (this.touchState.touchCount !== 1) return;

    // Long-press drag takes priority over double-tap-hold zoom
    this.doubleTapHoldZoom = {
      isCandidate: false,
      isZooming: false,
      anchorPoint: null,
      lastY: 0,
      rawZoom: 1,
    };

    // Stop panning — the viewport freezes
    this.touchState.isPanning = false;

    // Select the entity
    const state = canvasStore.getState();
    if (this.isInMultiSelectMode() && !state.selectedEntityIds.has(entityId)) {
      canvasStore.addToSelection(entityId);
    }

    // Re-read state (addToSelection creates a new Set)
    const currentState = canvasStore.getState();
    if (
      !(currentState.selectedEntityIds.has(entityId) && currentState.selectedEntityIds.size > 1)
    ) {
      if (!currentState.selectedEntityIds.has(entityId)) {
        canvasStore.replaceSelection([entityId]);
      }
    }

    // Determine drag target (used if transitioning to drag mode later)
    const afterSelectState = canvasStore.getState();
    if (
      afterSelectState.selectedEntityIds.has(entityId) &&
      afterSelectState.selectedEntityIds.size > 1
    ) {
      this.dragTarget = { type: DragTargetType.multiSelection };
    } else {
      this.dragTarget = { type: DragTargetType.entity, entityId };
    }

    // Set inputState for render loop
    this.inputState.pointerDown = true;
    this.inputState.pointerDownEntityId = entityId;

    // Pop-back visual: all selected entities spring to normal size
    const finalState = canvasStore.getState();
    entityDragVisual.activateDrag(finalState.selectedEntityIds);

    // Activate the action layer at the finger's position
    const touchPos = this.inputState.pointerDownPosition ?? this.touchState.lastTouchPosition;
    if (touchPos) {
      actionLayerController.activate(touchPos, finalState.selectedEntityIds);
      canvasStore.setActionLayerActive(true, finalState.selectedEntityIds, touchPos);
      this.touchState.isActionLayerActive = true;
      analytics.track("action_layer.opened", {
        entity_count: finalState.selectedEntityIds.size,
      });
    }

    // Haptic feedback
    haptic({ wantsHaptic: canvasStore.getState().haptics });
  }

  // ============================================================================
  // Touch Gesture Handlers (Mobile)
  // ============================================================================

  /** Calculate distance between two touch points */
  private getTouchDistance(touch1: Point, touch2: Point): number {
    const dx = touch2.x - touch1.x;
    const dy = touch2.y - touch1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Calculate center point between two touches */
  private getTouchCenter(touch1: Point, touch2: Point): Point {
    return {
      x: (touch1.x + touch2.x) / 2,
      y: (touch1.y + touch2.y) / 2,
    };
  }

  /** Handle touch start - determines gesture type */
  handleTouchStart(touches: Point[]): void {
    // Cancel any viewport animation when user starts interacting
    viewportAnimation.cancel();
    // Cancel any momentum scrolling
    this.cancelMomentum();
    this.cancelZoomMomentum();

    if (!this.container) return;

    this.touchState.touchCount = touches.length;

    if (touches.length === 1) {
      // Single finger - pan the viewport
      const touch = touches[0]!;
      this.touchState.isPanning = true;
      this.touchState.lastTouchPosition = { x: touch.x, y: touch.y };

      // Reset velocity trackers for momentum scrolling
      this.velocityTrackerX.reset();
      this.velocityTrackerY.reset();
      const now = performance.now();
      this.velocityTrackerX.addDataPoint(now, touch.x);
      this.velocityTrackerY.addDataPoint(now, touch.y);

      // Record tap-detection state (don't select yet — wait for touchEnd to distinguish tap vs swipe)
      this.inputState.pointerDownPosition = { x: touch.x, y: touch.y };

      const rect = this.container.getBoundingClientRect();
      const state = canvasStore.getState();
      const viewport = canvasStore.getViewport();
      const dpr = window.devicePixelRatio || 1;
      const worldPoint = screenToWorld({ x: touch.x, y: touch.y }, viewport, rect, dpr);

      const entityId = this.findEntityAtPoint(worldPoint, state);
      this.inputState.pointerDownEntityId = entityId;
      this.inputState.pointerDownWasSelected = entityId
        ? state.selectedEntityIds.has(entityId)
        : false;

      // Start long-press timer and possible-drag visual if finger landed on an entity
      if (entityId) {
        this.touchState.longPressEntityId = entityId;
        this.touchState.longPressTimerId = setTimeout(() => {
          this.activateLongPressDrag();
        }, this.#touchConfig.longPressDelay);

        // If entity is already part of a multi-selection, scale all selected entities
        const dragEntityIds =
          state.selectedEntityIds.has(entityId) && state.selectedEntityIds.size > 1
            ? state.selectedEntityIds
            : new Set([entityId]);
        entityDragVisual.startPossibleDrag(dragEntityIds);
      }

      // Check for double-tap-hold-zoom candidate (works on entities and empty space)
      if (this.lastTapTime > 0) {
        const now = performance.now();
        const timeSinceLastTap = now - this.lastTapTime;
        const distFromLastTap = this.lastTapPosition
          ? Math.sqrt(
              (touch.x - this.lastTapPosition.x) ** 2 + (touch.y - this.lastTapPosition.y) ** 2,
            )
          : Infinity;

        if (timeSinceLastTap < this.#touchConfig.doubleTapWindow && distFromLastTap < 10) {
          this.doubleTapHoldZoom.isCandidate = true;
          this.doubleTapHoldZoom.anchorPoint = { x: touch.x, y: touch.y };
          // Cancel any pending delayed action from the first tap
          this.cancelDoubleTapTimer();
        }
      }
    } else if (touches.length === 2) {
      // Two fingers - pinch to zoom or move entities
      const touch1 = touches[0]!;
      const touch2 = touches[1]!;

      // Cancel any pending long-press timer (keep isDraggingEntity if already active)
      this.cancelLongPressTimer();

      // Cancel action layer if active (second finger cancels it)
      if (this.touchState.isActionLayerActive) {
        this.touchState.isActionLayerActive = false;
        actionLayerController.cancel();
        canvasStore.setActionLayerActive(false);
      }

      // Cancel double-tap-hold zoom if a second finger appears
      if (this.doubleTapHoldZoom.isCandidate || this.doubleTapHoldZoom.isZooming) {
        this.doubleTapHoldZoom = {
          isCandidate: false,
          isZooming: false,
          anchorPoint: null,
          lastY: 0,
          rawZoom: 1,
        };
      }

      this.touchState.isPanning = false;
      this.touchState.isPinching = true;
      this.touchState.hadMultiTouch = true;
      this.touchState.initialPinchDistance = this.getTouchDistance(touch1, touch2);
      this.touchState.initialZoom = canvasStore.getViewport().zoom;
      this.touchState.pinchCenter = this.getTouchCenter(touch1, touch2);
      this.touchState.lastPinchCenter = this.touchState.pinchCenter;

      // Seed zoom velocity tracker for momentum on pinch end
      this.velocityTrackerZoom.reset();
      const now = performance.now();
      this.velocityTrackerZoom.addDataPoint(now, Math.log(this.touchState.initialZoom));

      // Only move entities if already in long-press drag mode
      if (this.touchState.isDraggingEntity) {
        this.touchState.isMovingEntities = true;
      }
    }
  }

  /** Handle touch move - performs pan, zoom, or entity movement */
  handleTouchMove(touches: Point[]): void {
    if (!this.container) return;

    const viewport = canvasStore.getViewport();
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Check for double-tap-hold zoom activation (before main chain)
    if (
      touches.length === 1 &&
      this.doubleTapHoldZoom.isCandidate &&
      !this.doubleTapHoldZoom.isZooming
    ) {
      const touch = touches[0]!;
      const anchor = this.doubleTapHoldZoom.anchorPoint!;
      const dy = Math.abs(touch.y - anchor.y);

      if (dy > this.#touchConfig.doubleTapHoldZoom.activationThreshold) {
        // Activate zoom mode — stop panning
        this.doubleTapHoldZoom.isZooming = true;
        this.doubleTapHoldZoom.lastY = touch.y;
        this.doubleTapHoldZoom.rawZoom = canvasStore.getViewport().zoom;
        this.touchState.isPanning = false;

        // Cancel long-press timer (safety)
        this.cancelLongPressTimer();

        // Clear last-tap state so a third tap doesn't chain
        this.lastTapTime = 0;
        this.lastTapEntityId = null;
        this.lastTapPosition = null;

        // Seed zoom velocity tracker for momentum on release
        this.velocityTrackerZoom.reset();
        const now = performance.now();
        this.velocityTrackerZoom.addDataPoint(now, Math.log(canvasStore.getViewport().zoom));
        // Manual zoom invalidates saved viewport for double-tap toggle
        this.savedViewport = null;
      }
    }

    if (touches.length === 1 && this.doubleTapHoldZoom.isZooming) {
      // Double-tap-hold zoom: apply zoom based on vertical finger delta
      const touch = touches[0]!;
      const deltaY = touch.y - this.doubleTapHoldZoom.lastY;
      this.doubleTapHoldZoom.lastY = touch.y;

      const sensitivity = this.#touchConfig.doubleTapHoldZoom.sensitivity;
      const logDelta = -deltaY * sensitivity; // up = zoom in, down = zoom out

      // Update raw (unclamped) zoom, then apply rubber-band once for display
      // (same pattern as pinch: initialZoom * scale → rubberBandZoom)
      this.doubleTapHoldZoom.rawZoom *= Math.exp(logDelta);
      const focalPoint = this.doubleTapHoldZoom.anchorPoint!;
      const currentViewport = canvasStore.getViewport();
      const newZoom = rubberBandZoom(this.doubleTapHoldZoom.rawZoom);

      // Zoom toward the double-tap anchor point
      const worldBefore = screenToWorld(focalPoint, currentViewport, rect, dpr);
      canvasStore.setViewport({ ...currentViewport, zoom: newZoom });
      const worldAfter = screenToWorld(focalPoint, canvasStore.getViewport(), rect, dpr);
      canvasStore.panBy({
        x: worldBefore.x - worldAfter.x,
        y: worldBefore.y - worldAfter.y,
      });

      // Track zoom velocity for momentum on release
      const now = performance.now();
      this.velocityTrackerZoom.addDataPoint(now, Math.log(canvasStore.getViewport().zoom));
    } else if (touches.length === 1 && this.touchState.isActionLayerActive) {
      // Action layer active: update finger position for rubber-banding
      const touch = touches[0]!;
      actionLayerController.updateFingerPosition(touch);
      this.touchState.lastTouchPosition = { x: touch.x, y: touch.y };

      // Check safe zone exit → transition to entity drag
      const touchOrigin = actionLayerController.getTouchOrigin();
      const dx = touch.x - touchOrigin.x;
      const dy = touch.y - touchOrigin.y;
      const distFromOrigin = Math.sqrt(dx * dx + dy * dy);
      if (distFromOrigin > config.actionLayer.safeZoneRadius) {
        // Apply rubber-band offset to entity positions so drag continues
        // from the visual position (prevents jump back to origin)
        const cssOffset = actionLayerController.getEntityOffset();
        const dpr = window.devicePixelRatio || 1;
        const worldOffset = {
          x: (cssOffset.x * dpr) / viewport.zoom,
          y: (cssOffset.y * dpr) / viewport.zoom,
        };

        if (this.dragTarget?.type === DragTargetType.multiSelection) {
          for (const entityId of canvasStore.getState().selectedEntityIds) {
            canvasStore.moveEntity(entityId, worldOffset);
          }
        } else if (this.dragTarget?.type === DragTargetType.entity && this.dragTarget.entityId) {
          canvasStore.moveEntity(this.dragTarget.entityId, worldOffset);
        }

        // Compute catch-up correction: finger's full travel minus rubber-band offset applied
        const totalMoveX = ((touch.x - touchOrigin.x) * dpr) / viewport.zoom;
        const totalMoveY = ((touch.y - touchOrigin.y) * dpr) / viewport.zoom;
        const catchUpX = totalMoveX - worldOffset.x;
        const catchUpY = totalMoveY - worldOffset.y;

        // Initialize catch-up spring (same spring feel as action layer)
        const { entitySpringResponse, entitySpringDamping } = config.actionLayer;
        this.#dragCatchUp.spring.start(
          { x: catchUpX, y: catchUpY },
          { x: 0, y: 0 },
          entitySpringResponse,
          entitySpringDamping,
        );
        this.#dragCatchUp.active = true;
        this.#dragCatchUp.lastTime = performance.now();
        // Save entity IDs so springs can continue after finger lift
        this.#springEntityIds = new Set(canvasStore.getSelectedEntityIds());

        actionLayerController.transitionToDrag();
        canvasStore.setActionLayerActive(false);
        canvasStore.setEntityDragActive(true);
        this.touchState.isActionLayerActive = false;
        this.touchState.isDraggingEntity = true;
        this.touchState.isPanning = false;
      }
    } else if (touches.length === 1 && this.touchState.isDraggingEntity) {
      // Long-press entity drag: move entity instead of panning
      const touch = touches[0]!;
      const lastPos = this.touchState.lastTouchPosition;

      if (lastPos) {
        const dpr = window.devicePixelRatio || 1;
        const worldDelta = {
          x: ((touch.x - lastPos.x) * dpr) / viewport.zoom,
          y: ((touch.y - lastPos.y) * dpr) / viewport.zoom,
        };

        if (this.#dragCatchUp.active || this.#snapSettle.active) {
          // During catch-up or snap-settle: bypass snap for smooth animation
          if (this.#snapSettle.active) {
            // Finger moved during snap-settle — cancel it, hand off to normal snap
            this.#snapSettle.active = false;
            this.snapAccumulator = null;
          }
          this.#moveEntitiesRaw(worldDelta);
        } else if (this.dragTarget?.type === DragTargetType.multiSelection) {
          this.moveSelectedEntities(worldDelta);
        } else if (this.dragTarget?.type === DragTargetType.entity && this.dragTarget.entityId) {
          if (canvasStore.getState().snapToGrid) {
            this.moveEntitySnapped(this.dragTarget.entityId, worldDelta);
          } else {
            canvasStore.moveEntity(this.dragTarget.entityId, worldDelta);
          }
        }
      }

      // Update position but skip velocity tracking (no momentum on entity drop)
      this.touchState.lastTouchPosition = { x: touch.x, y: touch.y };
    } else if (touches.length === 1 && this.touchState.isPanning) {
      // Single finger pan — manual viewport change invalidates double-tap zoom-back
      this.savedViewport = null;
      const touch = touches[0]!;
      const lastPos = this.touchState.lastTouchPosition;

      // Cancel long-press timer if finger moved beyond threshold
      if (this.touchState.longPressTimerId !== null) {
        const downPos = this.inputState.pointerDownPosition;
        if (downPos) {
          const dx = touch.x - downPos.x;
          const dy = touch.y - downPos.y;
          if (Math.sqrt(dx * dx + dy * dy) > this.#touchConfig.longPressMoveThreshold) {
            this.cancelLongPressTimer();
          }
        }
      }

      if (lastPos) {
        const deltaX = touch.x - lastPos.x;
        const deltaY = touch.y - lastPos.y;

        // Pan the viewport (content follows finger)
        const dpr = window.devicePixelRatio || 1;
        canvasStore.panBy({
          x: (-deltaX * dpr) / viewport.zoom,
          y: (-deltaY * dpr) / viewport.zoom,
        });
      }

      // Track velocity for momentum scrolling
      const now = performance.now();
      this.velocityTrackerX.addDataPoint(now, touch.x);
      this.velocityTrackerY.addDataPoint(now, touch.y);

      this.touchState.lastTouchPosition = { x: touch.x, y: touch.y };
    } else if (touches.length === 2 && this.touchState.isPinching) {
      // Pinch zoom — manual viewport change invalidates double-tap zoom-back
      this.savedViewport = null;
      const touch1 = touches[0]!;
      const touch2 = touches[1]!;

      // Calculate current pinch state
      const currentDistance = this.getTouchDistance(touch1, touch2);
      const currentCenter = this.getTouchCenter(touch1, touch2);

      // Handle zoom
      if (this.touchState.initialPinchDistance && this.touchState.initialZoom) {
        const scale = currentDistance / this.touchState.initialPinchDistance;
        const newZoom = rubberBandZoom(this.touchState.initialZoom * scale);

        // Zoom towards pinch center
        const worldBefore = screenToWorld(currentCenter, viewport, rect, dpr);
        canvasStore.setViewport({ ...viewport, zoom: newZoom });
        const worldAfter = screenToWorld(currentCenter, canvasStore.getViewport(), rect, dpr);

        // Adjust pan to keep pinch center stationary
        canvasStore.panBy({
          x: worldBefore.x - worldAfter.x,
          y: worldBefore.y - worldAfter.y,
        });

        // Track zoom velocity in log-space for momentum on pinch end
        const currentZoom = canvasStore.getViewport().zoom;
        const now = performance.now();
        this.velocityTrackerZoom.addDataPoint(now, Math.log(currentZoom));
      }

      // Handle pan during pinch (move both fingers together)
      if (this.touchState.lastPinchCenter) {
        const deltaX = currentCenter.x - this.touchState.lastPinchCenter.x;
        const deltaY = currentCenter.y - this.touchState.lastPinchCenter.y;

        // If we have selected entities and are moving them
        if (this.touchState.isMovingEntities) {
          const updatedViewport = canvasStore.getViewport();
          const dpr = window.devicePixelRatio || 1;
          const worldDelta: Point = {
            x: (deltaX * dpr) / updatedViewport.zoom,
            y: (deltaY * dpr) / updatedViewport.zoom,
          };
          this.moveSelectedEntities(worldDelta);
        } else {
          // Otherwise pan the viewport (content follows fingers)
          const dpr = window.devicePixelRatio || 1;
          canvasStore.panBy({
            x: (-deltaX * dpr) / canvasStore.getViewport().zoom,
            y: (-deltaY * dpr) / canvasStore.getViewport().zoom,
          });
        }
      }

      this.touchState.lastPinchCenter = currentCenter;
    }
  }

  /** Handle touch end - reset gesture state */
  handleTouchEnd(remainingTouches: { x: number; y: number }[], isCancelled: boolean = false): void {
    if (remainingTouches.length === 0) {
      if (this.doubleTapHoldZoom.isZooming) {
        // Double-tap-hold zoom ended — trigger zoom momentum
        if (!isCancelled) {
          this.triggerZoomMomentum(this.doubleTapHoldZoom.anchorPoint);
        }
        this.doubleTapHoldZoom = {
          isCandidate: false,
          isZooming: false,
          anchorPoint: null,
          lastY: 0,
          rawZoom: 1,
        };
      } else if (this.touchState.isActionLayerActive) {
        // Action layer finger lift — dismiss the controller (animates blur out + entity spring-back).
        // React may also call dismiss() on its touchend, but dismiss() is idempotent for idle phase.
        this.touchState.isActionLayerActive = false;
        actionLayerController.dismiss();
        canvasStore.setActionLayerActive(false);
        entityDragVisual.release();
      } else if (this.touchState.isDraggingEntity) {
        // Entity drag complete — just drop it. No tap handling, no momentum.
        canvasStore.setEntityDragActive(false);
        entityDragVisual.release();
        // Let catch-up and snap-settle springs continue after finger lift —
        // #springEntityIds preserves the target entities, #moveEntitiesRaw falls back to it.
        // If snap-to-grid is on and no settle is running yet, start one now.
        if (this.#dragCatchUp.active && canvasStore.getState().snapToGrid) {
          this.#moveEntitiesRaw(this.#dragCatchUp.spring.flush());
          this.#dragCatchUp.active = false;
          this.#initSnapSettle();
        }
      } else if (!isCancelled && this.touchState.isPinching) {
        // Pinch ended (both fingers lifted) — trigger zoom momentum
        this.triggerZoomMomentum();
      } else if (!isCancelled && this.touchState.isPanning && !this.touchState.hadMultiTouch) {
        // Detect tap vs swipe: tap triggers selection/playback, swipe triggers momentum
        if (this.detectTouchTap()) {
          this.handleTouchTap();
        } else {
          this.triggerMomentumScrolling();
        }
      }
      // Cancel any pending long-press timer
      this.cancelLongPressTimer();
      // Reset touch state (but keep momentum running)
      this.resetTouchState();
    } else if (remainingTouches.length === 1) {
      // Went from two fingers to one — trigger zoom momentum BEFORE resetting state
      // (browsers fire sequential touchend events, so this is the real "pinch end")
      if (!isCancelled && this.touchState.isPinching) {
        this.triggerZoomMomentum();
      }

      const touch = remainingTouches[0]!;
      this.touchState.touchCount = 1;
      this.touchState.isPinching = false;
      this.touchState.isMovingEntities = false;
      this.touchState.initialPinchDistance = null;
      this.touchState.initialZoom = null;
      this.touchState.pinchCenter = null;
      this.touchState.lastPinchCenter = null;
      // Reset zoom velocity tracker — pinch data consumed by triggerZoomMomentum above
      this.velocityTrackerZoom.reset();

      if (this.touchState.isDraggingEntity) {
        // Resume entity drag with the remaining finger
        this.touchState.isPanning = false;
        this.touchState.lastTouchPosition = { x: touch.x, y: touch.y };
      } else {
        // Switch to panning
        this.touchState.isPanning = true;
        this.touchState.lastTouchPosition = { x: touch.x, y: touch.y };

        // Reset velocity trackers for the new single-finger pan
        this.velocityTrackerX.reset();
        this.velocityTrackerY.reset();
        const now = performance.now();
        this.velocityTrackerX.addDataPoint(now, touch.x);
        this.velocityTrackerY.addDataPoint(now, touch.y);
      }

      // Reset tap-detection state for fresh single-finger context
      this.inputState.pointerDownPosition = { x: touch.x, y: touch.y };
      this.inputState.pointerDownEntityId = null;
      this.inputState.pointerDownWasSelected = false;
    }
  }

  /**
   * Calculate velocity from trackers and start momentum scrolling if fast enough.
   */
  private triggerMomentumScrolling(): void {
    const velX = this.velocityTrackerX.calculate();
    const velY = this.velocityTrackerY.calculate();

    // Only start momentum if velocity exceeds configurable threshold
    if (
      Math.abs(velX) > this.#touchConfig.velocityThreshold ||
      Math.abs(velY) > this.#touchConfig.velocityThreshold
    ) {
      // Clamp velocity to prevent extreme flings from sharp/short gestures
      const maxVel = this.#touchConfig.maxVelocity;
      const clampedVelX = Math.max(-maxVel, Math.min(maxVel, velX));
      const clampedVelY = Math.max(-maxVel, Math.min(maxVel, velY));

      this.scrollerX.reset();
      this.scrollerY.reset();
      // Apply velocity scale for snappier momentum
      this.scrollerX.fling(clampedVelX * this.#touchConfig.velocityScale);
      this.scrollerY.fling(clampedVelY * this.#touchConfig.velocityScale);
      this.momentumActive = true;
      this.momentumStartTime = performance.now();
      this.lastMomentumOffset = { x: 0, y: 0 };
    }
  }

  /** Detect if the current touch gesture was a tap (not a swipe) */
  private detectTouchTap(): boolean {
    const downPos = this.inputState.pointerDownPosition;
    const lastPos = this.touchState.lastTouchPosition;
    if (!downPos || !lastPos) return false;

    const dx = lastPos.x - downPos.x;
    const dy = lastPos.y - downPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // 10px threshold (larger than pointer's 5px due to finger imprecision)
    const TOUCH_TAP_THRESHOLD = 10;
    return distance < TOUCH_TAP_THRESHOLD;
  }

  /** Handle a tap gesture — select/deselect entities, toggle playback, or double-tap zoom */
  private handleTouchTap(): void {
    if (!this.container) return;

    // Cancel any pending delayed single-tap action (playback toggle from a previous tap)
    this.cancelDoubleTapTimer();

    const tapPosition = this.touchState.lastTouchPosition;
    if (!tapPosition) return;

    const rect = this.container.getBoundingClientRect();
    const state = canvasStore.getState();
    const viewport = canvasStore.getViewport();
    const dpr = window.devicePixelRatio || 1;
    const worldPoint = screenToWorld(tapPosition, viewport, rect, dpr);

    const tappedEntityId = this.findEntityAtPoint(worldPoint, state);
    const downEntityId = this.inputState.pointerDownEntityId;

    // Determine the effective entity (must match touch-down entity)
    const entityId = tappedEntityId && tappedEntityId === downEntityId ? tappedEntityId : null;

    // --- Double-tap detection ---
    const now = performance.now();
    const isDoubleTap =
      this.lastTapTime > 0 &&
      now - this.lastTapTime < this.#touchConfig.doubleTapWindow &&
      this.lastTapPosition !== null &&
      Math.sqrt(
        (tapPosition.x - this.lastTapPosition.x) ** 2 +
          (tapPosition.y - this.lastTapPosition.y) ** 2,
      ) < 10 && // TOUCH_TAP_THRESHOLD
      entityId === this.lastTapEntityId;

    if (isDoubleTap && !this.isInMultiSelectMode()) {
      // Clear last-tap state so a third tap starts fresh
      this.lastTapTime = 0;
      this.lastTapEntityId = null;
      this.lastTapPosition = null;

      if (entityId) {
        // Double-tap on entity → zoom to fit (or toggle back)
        this.handleDoubleTapOnEntity(entityId);
        return;
      }

      // Double-tap on empty space → fall through as single tap (clear selection)
      if (!tappedEntityId && !downEntityId) {
        canvasStore.clearSelection();
      }
      return;
    }

    // --- Record this tap for future double-tap detection ---
    this.lastTapTime = now;
    this.lastTapEntityId = entityId;
    this.lastTapPosition = { ...tapPosition };

    // --- Single-tap handling ---
    if (this.isInMultiSelectMode()) {
      // Multi-select mode: toggle entity selection, ignore empty space
      if (entityId) {
        canvasStore.toggleSelection(entityId);
      }
      // Empty space tap: do nothing (stay in multi-select mode, keep selection)
    } else {
      // Normal mode
      if (entityId) {
        if (this.inputState.pointerDownWasSelected && canvasStore.getSelectionCount() > 1) {
          // Multi-selection active — collapse to just the tapped entity
          canvasStore.replaceSelection([entityId]);
        } else if (this.inputState.pointerDownWasSelected) {
          // Entity was already selected (sole selection) — delay playback toggle to allow double-tap
          const capturedEntityId = entityId;
          this.doubleTapTimerId = setTimeout(() => {
            this.doubleTapTimerId = null;
            const entity = canvasStore.getState().entities.get(capturedEntityId);
            if (entity && isAnimatedEntity(entity)) {
              canvasStore.togglePlayback(capturedEntityId).catch((e) => this.#logger.error(e));
            }
          }, this.#touchConfig.doubleTapWindow);
        } else {
          // Entity was not selected — select it now
          canvasStore.replaceSelection([entityId]);
        }
      } else if (!tappedEntityId && !downEntityId) {
        // Tapped on empty space (finger started and ended on empty space)
        canvasStore.clearSelection();
      }
      // If tappedEntityId !== downEntityId (finger slid between entities within threshold), do nothing
    }
  }

  /** Reset all touch state */
  private resetTouchState(): void {
    this.cancelLongPressTimer();
    // Clear drag state before resetting (guard: only notify store if drag was active)
    if (this.touchState.isDraggingEntity) {
      canvasStore.setEntityDragActive(false);
    }
    // Clear action layer state
    if (this.touchState.isActionLayerActive) {
      this.touchState.isActionLayerActive = false;
      // Don't dismiss controller here — React may still be animating
    }
    // Note: do NOT cancel doubleTapTimer here — it must survive across taps
    // so the delayed playback toggle can fire after the double-tap window expires.
    this.touchState = {
      touchCount: 0,
      initialPinchDistance: null,
      initialZoom: null,
      pinchCenter: null,
      lastPinchCenter: null,
      lastTouchPosition: null,
      isPinching: false,
      isPanning: false,
      isMovingEntities: false,
      hadMultiTouch: false,
      isDraggingEntity: false,
      longPressTimerId: null,
      longPressEntityId: null,
      isActionLayerActive: false,
    };
    this.dragTarget = null;
    this.snapAccumulator = null;
    // Let catch-up/snap-settle springs continue (they use #springEntityIds, not dragTarget)
    if (!this.#dragCatchUp.active && !this.#snapSettle.active) {
      this.#springEntityIds = null;
    }
    this.doubleTapHoldZoom = {
      isCandidate: false,
      isZooming: false,
      anchorPoint: null,
      lastY: 0,
      rawZoom: 1,
    };
    this.inputState.pointerDown = false;
    this.inputState.pointerDownPosition = null;
    this.inputState.pointerDownEntityId = null;
    this.inputState.pointerDownWasSelected = false;
  }

  /** Check if a touch interaction is active */
  isTouchActive(): boolean {
    return this.touchState.touchCount > 0;
  }
}

// Singleton instance
export const gameLoop = new GameLoop();
