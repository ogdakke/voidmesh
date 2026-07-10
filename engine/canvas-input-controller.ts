import { analytics } from "#lib/analytics.ts";
import { logger } from "#lib/client.logger.ts";
import { pointInBounds } from "#lib/canvas-math.ts";
import { config, type TouchConfig } from "#config";
import { VelocityTracker } from "#lib/touch-scroll/index.ts";
import { DragTargetType, type Bounds, type Point } from "#types/canvas.ts";
import { createEnum } from "#types/index.ts";
import { canvasStore } from "./canvas-store.ts";
import { entityDragVisual } from "./entity-drag-visual.ts";
import { actionLayerController } from "./action-layer-controller.ts";
import { disintegrationController } from "./disintegration-controller.ts";
import { perfOverlay } from "./perf-overlay.ts";
import { viewportAnimation } from "./viewport-animation.ts";
import { scheduler } from "#lib/animation-scheduler.ts";
import { haptic } from "#lib/haptic.ts";
import { OnboardingStepId } from "#lib/onboarding.ts";
import { completeOnboardingStepFromEvent } from "#lib/onboarding-runtime.ts";
import { EntityDragController } from "./entity-drag-controller.ts";
import {
  CanvasSelectionController,
  type DragSelectMode,
  type DragSelectState,
} from "./canvas-selection-controller.ts";
import { CanvasViewportController } from "./canvas-viewport-controller.ts";

export type { DragSelectMode, DragSelectState } from "./canvas-selection-controller.ts";

const RELEASE_TERMINAL_SPEED_MULTIPLIER = 1.15;

export function createDefaultGameLoopDeps() {
  return {
    scheduler,
    viewportAnimation,
    actionLayer: actionLayerController,
    dragVisual: entityDragVisual,
    disintegration: disintegrationController,
    perf: perfOverlay,
    haptic,
    analytics,
  };
}

function constrainReleaseVelocityToTerminalMotion(velocity: Point, terminalVelocity: Point): Point {
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed === 0) return velocity;

  const terminalSpeed = Math.hypot(terminalVelocity.x, terminalVelocity.y);
  const maxSpeed = terminalSpeed * RELEASE_TERMINAL_SPEED_MULTIPLIER;

  if (maxSpeed >= speed) {
    return velocity;
  }

  const ratio = maxSpeed / speed;
  return {
    x: velocity.x * ratio,
    y: velocity.y * ratio,
  };
}

export type GameLoopDeps = ReturnType<typeof createDefaultGameLoopDeps>;

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
export type SpacePanMode = typeof SpacePanMode.infer;

export class CanvasInputController {
  readonly #deps: GameLoopDeps;
  #logger = logger;
  #container: HTMLElement | null = null;
  #containerRect: DOMRect = new DOMRect(0, 0, 0, 0);
  #resizeObserver: ResizeObserver | null = null;
  #pendingScrollMomentumVelocity: Point | null = null;

  #inputState: InputState = {
    pointerPosition: null,
    pointerDown: false,
    lastWorldPoint: null,
    pointerDownPosition: null,
    pointerDownEntityId: null,
    contextOpenEntityId: null,
    pointerDownWasSelected: false,
    contextOpen: false,
  };

  readonly #selection = new CanvasSelectionController();
  #viewport: CanvasViewportController;
  #entityDrag: EntityDragController;
  #dragSelect: DragSelectState | null = null;
  #dragSelectPendingUpdate = false;
  /** Touch gesture state for mobile interactions */
  #touchState: TouchGestureState = {
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

  /** Reusable velocity trackers for momentum scrolling (avoids GC) */
  readonly #velocityTrackerX = new VelocityTracker();
  readonly #velocityTrackerY = new VelocityTracker();

  /** Reusable velocity tracker for zoom rate in log(zoom) space */
  readonly #velocityTrackerZoom = new VelocityTracker();

  /** Touch sensitivity configuration */
  #touchConfig: TouchConfig = { ...config.touch };

  /** Space+drag canvas pan state machine */
  #spacePanMode: SpacePanMode = SpacePanMode.idle;

  /** Double-tap detection state */
  #lastTapTime = 0;
  #lastTapEntityId: string | null = null;
  #lastTapPosition: Point | null = null;
  #doubleTapTimerId: ReturnType<typeof setTimeout> | null = null;

  /** Double-tap + hold + drag zoom state (iOS Maps-style one-finger zoom) */
  #doubleTapHoldZoom = {
    isCandidate: false,
    isZooming: false,
    anchorPoint: null as Point | null,
    lastY: 0,
    /** Raw unclamped zoom — rubber-band is applied once per frame for display */
    rawZoom: 1,
  };

  /** Multi-select mode is stored in canvasStore for React reactivity */

  constructor(deps: GameLoopDeps) {
    this.#deps = deps;
    this.#viewport = new CanvasViewportController(
      this.#deps.scheduler,
      this.#deps.viewportAnimation,
    );
    this.#entityDrag = new EntityDragController(this.#deps.scheduler);
  }

  setContainer(container: HTMLElement): void {
    this.#container = container;
    this.#containerRect = container.getBoundingClientRect();

    this.#resizeObserver?.disconnect();
    this.#resizeObserver = new ResizeObserver(() => {
      this.#containerRect = container.getBoundingClientRect();
      this.#viewport.setContainerRect(this.#containerRect);
      this.#logger.debug(
        `[CanvasInputController] container resized: ${this.#containerRect.width}x${this.#containerRect.height}`,
      );
    });
    this.#resizeObserver.observe(container, { box: "border-box" });

    this.#viewport.setContainer(container, this.#containerRect);
  }

  /** Configure touch sensitivity parameters for tuning */
  setTouchConfig(config: Partial<TouchConfig>): void {
    this.#touchConfig = { ...this.#touchConfig, ...config };
    this.#viewport.setTouchConfig(config);
  }

  /** Get current touch configuration */
  getTouchConfig(): TouchConfig {
    return { ...this.#touchConfig };
  }

  stop(): void {
    this.#cancelPendingScrollMomentum();
    this.#cancelLongPressTimer();
    this.#cancelDoubleTapTimer();
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
    return this.#selection.isInMultiSelectMode();
  }

  /** Stop any active momentum scrolling and zoom momentum (public API for external callers) */
  stopMomentum(): void {
    this.#cancelPendingScrollMomentum();
    this.#viewport.stopMomentum();
  }

  /**
   * Calculate zoom velocity and trigger zoom momentum with the appropriate focal point.
   * Resolves focal point from provided value or falls back to pinch center.
   */
  private triggerZoomMomentum(focalPoint?: Point | null): void {
    const vel = this.#velocityTrackerZoom.calculate();
    const resolvedFocal = focalPoint
      ? { ...focalPoint }
      : this.#touchState.pinchCenter
        ? { ...this.#touchState.pinchCenter }
        : null;
    this.#viewport.triggerZoomMomentum(vel, resolvedFocal);
  }

  processInput(): void {
    const { pointerPosition, pointerDown } = this.#inputState;
    if (!pointerPosition || !this.#container) return;

    const worldPoint = this.#viewport.screenToWorld(pointerPosition);

    // Pointer events may arrive faster than RAF. Only do the spatial query and
    // selection-set construction once for the latest point in each frame.
    if (this.#dragSelect?.isActive && this.#dragSelectPendingUpdate) {
      this.#dragSelect.currentPoint = worldPoint;
      this.#selection.updateDragSelection(this.#dragSelect);
      this.#dragSelectPendingUpdate = false;
    }

    // Update hover state
    if (!pointerDown) {
      // TODO: this was too costly
      // const hoveredId = this.findEntityAtPoint(worldPoint, state);
      canvasStore.setHoveredEntity(null);
    }

    // Handle dragging (skip if context menu is open or touch is handling drag directly)
    if (
      pointerDown &&
      !this.#inputState.contextOpen &&
      this.#entityDrag.target &&
      !this.#touchState.isDraggingEntity
    ) {
      const lastPoint = this.#inputState.lastWorldPoint;
      if (lastPoint) {
        const delta = {
          x: worldPoint.x - lastPoint.x,
          y: worldPoint.y - lastPoint.y,
        };

        // Activate drag visual on first actual movement (desktop — mobile uses long-press)
        if ((delta.x !== 0 || delta.y !== 0) && !this.#deps.dragVisual.isDragPhase()) {
          this.#deps.dragVisual.activateDrag(canvasStore.getSelectedEntityIds());
        }

        this.#entityDrag.moveTarget(delta);
      }
      this.#inputState.lastWorldPoint = worldPoint;
    }
  }

  // Input event handlers (called from React component)
  handlePointerDown(screenPoint: Point, shiftKey: boolean = false): void {
    // Cancel any viewport animation when user starts interacting
    this.#viewport.cancelInteraction();

    if (!this.#container) return;

    this.#inputState.pointerDown = true;
    this.#inputState.pointerPosition = screenPoint;
    this.#inputState.pointerDownPosition = screenPoint;

    if (this.#spacePanMode === SpacePanMode.ready || this.#spacePanMode === SpacePanMode.panned) {
      this.#spacePanMode = SpacePanMode.panning;
      this.stopMomentum();
      return;
    }

    const state = canvasStore.getState();
    const worldPoint = this.#viewport.screenToWorld(screenPoint);

    this.#inputState.lastWorldPoint = worldPoint;

    const entityId = this.#selection.findEntityAtPoint(worldPoint, state);
    const multiSelectBounds = this.#selection.computeMultiSelectBounds(state);
    const isInMultiSelectBounds = multiSelectBounds && pointInBounds(worldPoint, multiSelectBounds);

    if (entityId) {
      this.#inputState.pointerDownEntityId = entityId;
      this.#inputState.pointerDownWasSelected = state.selectedEntityIds.has(entityId);
      this.#entityDrag.setTarget(
        this.#selection.choosePointerDownEntityTarget(entityId, shiftKey, state),
      );

      // Start possible-drag visual with longer delay than mobile (200ms vs 100ms)
      // to avoid icon flash on quick clicks
      this.#deps.dragVisual.startPossibleDrag(this.#selection.getDragEntityIds(entityId), {
        directToDrag: true,
        delay: 200,
      });
    } else if (isInMultiSelectBounds && !shiftKey) {
      // Clicked on empty space within multi-select bounds: drag all selected
      this.#inputState.pointerDownEntityId = null;
      this.#inputState.pointerDownWasSelected = false;
      this.#entityDrag.setTarget({ type: DragTargetType.multiSelection });
    } else if (this.isInMultiSelectMode()) {
      // Multi-select mode: empty space click does nothing (preserve selection)
      this.#inputState.pointerDownEntityId = null;
      this.#inputState.pointerDownWasSelected = false;
      this.#entityDrag.clear();
    } else {
      // Clicked on empty space outside selection
      this.#inputState.pointerDownEntityId = null;
      this.#inputState.pointerDownWasSelected = false;
      this.#entityDrag.clear();
      this.#dragSelect = this.#selection.createDragSelect(worldPoint, shiftKey, state);
      this.#dragSelectPendingUpdate = false;
    }
  }

  handlePointerMove(screenPoint: Point): void {
    const lastPos = this.#inputState.pointerPosition;
    this.#inputState.pointerPosition = screenPoint;

    if (this.#spacePanMode === SpacePanMode.panning) {
      if (lastPos) {
        this.#viewport.panByScreenDelta(screenPoint.x - lastPos.x, screenPoint.y - lastPos.y);
      }
      return;
    }

    if (this.#dragSelect?.isActive) this.#dragSelectPendingUpdate = true;
  }

  handlePointerUp(screenPoint: Point): void {
    if (this.#spacePanMode === SpacePanMode.panning) {
      this.#spacePanMode = SpacePanMode.panned;
      this.#inputState.pointerDown = false;
      this.#inputState.pointerDownPosition = null;
      this.#inputState.lastWorldPoint = null;
      return;
    }

    // Context menu flag should already be reset by handleContextMenuClose(),
    // but keep this check as a safety net for edge cases where the menu
    // might still be animating closed while a pointer event occurs
    if (this.#inputState.contextOpen) {
      this.#inputState.contextOpen = false;
      this.#inputState.pointerDown = false;
      this.#inputState.lastWorldPoint = null;
      this.#inputState.pointerDownPosition = null;
      this.#inputState.pointerDownEntityId = null;
      this.#inputState.pointerDownWasSelected = false;
      this.#entityDrag.clear();
      if (this.#dragSelect?.isActive) canvasStore.commitTransientSelection();
      this.#dragSelect = null;
      this.#dragSelectPendingUpdate = false;
      this.#deps.dragVisual.release();
      return;
    }

    // Complete drag-select if active
    if (this.#dragSelect?.isActive) {
      if (this.#container) {
        this.#dragSelect.currentPoint = this.#viewport.screenToWorld(screenPoint);
        this.#selection.updateDragSelection(this.#dragSelect);
      }
      canvasStore.commitTransientSelection();
      this.#dragSelect = null;
      this.#dragSelectPendingUpdate = false;
      // Force re-render to clear the drag-select rectangle from screen
      canvasStore.setContainerDirty();
      this.#inputState.pointerDown = false;
      this.#inputState.lastWorldPoint = null;
      this.#inputState.pointerDownPosition = null;
      return;
    }

    // Calculate distance moved in screen space
    const downPos = this.#inputState.pointerDownPosition;
    const downEntityId = this.#inputState.pointerDownEntityId;

    // 5 pixels is the threshold for distinguishing click from drag
    const CLICK_THRESHOLD = 5;

    // Check if this was a click (not a drag) on an entity
    if (downPos && downEntityId && this.#container) {
      const dx = screenPoint.x - downPos.x;
      const dy = screenPoint.y - downPos.y;
      const distanceMoved = Math.sqrt(dx * dx + dy * dy);

      if (distanceMoved < CLICK_THRESHOLD) {
        // This was a click, not a drag
        // Check if pointer is still over the same entity
        const state = canvasStore.getState();
        const worldPoint = this.#viewport.screenToWorld(screenPoint);
        const currentEntityId = this.#selection.findEntityAtPoint(worldPoint, state);

        if (currentEntityId === downEntityId) {
          this.#selection.handlePointerEntityClick(
            currentEntityId,
            state,
            this.#inputState.pointerDownWasSelected,
          );
        }
      }
    }

    // Check if this was a click (not a drag) on empty space within multi-select bounds
    if (
      downPos &&
      !downEntityId &&
      this.#entityDrag.target?.type === DragTargetType.multiSelection &&
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
    this.#deps.dragVisual.release();

    // Reset input state
    this.#inputState.pointerDown = false;
    this.#inputState.lastWorldPoint = null;
    this.#inputState.pointerDownPosition = null;
    this.#inputState.pointerDownEntityId = null;
    this.#inputState.pointerDownWasSelected = false;
    this.#entityDrag.clear();
  }

  handleWheel(deltaX: number, deltaY: number, screenPoint: Point, ctrlKey: boolean): void {
    // Cancel any viewport animation when user starts panning/zooming
    this.#viewport.cancelInteraction();
    // Manual viewport change invalidates double-tap zoom-back
    this.#viewport.invalidateSavedViewport();

    if (!this.#container) return;

    if (ctrlKey) {
      this.#viewport.zoomByWheel(deltaY, screenPoint);
    } else {
      this.#viewport.panByWheelDelta(deltaX, deltaY);
    }
  }

  handleContextMenu(screenPoint: Point): void {
    if (!this.#container) return;

    // Reset any drag state from preceding pointerdown
    this.#inputState.pointerDown = false;
    this.#entityDrag.clear();
    if (this.#dragSelect?.isActive) canvasStore.commitTransientSelection();
    this.#dragSelect = null;
    this.#dragSelectPendingUpdate = false;
    this.#deps.dragVisual.cancel();

    this.#inputState.contextOpen = true;
    this.#inputState.pointerPosition = screenPoint;
    this.#inputState.pointerDownPosition = screenPoint;

    const state = canvasStore.getState();
    const worldPoint = this.#viewport.screenToWorld(screenPoint);

    this.#inputState.lastWorldPoint = worldPoint;

    const entityId = this.#selection.findEntityAtPoint(worldPoint, state);
    if (entityId) {
      this.#inputState.pointerDownEntityId = entityId;
      this.#inputState.contextOpenEntityId = entityId;
      this.#inputState.pointerDownWasSelected = state.selectedEntityIds.has(entityId);
      this.#entityDrag.setTarget({ type: DragTargetType.entity, entityId });
      this.#selection.handleContextMenuEntity(entityId, state);
    } else {
      this.#inputState.pointerDownEntityId = null;
      this.#inputState.pointerDownWasSelected = false;
      this.#inputState.contextOpenEntityId = null;
      this.#entityDrag.clear();
      this.#selection.handleContextMenuEmpty();
    }
  }

  handleContextMenuClose(): void {
    // Reset context menu flag when menu closes (via button click or otherwise)
    this.#inputState.contextOpen = false;
    // Keep other input state intact - user may have clicked an action that modified
    // the entity (like send to front/back), and the entity should remain selected
    // and ready for immediate interaction
  }

  /** Get the current drag-select bounds for rendering (null if not active) */
  getDragSelectBounds(): Bounds | null {
    if (!this.#dragSelect?.isActive) return null;
    return this.#selection.computeDragSelectBounds(this.#dragSelect);
  }

  /** Get current drag-select mode */
  getDragSelectMode(): DragSelectMode | null {
    return this.#dragSelect?.mode ?? null;
  }

  /** Get bounding box of all selected entities (for multi-select visual) */
  getMultiSelectBounds(): Bounds | null {
    return this.#selection.getMultiSelectBounds(
      this.#dragSelect,
      this.#deps.actionLayer.isActive(),
      this.#deps.dragVisual,
    );
  }

  // MARK: Long-Press Entity Drag (Mobile)

  /** Cancel any pending double-tap delayed action timer */
  #cancelDoubleTapTimer(): void {
    if (this.#doubleTapTimerId !== null) {
      clearTimeout(this.#doubleTapTimerId);
      this.#doubleTapTimerId = null;
    }
  }

  /** Cancel any pending long-press timer. Releases drag visual with spring animation if active. */
  #cancelLongPressTimer(): void {
    const timerId = this.#touchState.longPressTimerId;
    if (timerId !== null) {
      clearTimeout(timerId);
      this.#touchState.longPressTimerId = null;
      // If the entity is visually scaled (possible-drag fired), spring back gracefully.
      // If the timer hadn't fired yet, release() is a no-op (phase is still idle).
      this.#deps.dragVisual.release();
    }
    this.#touchState.longPressEntityId = null;
  }

  /** Activate entity drag mode after long-press timer fires */
  #activateLongPressDrag(): void {
    this.#touchState.longPressTimerId = null;

    const entityId = this.#touchState.longPressEntityId;
    if (!entityId) return;

    // Only activate if still in single-finger state
    if (this.#touchState.touchCount !== 1) return;

    // Long-press drag takes priority over double-tap-hold zoom
    this.#doubleTapHoldZoom = {
      isCandidate: false,
      isZooming: false,
      anchorPoint: null,
      lastY: 0,
      rawZoom: 1,
    };

    // Stop panning — the viewport freezes
    this.#touchState.isPanning = false;

    this.#entityDrag.setTarget(this.#selection.selectForLongPress(entityId));

    // Set inputState for render loop
    this.#inputState.pointerDown = true;
    this.#inputState.pointerDownEntityId = entityId;

    // Pop-back visual: all selected entities spring to normal size
    const finalState = canvasStore.getState();
    this.#deps.dragVisual.activateDrag(finalState.selectedEntityIds);

    // Activate the action layer at the finger's position
    const touchPos = this.#inputState.pointerDownPosition ?? this.#touchState.lastTouchPosition;
    if (touchPos) {
      this.#deps.actionLayer.activate(touchPos, finalState.selectedEntityIds);
      canvasStore.setActionLayerActive(true, finalState.selectedEntityIds, touchPos);
      this.#touchState.isActionLayerActive = true;
      this.#deps.analytics.track("action_layer.opened", {
        entity_count: finalState.selectedEntityIds.size,
      });
      completeOnboardingStepFromEvent(OnboardingStepId.openActionLayer);
    }

    // Haptic feedback
    this.#deps.haptic({ wantsHaptic: canvasStore.getState().haptics });
  }

  // MARK: Touch Gesture Handlers (Mobile)

  #setLastTouchPosition(x: number, y: number): void {
    const lastTouchPosition = this.#touchState.lastTouchPosition;
    if (lastTouchPosition) {
      lastTouchPosition.x = x;
      lastTouchPosition.y = y;
      return;
    }

    this.#touchState.lastTouchPosition = { x, y };
  }

  /** Handle touch start - determines gesture type */
  handleTouchStart(touches: Point[], eventTime?: number): void {
    // Cancel any viewport animation when user starts interacting
    this.#viewport.cancelTouchInteraction();
    // Cancel any momentum scrolling
    this.#cancelPendingScrollMomentum();

    if (!this.#container) return;

    this.#touchState.touchCount = touches.length;

    if (touches.length === 1) {
      // Single finger - pan the viewport
      const touch = touches[0]!;
      this.#touchState.isPanning = true;
      this.#setLastTouchPosition(touch.x, touch.y);

      // Reset velocity trackers for momentum scrolling
      this.#velocityTrackerX.reset();
      this.#velocityTrackerY.reset();
      const now = eventTime ?? performance.now();
      this.#velocityTrackerX.addDataPoint(now, touch.x);
      this.#velocityTrackerY.addDataPoint(now, touch.y);

      // Record tap-detection state (don't select yet — wait for touchEnd to distinguish tap vs swipe)
      this.#inputState.pointerDownPosition = { x: touch.x, y: touch.y };

      const state = canvasStore.getState();
      const worldPoint = this.#viewport.screenToWorld({ x: touch.x, y: touch.y });

      const entityId = this.#selection.findEntityAtPoint(worldPoint, state);
      this.#inputState.pointerDownEntityId = entityId;
      this.#inputState.pointerDownWasSelected = entityId
        ? state.selectedEntityIds.has(entityId)
        : false;

      // Start long-press timer and possible-drag visual if finger landed on an entity
      if (entityId) {
        this.#touchState.longPressEntityId = entityId;
        this.#touchState.longPressTimerId = setTimeout(() => {
          this.#activateLongPressDrag();
        }, this.#touchConfig.longPressDelay);

        // If entity is already part of a multi-selection, scale all selected entities
        this.#deps.dragVisual.startPossibleDrag(this.#selection.getDragEntityIds(entityId));
      }

      // Check for double-tap-hold-zoom candidate (works on entities and empty space)
      if (this.#lastTapTime > 0) {
        const now = performance.now();
        const timeSinceLastTap = now - this.#lastTapTime;
        const distFromLastTap = this.#lastTapPosition
          ? Math.sqrt(
              (touch.x - this.#lastTapPosition.x) ** 2 + (touch.y - this.#lastTapPosition.y) ** 2,
            )
          : Infinity;

        if (timeSinceLastTap < this.#touchConfig.doubleTapWindow && distFromLastTap < 10) {
          this.#doubleTapHoldZoom.isCandidate = true;
          this.#doubleTapHoldZoom.anchorPoint = { x: touch.x, y: touch.y };
          // Cancel any pending delayed action from the first tap
          this.#cancelDoubleTapTimer();
        }
      }
    } else if (touches.length === 2) {
      // Two fingers - pinch to zoom or move entities
      const touch1 = touches[0]!;
      const touch2 = touches[1]!;

      // Cancel any pending long-press timer (keep isDraggingEntity if already active)
      this.#cancelLongPressTimer();

      // Cancel action layer if active (second finger cancels it)
      if (this.#touchState.isActionLayerActive) {
        this.#touchState.isActionLayerActive = false;
        this.#deps.actionLayer.cancel();
        this.#deps.dragVisual.cancel();
        canvasStore.setActionLayerActive(false);
      }

      // Cancel double-tap-hold zoom if a second finger appears
      if (this.#doubleTapHoldZoom.isCandidate || this.#doubleTapHoldZoom.isZooming) {
        this.#doubleTapHoldZoom = {
          isCandidate: false,
          isZooming: false,
          anchorPoint: null,
          lastY: 0,
          rawZoom: 1,
        };
      }

      this.#touchState.isPanning = false;
      this.#touchState.isPinching = true;
      this.#touchState.hadMultiTouch = true;
      this.#touchState.initialPinchDistance = this.#viewport.getTouchDistance(touch1, touch2);
      this.#touchState.initialZoom = canvasStore.getViewport().zoom;
      this.#touchState.pinchCenter = this.#viewport.getTouchCenter(touch1, touch2);
      this.#touchState.lastPinchCenter = this.#touchState.pinchCenter;

      // Seed zoom velocity tracker for momentum on pinch end
      this.#velocityTrackerZoom.reset();
      const now = eventTime ?? performance.now();
      this.#velocityTrackerZoom.addDataPoint(now, Math.log(this.#touchState.initialZoom));

      // Only move entities if already in long-press drag mode
      if (this.#touchState.isDraggingEntity) {
        this.#touchState.isMovingEntities = true;
      }
    }
  }

  /** Handle touch move - performs pan, zoom, or entity movement */
  handleTouchMove(touches: Point[], eventTime?: number): void {
    if (!this.#container) return;

    // Check for double-tap-hold zoom activation (before main chain)
    if (
      touches.length === 1 &&
      this.#doubleTapHoldZoom.isCandidate &&
      !this.#doubleTapHoldZoom.isZooming
    ) {
      const touch = touches[0]!;
      const anchor = this.#doubleTapHoldZoom.anchorPoint!;
      const dy = Math.abs(touch.y - anchor.y);

      if (dy > this.#touchConfig.doubleTapHoldZoom.activationThreshold) {
        // Activate zoom mode — stop panning
        this.#doubleTapHoldZoom.isZooming = true;
        this.#doubleTapHoldZoom.lastY = touch.y;
        this.#doubleTapHoldZoom.rawZoom = canvasStore.getViewport().zoom;
        this.#touchState.isPanning = false;

        // Cancel long-press timer (safety)
        this.#cancelLongPressTimer();

        // Clear last-tap state so a third tap doesn't chain
        this.#lastTapTime = 0;
        this.#lastTapEntityId = null;
        this.#lastTapPosition = null;

        // Seed zoom velocity tracker for momentum on release
        this.#velocityTrackerZoom.reset();
        const now = eventTime ?? performance.now();
        this.#velocityTrackerZoom.addDataPoint(now, Math.log(canvasStore.getViewport().zoom));
        // Manual zoom invalidates saved viewport for double-tap toggle
        this.#viewport.invalidateSavedViewport();
      }
    }

    if (touches.length === 1 && this.#doubleTapHoldZoom.isZooming) {
      // Double-tap-hold zoom: apply zoom based on vertical finger delta
      const touch = touches[0]!;
      const deltaY = touch.y - this.#doubleTapHoldZoom.lastY;
      this.#doubleTapHoldZoom.lastY = touch.y;

      const sensitivity = this.#touchConfig.doubleTapHoldZoom.sensitivity;
      const logDelta = -deltaY * sensitivity; // up = zoom in, down = zoom out

      // Update raw (unclamped) zoom, then apply rubber-band once for display
      // (same pattern as pinch: initialZoom * scale → rubberBandZoom)
      this.#doubleTapHoldZoom.rawZoom *= Math.exp(logDelta);
      const focalPoint = this.#doubleTapHoldZoom.anchorPoint!;
      this.#viewport.applyDoubleTapHoldZoom(this.#doubleTapHoldZoom.rawZoom, focalPoint);

      // Track zoom velocity for momentum on release
      const now = eventTime ?? performance.now();
      this.#velocityTrackerZoom.addDataPoint(now, Math.log(canvasStore.getViewport().zoom));
    } else if (touches.length === 1 && this.#touchState.isActionLayerActive) {
      // Action layer active: update finger position for rubber-banding
      const touch = touches[0]!;
      this.#deps.actionLayer.updateFingerPosition(touch);
      this.#setLastTouchPosition(touch.x, touch.y);

      // Check safe zone exit → transition to entity drag
      const touchOrigin = this.#deps.actionLayer.getTouchOrigin();
      const dx = touch.x - touchOrigin.x;
      const dy = touch.y - touchOrigin.y;
      const distFromOrigin = Math.sqrt(dx * dx + dy * dy);
      if (distFromOrigin > config.actionLayer.safeZoneRadius) {
        // Apply rubber-band offset to entity positions so drag continues
        // from the visual position (prevents jump back to origin)
        const cssOffset = this.#deps.actionLayer.getEntityOffset();
        const worldOffset = this.#viewport.screenDeltaToWorldDelta(cssOffset.x, cssOffset.y);

        this.#entityDrag.moveRaw(worldOffset.x, worldOffset.y);

        // Compute catch-up correction: finger's full travel minus rubber-band offset applied
        const totalMove = this.#viewport.screenDeltaToWorldDelta(
          touch.x - touchOrigin.x,
          touch.y - touchOrigin.y,
        );
        const totalMoveX = totalMove.x;
        const totalMoveY = totalMove.y;
        const catchUpX = totalMoveX - worldOffset.x;
        const catchUpY = totalMoveY - worldOffset.y;

        // Initialize catch-up spring (same spring feel as action layer)
        const { entitySpringResponse, entitySpringDamping } = config.actionLayer;
        this.#entityDrag.startCatchUp(
          { x: catchUpX, y: catchUpY },
          entitySpringResponse,
          entitySpringDamping,
        );
        // Save entity IDs so springs can continue after finger lift
        this.#entityDrag.startSpringTracking(canvasStore.getSelectedEntityIds());

        this.#deps.actionLayer.transitionToDrag();
        canvasStore.setActionLayerActive(false);
        canvasStore.setEntityDragActive(true);
        this.#touchState.isActionLayerActive = false;
        this.#touchState.isDraggingEntity = true;
        this.#touchState.isPanning = false;
      }
    } else if (touches.length === 1 && this.#touchState.isDraggingEntity) {
      // Long-press entity drag: move entity instead of panning
      const touch = touches[0]!;
      const lastPos = this.#touchState.lastTouchPosition;

      if (lastPos) {
        const moveDelta = this.#viewport.screenDeltaToWorldDelta(
          touch.x - lastPos.x,
          touch.y - lastPos.y,
        );
        if (this.#entityDrag.hasActiveSpring()) {
          if (this.#entityDrag.isSnapSettleActive()) {
            this.#entityDrag.cancelSnapSettleAndResetSnap();
          }
          this.#entityDrag.moveRaw(moveDelta.x, moveDelta.y);
        } else {
          this.#entityDrag.moveTarget(moveDelta);
        }
      }

      // Update position but skip velocity tracking (no momentum on entity drop)
      this.#setLastTouchPosition(touch.x, touch.y);
    } else if (touches.length === 1 && this.#touchState.isPanning) {
      // Single finger pan — manual viewport change invalidates double-tap zoom-back
      this.#viewport.invalidateSavedViewport();
      const touch = touches[0]!;
      const lastPos = this.#touchState.lastTouchPosition;

      // Cancel long-press timer if finger moved beyond threshold
      if (this.#touchState.longPressTimerId !== null) {
        const downPos = this.#inputState.pointerDownPosition;
        if (downPos) {
          const dx = touch.x - downPos.x;
          const dy = touch.y - downPos.y;
          if (Math.sqrt(dx * dx + dy * dy) > this.#touchConfig.longPressMoveThreshold) {
            this.#cancelLongPressTimer();
          }
        }
      }

      if (lastPos) {
        const deltaX = touch.x - lastPos.x;
        const deltaY = touch.y - lastPos.y;
        this.#viewport.panByScreenDelta(deltaX, deltaY);
      }

      // Track velocity for momentum scrolling
      const now = eventTime ?? performance.now();
      this.#velocityTrackerX.addDataPoint(now, touch.x);
      this.#velocityTrackerY.addDataPoint(now, touch.y);

      this.#setLastTouchPosition(touch.x, touch.y);
    } else if (touches.length === 2 && this.#touchState.isPinching) {
      // Pinch zoom — manual viewport change invalidates double-tap zoom-back
      this.#viewport.invalidateSavedViewport();
      const touch1 = touches[0]!;
      const touch2 = touches[1]!;

      // Calculate current pinch state
      const currentCenter = this.#viewport.getTouchCenter(touch1, touch2);

      // Handle zoom
      if (this.#touchState.initialPinchDistance && this.#touchState.initialZoom) {
        this.#viewport.applyPinchZoom(
          this.#touchState.initialPinchDistance,
          this.#touchState.initialZoom,
          touch1,
          touch2,
        );

        // Track zoom velocity in log-space for momentum on pinch end
        const currentZoom = canvasStore.getViewport().zoom;
        const now = eventTime ?? performance.now();
        this.#velocityTrackerZoom.addDataPoint(now, Math.log(currentZoom));
      }

      // Handle pan during pinch (move both fingers together)
      if (this.#touchState.lastPinchCenter) {
        const deltaX = currentCenter.x - this.#touchState.lastPinchCenter.x;
        const deltaY = currentCenter.y - this.#touchState.lastPinchCenter.y;

        // If we have selected entities and are moving them
        if (this.#touchState.isMovingEntities) {
          this.#entityDrag.moveSelected(this.#viewport.screenDeltaToWorldDelta(deltaX, deltaY));
        } else {
          this.#viewport.panByScreenDelta(deltaX, deltaY);
        }
      }

      this.#touchState.lastPinchCenter = currentCenter;
    }
  }

  /** Handle touch end - reset gesture state */
  handleTouchEnd(
    remainingTouches: { x: number; y: number }[],
    isCancelled: boolean = false,
    eventTime?: number,
  ): void {
    if (remainingTouches.length === 0) {
      if (this.#doubleTapHoldZoom.isZooming) {
        // Double-tap-hold zoom ended — trigger zoom momentum
        if (!isCancelled) {
          this.triggerZoomMomentum(this.#doubleTapHoldZoom.anchorPoint);
        }
        this.#doubleTapHoldZoom = {
          isCandidate: false,
          isZooming: false,
          anchorPoint: null,
          lastY: 0,
          rawZoom: 1,
        };
      } else if (this.#touchState.isActionLayerActive) {
        // Action layer finger lift — dismiss the controller (animates blur out + entity spring-back).
        // React may also call dismiss() on its touchend, but dismiss() is idempotent for idle phase.
        this.#touchState.isActionLayerActive = false;
        this.#deps.actionLayer.dismiss();
        canvasStore.setActionLayerActive(false);
        this.#deps.dragVisual.release();
      } else if (this.#touchState.isDraggingEntity) {
        // Entity drag complete — just drop it. No tap handling, no momentum.
        canvasStore.setEntityDragActive(false);
        this.#deps.dragVisual.release();
        // Catch-up and snap-settle springs continue after finger lift —
        // #springEntityIds preserves the target entities. The catch-up spring's
        // onComplete will start snap-settle if snap-to-grid is on.
      } else if (!isCancelled && this.#touchState.isPinching) {
        // Pinch ended (both fingers lifted) — trigger zoom momentum
        this.triggerZoomMomentum();
      } else if (!isCancelled && this.#touchState.isPanning && !this.#touchState.hadMultiTouch) {
        // Detect tap vs swipe: tap triggers selection/playback, swipe triggers momentum
        if (this.#detectTouchTap()) {
          this.#handleTouchTap();
        } else {
          const estimatedVelocity = {
            x: this.#velocityTrackerX.calculateLinearRegression(),
            y: this.#velocityTrackerY.calculateLinearRegression(),
          };
          const terminalVelocityX = this.#velocityTrackerX.calculateTerminalVelocity();
          const terminalVelocityY = this.#velocityTrackerY.calculateTerminalVelocity();
          const terminalVelocity =
            terminalVelocityX === null || terminalVelocityY === null
              ? estimatedVelocity
              : { x: terminalVelocityX, y: terminalVelocityY };
          const velocity = constrainReleaseVelocityToTerminalMotion(
            estimatedVelocity,
            terminalVelocity,
          );
          this.#triggerScrollMomentumAfterNextRender(velocity);
        }
      }
      // Cancel any pending long-press timer
      this.#cancelLongPressTimer();
      // Reset touch state (but keep momentum running)
      this.#resetTouchState();
    } else if (remainingTouches.length === 1) {
      // Went from two fingers to one — trigger zoom momentum BEFORE resetting state
      // (browsers fire sequential touchend events, so this is the real "pinch end")
      if (!isCancelled && this.#touchState.isPinching) {
        this.triggerZoomMomentum();
      }

      const touch = remainingTouches[0]!;
      this.#touchState.touchCount = 1;
      this.#touchState.isPinching = false;
      this.#touchState.isMovingEntities = false;
      this.#touchState.initialPinchDistance = null;
      this.#touchState.initialZoom = null;
      this.#touchState.pinchCenter = null;
      this.#touchState.lastPinchCenter = null;
      // Reset zoom velocity tracker — pinch data consumed by triggerZoomMomentum above
      this.#velocityTrackerZoom.reset();

      if (this.#touchState.isDraggingEntity) {
        // Resume entity drag with the remaining finger
        this.#touchState.isPanning = false;
        this.#setLastTouchPosition(touch.x, touch.y);
      } else {
        // Switch to panning
        this.#touchState.isPanning = true;
        this.#setLastTouchPosition(touch.x, touch.y);

        // Reset velocity trackers for the new single-finger pan
        this.#velocityTrackerX.reset();
        this.#velocityTrackerY.reset();
        const now = eventTime ?? performance.now();
        this.#velocityTrackerX.addDataPoint(now, touch.x);
        this.#velocityTrackerY.addDataPoint(now, touch.y);
      }

      // Reset tap-detection state for fresh single-finger context
      this.#inputState.pointerDownPosition = { x: touch.x, y: touch.y };
      this.#inputState.pointerDownEntityId = null;
      this.#inputState.pointerDownWasSelected = false;
    }
  }

  #triggerScrollMomentumAfterNextRender(velocity: Point): void {
    this.#cancelPendingScrollMomentum();

    this.#pendingScrollMomentumVelocity = { ...velocity };
  }

  #startPendingScrollMomentum(): void {
    const velocity = this.#pendingScrollMomentumVelocity;
    if (!velocity) return;

    this.#pendingScrollMomentumVelocity = null;

    this.#viewport.triggerScrollMomentum(velocity);
  }

  #cancelPendingScrollMomentum(): void {
    this.#pendingScrollMomentumVelocity = null;
  }

  /** Detect if the current touch gesture was a tap (not a swipe) */
  #detectTouchTap(): boolean {
    const downPos = this.#inputState.pointerDownPosition;
    const lastPos = this.#touchState.lastTouchPosition;
    if (!downPos || !lastPos) return false;

    const dx = lastPos.x - downPos.x;
    const dy = lastPos.y - downPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // 10px threshold (larger than pointer's 5px due to finger imprecision)
    const TOUCH_TAP_THRESHOLD = 10;
    return distance < TOUCH_TAP_THRESHOLD;
  }

  /** Handle a tap gesture — select/deselect entities, toggle playback, or double-tap zoom */
  #handleTouchTap(): void {
    if (!this.#container) return;

    // Cancel any pending delayed single-tap action (playback toggle from a previous tap)
    this.#cancelDoubleTapTimer();

    const tapPosition = this.#touchState.lastTouchPosition;
    if (!tapPosition) return;

    const state = canvasStore.getState();
    const worldPoint = this.#viewport.screenToWorld(tapPosition);

    const tappedEntityId = this.#selection.findEntityAtPoint(worldPoint, state);
    const downEntityId = this.#inputState.pointerDownEntityId;

    // Determine the effective entity (must match touch-down entity)
    const entityId = tappedEntityId && tappedEntityId === downEntityId ? tappedEntityId : null;

    // --- Double-tap detection ---
    const now = performance.now();
    const isDoubleTap =
      this.#lastTapTime > 0 &&
      now - this.#lastTapTime < this.#touchConfig.doubleTapWindow &&
      this.#lastTapPosition !== null &&
      Math.sqrt(
        (tapPosition.x - this.#lastTapPosition.x) ** 2 +
          (tapPosition.y - this.#lastTapPosition.y) ** 2,
      ) < 10 && // TOUCH_TAP_THRESHOLD
      entityId === this.#lastTapEntityId;

    if (isDoubleTap && !this.isInMultiSelectMode()) {
      // Clear last-tap state so a third tap starts fresh
      this.#lastTapTime = 0;
      this.#lastTapEntityId = null;
      this.#lastTapPosition = null;

      if (entityId) {
        // Double-tap on entity → zoom to fit (or toggle back)
        this.#viewport.handleDoubleTapOnEntity(entityId);
        return;
      }

      // Double-tap on empty space → fall through as single tap (clear selection)
      if (!tappedEntityId && !downEntityId) {
        canvasStore.clearSelection();
      }
      return;
    }

    // --- Record this tap for future double-tap detection ---
    this.#lastTapTime = now;
    this.#lastTapEntityId = entityId;
    this.#lastTapPosition = { ...tapPosition };

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
        if (this.#inputState.pointerDownWasSelected && canvasStore.getSelectionCount() > 1) {
          // Multi-selection active — collapse to just the tapped entity
          canvasStore.replaceSelection([entityId]);
        } else if (this.#inputState.pointerDownWasSelected) {
          // Entity was already selected (sole selection) — delay playback toggle to allow double-tap
          const capturedEntityId = entityId;
          this.#doubleTapTimerId = this.#selection.scheduleTouchPlaybackToggle(
            capturedEntityId,
            this.#touchConfig.doubleTapWindow,
            () => {
              this.#doubleTapTimerId = null;
            },
          );
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
  #resetTouchState(): void {
    this.#cancelLongPressTimer();
    // Clear drag state before resetting (guard: only notify store if drag was active)
    if (this.#touchState.isDraggingEntity) {
      canvasStore.setEntityDragActive(false);
    }
    // Clear action layer state
    if (this.#touchState.isActionLayerActive) {
      this.#touchState.isActionLayerActive = false;
      // Don't dismiss controller here — React may still be animating
    }
    // Note: do NOT cancel doubleTapTimer here — it must survive across taps
    // so the delayed playback toggle can fire after the double-tap window expires.
    this.#touchState = {
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
    this.#entityDrag.clear();
    // Let catch-up/snap-settle springs continue (they use #springEntityIds, not dragTarget)
    this.#entityDrag.clearSpringTrackingIfIdle();
    this.#doubleTapHoldZoom = {
      isCandidate: false,
      isZooming: false,
      anchorPoint: null,
      lastY: 0,
      rawZoom: 1,
    };
    this.#inputState.pointerDown = false;
    this.#inputState.pointerDownPosition = null;
    this.#inputState.pointerDownEntityId = null;
    this.#inputState.pointerDownWasSelected = false;
  }

  /** Check if a touch interaction is active */
  isTouchActive(): boolean {
    return this.#touchState.touchCount > 0;
  }

  isPointerDragging(): boolean {
    return this.#inputState.pointerDown && this.#entityDrag.target !== null;
  }

  isDragSelectActive(): boolean {
    return this.#dragSelect?.isActive === true;
  }

  flushPendingScrollMomentum(): void {
    this.#startPendingScrollMomentum();
  }
}
