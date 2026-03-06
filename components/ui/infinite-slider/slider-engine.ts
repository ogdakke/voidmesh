/**
 * SliderEngine — Framework-agnostic scroll physics for the InfiniteSlider.
 *
 * Manages scroll offset, pointer/wheel input, momentum (Scroller),
 * rubber-band (SpringBack), snap-to-grid, and external value sync.
 *
 * Reuses the touch-scroll library from app/lib/touch-scroll/.
 */

import {
  DecelerationRate,
  Scroller,
  SpringBack,
  VelocityTracker,
} from "#lib/touch-scroll/index.ts";

type AnimationPhase = "idle" | "momentum" | "spring" | "snap" | "seek";

export interface SliderEngineOptions {
  /** Value increment per tick. @default 1 */
  step?: number;
  /** Pixels between tick centers (visual only). @default 5 */
  tickSpacing?: number;
  /** Pixels of drag per step. Defaults to tickSpacing. */
  pixelsPerStep?: number;
  /** Lower bound (null = infinite). @default null */
  min?: number | null;
  /** Upper bound (null = infinite). @default null */
  max?: number | null;
  /** Starting value. @default 0 */
  initialValue?: number;

  /** Called every frame with the current offset (for rendering). */
  onFrame: (offset: number) => void;
  /** Called when the derived integer value changes (debounced by changeDelay). */
  onValueChange?: (value: number) => void;
  /** Called when scroll settles on a final value (debounced by commitDelay). */
  onValueCommit?: (value: number) => void;
  /** Called on first pointer down of a gesture. */
  onInteractionStart?: () => void;

  /** Debounce for onValueChange in ms. @default 0 */
  changeDelay?: number;
  /** Debounce for onValueCommit in ms. @default 150 */
  commitDelay?: number;
}

/** Rubber-band resistance factor when dragging past boundary. */
const RUBBER_BAND_FACTOR = 0.3;
/** Minimum velocity (px/ms) to trigger a fling. */
const FLING_VELOCITY_THRESHOLD = 0.05;
/** Duration of snap-to-grid animation in ms. */
const SNAP_DURATION = 120;
/** Duration of seek (external value sync) animation in ms. */
const SEEK_DURATION = 200;
/** Debounce delay before snapping after wheel input. */
const WHEEL_SNAP_DELAY = 100;
/** Maximum velocity allowed for fling (px/ms). Keeps scrolling visible. */
const MAX_FLING_VELOCITY = 4;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export class SliderEngine {
  // Configuration
  #step: number;
  #tickSpacing: number;
  #pixelsPerStep: number; // tickSpacing (one tick = one step in pixel space)
  #min: number | null;
  #max: number | null;
  #minOffset: number;
  #maxOffset: number;

  // Position state
  #offset: number;
  #lastEmittedValue: number;

  // Pointer tracking
  #pointerActive = false;
  #lastPointerX = 0;

  // Physics
  readonly #velocityTracker = new VelocityTracker();
  readonly #scroller = new Scroller(DecelerationRate.REASONABLE);
  readonly #springBack = new SpringBack();

  // Animation state
  #phase: AnimationPhase = "idle";
  #animStartTime = 0;
  #lastScrollerOffset = 0;
  #snapStartOffset = 0;
  #snapTarget = 0;
  #springBoundary = 0;
  #springOvershootSign = 0;
  #seekStartOffset = 0;
  #seekEndOffset = 0;
  #rafId: number | null = null;

  // Debounce
  #changeTimer: ReturnType<typeof setTimeout> | null = null;
  #commitTimer: ReturnType<typeof setTimeout> | null = null;
  #wheelSnapTimer: ReturnType<typeof setTimeout> | null = null;
  #changeDelay: number;
  #commitDelay: number;

  // Callbacks (stored as refs so they can be updated without re-creating engine)
  #onFrame: (offset: number) => void;
  #onValueChange: ((value: number) => void) | undefined;
  #onValueCommit: ((value: number) => void) | undefined;
  #onInteractionStart: (() => void) | undefined;
  #interactionStarted = false;

  constructor(options: SliderEngineOptions) {
    this.#step = options.step ?? 1;
    this.#tickSpacing = options.tickSpacing ?? 5;
    this.#pixelsPerStep = options.pixelsPerStep ?? this.#tickSpacing;
    this.#min = options.min ?? null;
    this.#max = options.max ?? null;
    this.#minOffset = this.#min !== null ? (this.#min / this.#step) * this.#pixelsPerStep : 0;
    this.#maxOffset = this.#max !== null ? (this.#max / this.#step) * this.#pixelsPerStep : 0;

    const initialValue = options.initialValue ?? 0;
    this.#offset = (initialValue / this.#step) * this.#pixelsPerStep;
    this.#lastEmittedValue = initialValue;

    this.#onFrame = options.onFrame;
    this.#onValueChange = options.onValueChange;
    this.#onValueCommit = options.onValueCommit;
    this.#onInteractionStart = options.onInteractionStart;
    this.#changeDelay = options.changeDelay ?? 0;
    this.#commitDelay = options.commitDelay ?? 150;
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Current derived value (snapped to step granularity, clamped to bounds). */
  getValue(): number {
    const ticks = Math.round(this.#offset / this.#pixelsPerStep);
    let value = ticks * this.#step;
    if (this.#min !== null && value < this.#min) value = this.#min;
    if (this.#max !== null && value > this.#max) value = this.#max;
    return value;
  }

  /** Current raw offset in CSS pixels. */
  getOffset(): number {
    return this.#offset;
  }

  /** Update callbacks without re-creating the engine. */
  setCallbacks(cbs: {
    onValueChange?: (value: number) => void;
    onValueCommit?: (value: number) => void;
    onInteractionStart?: () => void;
  }): void {
    this.#onValueChange = cbs.onValueChange;
    this.#onValueCommit = cbs.onValueCommit;
    this.#onInteractionStart = cbs.onInteractionStart;
  }

  /** Update bounds without full re-creation. */
  updateBounds(min: number | null, max: number | null): void {
    this.#min = min;
    this.#max = max;
    this.#minOffset = min !== null ? (min / this.#step) * this.#pixelsPerStep : 0;
    this.#maxOffset = max !== null ? (max / this.#step) * this.#pixelsPerStep : 0;
  }

  /**
   * Adjust value by the given number of steps. Used for keyboard input.
   * Follows the same pattern as wheel: instant offset change → debounced snap → commit.
   */
  stepBy(steps: number): void {
    this.#stopAnimation();
    // Cancel pending commit so rapid key presses stay in the same transaction
    if (this.#commitTimer !== null) {
      clearTimeout(this.#commitTimer);
      this.#commitTimer = null;
    }

    if (!this.#interactionStarted) {
      this.#interactionStarted = true;
      this.#onInteractionStart?.();
    }

    const delta = steps * this.#pixelsPerStep;
    let newOffset = this.#offset + delta;

    // Hard clamp in finite mode
    if (this.#isFinite()) {
      newOffset = Math.max(this.#minOffset, Math.min(this.#maxOffset, newOffset));
    }

    this.#offset = newOffset;
    this.#emitFrame();
    this.#emitValueChange();

    // Debounced snap (same pattern as wheel)
    if (this.#wheelSnapTimer !== null) {
      clearTimeout(this.#wheelSnapTimer);
    }
    this.#wheelSnapTimer = setTimeout(() => {
      this.#wheelSnapTimer = null;
      this.#startSnap();
    }, WHEEL_SNAP_DELAY);
  }

  /**
   * Directly drive the offset from an external source (e.g., autoplay).
   * Bypasses threshold and animation-phase checks for real-time updates.
   * Does NOT emit value changes (no undo pollution).
   */
  driveValue(value: number): void {
    if (this.#pointerActive) return;
    this.#stopAnimation();
    this.#offset = (value / this.#step) * this.#pixelsPerStep;
    this.#emitFrame();
  }

  /** Set value externally (e.g. from prop change). */
  setValue(value: number, animate = true): void {
    const targetOffset = (value / this.#step) * this.#pixelsPerStep;

    // Skip if already at target
    if (Math.abs(this.#offset - targetOffset) < 0.5) return;

    // Don't override user interaction or active animations (momentum, spring, snap)
    if (this.#pointerActive || this.#phase !== "idle") return;

    this.#stopAnimation();

    if (animate) {
      this.#seekStartOffset = this.#offset;
      this.#seekEndOffset = targetOffset;
      this.#phase = "seek";
      this.#animStartTime = performance.now();
      this.#startAnimationLoop();
    } else {
      this.#offset = targetOffset;
      this.#lastEmittedValue = value;
      this.#emitFrame();
    }
  }

  // ── Pointer Input ───────────────────────────────────────────────────

  handlePointerDown(clientX: number): void {
    this.#stopAnimation();
    // Cancel pending commit so a consecutive flick stays in the same transaction
    if (this.#commitTimer !== null) {
      clearTimeout(this.#commitTimer);
      this.#commitTimer = null;
    }
    this.#pointerActive = true;
    this.#lastPointerX = clientX;
    this.#velocityTracker.reset();
    this.#velocityTracker.addDataPoint(performance.now(), clientX);
  }

  handlePointerMove(clientX: number): void {
    if (!this.#pointerActive) return;

    if (!this.#interactionStarted) {
      this.#interactionStarted = true;
      this.#onInteractionStart?.();
    }

    const delta = clientX - this.#lastPointerX;
    this.#lastPointerX = clientX;
    this.#velocityTracker.addDataPoint(performance.now(), clientX);

    // Apply delta (dragging right = decreasing offset)
    let newOffset: number;

    if (this.#isFinite() && this.#getOvershoot() !== 0) {
      // Already past boundary — apply resistance to the incremental delta
      newOffset = this.#offset - delta * RUBBER_BAND_FACTOR;
    } else {
      newOffset = this.#offset - delta;

      // Check if this frame crosses a boundary
      if (this.#isFinite()) {
        const overshoot = this.#getOvershootForOffset(newOffset);
        if (overshoot !== 0) {
          const boundary = newOffset < this.#minOffset ? this.#minOffset : this.#maxOffset;
          const pastBoundary = newOffset - boundary;
          newOffset = boundary + pastBoundary * RUBBER_BAND_FACTOR;
        }
      }
    }

    this.#offset = newOffset;
    this.#emitFrame();
    this.#emitValueChange();
  }

  handlePointerUp(): void {
    if (!this.#pointerActive) return;
    this.#pointerActive = false;

    const vel = this.#velocityTracker.calculate();

    // Check if past boundary (finite mode)
    if (this.#isFinite()) {
      const overshoot = this.#getOvershoot();
      if (overshoot !== 0) {
        this.#springBoundary = this.#offset < this.#minOffset ? this.#minOffset : this.#maxOffset;
        this.#springOvershootSign = Math.sign(overshoot);
        this.#springBack.reset();
        this.#springBack.absorb(-vel, overshoot, 0.4);
        this.#phase = "spring";
        this.#animStartTime = performance.now();
        this.#startAnimationLoop();
        return;
      }
    }

    // Fling if velocity exceeds threshold
    if (Math.abs(vel) > FLING_VELOCITY_THRESHOLD) {
      const clampedVel = Math.sign(vel) * Math.min(Math.abs(vel), MAX_FLING_VELOCITY);
      this.#scroller.reset();
      this.#scroller.fling(clampedVel);
      this.#lastScrollerOffset = 0;
      this.#phase = "momentum";
      this.#animStartTime = performance.now();
      this.#startAnimationLoop();
    } else {
      // Low velocity — snap to nearest
      this.#startSnap();
    }
  }

  // ── Wheel Input ─────────────────────────────────────────────────────

  handleWheel(deltaX: number, deltaY: number): void {
    // If a snap animation was in progress, revert to pre-snap offset so the
    // partial snap doesn't pull the slider toward a tick during scrolling.
    if (this.#phase === "snap") {
      this.#offset = this.#snapStartOffset;
    }
    this.#stopAnimation();
    // Cancel pending commit so consecutive wheel input stays in the same transaction
    if (this.#commitTimer !== null) {
      clearTimeout(this.#commitTimer);
      this.#commitTimer = null;
    }

    if (!this.#interactionStarted) {
      this.#interactionStarted = true;
      this.#onInteractionStart?.();
    }

    // Use deltaX if nonzero, else deltaY (supports both horizontal scroll and vertical scroll gestures)
    const raw = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;

    // When pixelsPerStep < tickSpacing, raw wheel deltas are disproportionately
    // large relative to value steps. Scale down so wheel sensitivity matches
    // the slider's intended precision.
    const wheelScale = Math.min(1, this.#pixelsPerStep / this.#tickSpacing);
    const delta = raw * wheelScale;

    let newOffset = this.#offset + delta;

    // Hard clamp in finite mode (no rubber-band for wheel)
    if (this.#isFinite()) {
      newOffset = Math.max(this.#minOffset, Math.min(this.#maxOffset, newOffset));
    }

    this.#offset = newOffset;
    this.#emitFrame();
    this.#emitValueChange();

    // Debounced snap after wheel stops
    if (this.#wheelSnapTimer !== null) {
      clearTimeout(this.#wheelSnapTimer);
    }
    this.#wheelSnapTimer = setTimeout(() => {
      this.#wheelSnapTimer = null;
      this.#startSnap();
    }, WHEEL_SNAP_DELAY);
  }

  // ── Animation Loop ──────────────────────────────────────────────────

  /** For deterministic testing — bypasses rAF. */
  simulateTick(now: number): void {
    this.#tick(now);
  }

  #startAnimationLoop(): void {
    if (this.#rafId !== null) return;
    this.#rafId = requestAnimationFrame((now) => {
      this.#rafId = null;
      this.#tick(now);
      if (this.#phase !== "idle") {
        this.#startAnimationLoop();
      }
    });
  }

  #tick(now: number): void {
    const elapsed = now - this.#animStartTime;

    switch (this.#phase) {
      case "momentum": {
        const val = this.#scroller.value(elapsed);
        if (!val) {
          this.#startSnap();
          break;
        }
        const delta = val.offset - this.#lastScrollerOffset;
        this.#lastScrollerOffset = val.offset;
        // Scroller velocity was screen-space; negate for offset
        this.#offset -= delta;

        // Finite mode: check bounds
        if (this.#isFinite()) {
          const overshoot = this.#getOvershoot();
          if (overshoot !== 0) {
            this.#springBoundary =
              this.#offset < this.#minOffset ? this.#minOffset : this.#maxOffset;
            this.#springOvershootSign = Math.sign(overshoot);
            this.#springBack.reset();
            this.#springBack.absorb(-val.velocity, overshoot, 0.4);
            this.#phase = "spring";
            this.#animStartTime = now;
          }
        }
        break;
      }
      case "spring": {
        const val = this.#springBack.value(elapsed);
        if (!val) {
          // Spring settled, clamp and snap
          this.#offset = this.#clampOffset(this.#offset);
          this.#startSnap();
          break;
        }
        // If spring crosses the boundary (offset flips sign), settle immediately.
        // Prevents visible oscillation when momentum carries into the boundary fast.
        if (Math.sign(val.offset) !== 0 && Math.sign(val.offset) !== this.#springOvershootSign) {
          this.#offset = this.#springBoundary;
          this.#startSnap();
          break;
        }
        this.#offset = this.#springBoundary + val.offset;
        break;
      }
      case "snap": {
        const t = Math.min(1, elapsed / SNAP_DURATION);
        const eased = easeOutCubic(t);
        this.#offset = this.#snapStartOffset + (this.#snapTarget - this.#snapStartOffset) * eased;
        if (t >= 1) {
          this.#offset = this.#snapTarget;
          this.#phase = "idle";
          this.#emitCommit();
        }
        break;
      }
      case "seek": {
        const t = Math.min(1, elapsed / SEEK_DURATION);
        const eased = easeOutCubic(t);
        this.#offset =
          this.#seekStartOffset + (this.#seekEndOffset - this.#seekStartOffset) * eased;
        if (t >= 1) {
          this.#offset = this.#seekEndOffset;
          this.#lastEmittedValue = this.getValue();
          this.#phase = "idle";
        }
        break;
      }
    }

    this.#emitFrame();
    // Skip value emission during seek (programmatic value change) to avoid
    // intermediate values polluting the undo stack.
    if (this.#phase !== "seek") {
      this.#emitValueChange();
    }
  }

  #stopAnimation(): void {
    this.#phase = "idle";
    this.#scroller.reset();
    this.#springBack.reset();
    if (this.#rafId !== null) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = null;
    }
    if (this.#wheelSnapTimer !== null) {
      clearTimeout(this.#wheelSnapTimer);
      this.#wheelSnapTimer = null;
    }
  }

  #startSnap(): void {
    const nearest = Math.round(this.#offset / this.#pixelsPerStep) * this.#pixelsPerStep;

    if (Math.abs(this.#offset - nearest) < 0.5) {
      this.#offset = nearest;
      this.#phase = "idle";
      this.#emitFrame();
      this.#emitCommit();
      return;
    }

    this.#snapStartOffset = this.#offset;
    this.#snapTarget = nearest;
    this.#phase = "snap";
    this.#animStartTime = performance.now();
    this.#startAnimationLoop();
  }

  // ── Boundary Helpers ────────────────────────────────────────────────

  #isFinite(): boolean {
    return this.#min !== null && this.#max !== null;
  }

  #getOvershoot(): number {
    return this.#getOvershootForOffset(this.#offset);
  }

  #getOvershootForOffset(offset: number): number {
    if (!this.#isFinite()) return 0;
    if (offset < this.#minOffset) return offset - this.#minOffset;
    if (offset > this.#maxOffset) return offset - this.#maxOffset;
    return 0;
  }

  #clampOffset(offset: number): number {
    if (!this.#isFinite()) return offset;
    return Math.max(this.#minOffset, Math.min(this.#maxOffset, offset));
  }

  // ── Value Emission ──────────────────────────────────────────────────

  #emitFrame(): void {
    this.#onFrame(this.#offset);
  }

  #emitValueChange(): void {
    const value = this.getValue();
    if (value === this.#lastEmittedValue) return;
    this.#lastEmittedValue = value;

    if (this.#changeDelay <= 0) {
      this.#onValueChange?.(value);
      return;
    }

    if (this.#changeTimer !== null) clearTimeout(this.#changeTimer);
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = null;
      this.#onValueChange?.(value);
    }, this.#changeDelay);
  }

  #emitCommit(): void {
    const value = this.getValue();
    this.#interactionStarted = false;

    if (this.#commitDelay <= 0) {
      this.#onValueCommit?.(value);
      return;
    }

    if (this.#commitTimer !== null) clearTimeout(this.#commitTimer);
    this.#commitTimer = setTimeout(() => {
      this.#commitTimer = null;
      this.#onValueCommit?.(value);
    }, this.#commitDelay);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────

  destroy(): void {
    this.#stopAnimation();
    if (this.#changeTimer !== null) clearTimeout(this.#changeTimer);
    if (this.#commitTimer !== null) clearTimeout(this.#commitTimer);
  }
}
