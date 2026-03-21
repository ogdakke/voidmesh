// ---------------------------------------------------------------------------
// Retained Scene Graph Node
// ---------------------------------------------------------------------------
//
// SceneNodes persist across frames. They are created/updated/removed by the
// reconciler and decorated with layout positions by the layout engine.
// Each node owns its animation state.
//

import type { MotionConfig, SpringConfig, TweenConfig } from "./elements.ts";

// ---------------------------------------------------------------------------
// Property tween (owned by SceneNode)
// ---------------------------------------------------------------------------

export interface PropertyTween {
  type: "tween" | "spring";
  from: number;
  to: number;
  current: number;
  startTime: number;
  delay: number;
  done: boolean;
  duration?: number;
  easing?: (t: number) => number;
  response?: number;
  startVelocity?: number; // units/ms
  velocity?: number; // units/ms
}

interface SpringSample {
  current: number;
  velocity: number; // units/ms
  done: boolean;
}

function sampleSpring(
  from: number,
  to: number,
  startVelocity: number,
  response: number,
  elapsedMs: number,
): SpringSample {
  const clampedResponse = Math.max(0.001, response);
  const lambda = (2 * Math.PI) / clampedResponse;
  const t = elapsedMs / 1000;
  const distance = from - to;
  const c1 = distance;
  const c2 = startVelocity * 1000 + lambda * distance;
  const expTerm = Math.exp(-lambda * t);
  const offset = (c1 + c2 * t) * expTerm;
  const velocityPerSecond = (c2 - lambda * (c1 + c2 * t)) * expTerm;
  const velocity = velocityPerSecond / 1000;
  const current = to + offset;

  const valueThreshold = Math.max(0.0001, Math.abs(distance) * 0.01);
  const velocityThreshold = Math.max(0.0001, Math.abs(distance) * 0.01);

  return {
    current,
    velocity,
    done: Math.abs(offset) < valueThreshold && Math.abs(velocity) < velocityThreshold,
  };
}

// ---------------------------------------------------------------------------
// Layout rect (computed by layout engine)
// ---------------------------------------------------------------------------

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// SceneNode
// ---------------------------------------------------------------------------

export type NodePhase = "entering" | "active" | "exiting";

export class SceneNode {
  type: string;
  key: string | number | null;
  props: Record<string, unknown>;
  children: SceneNode[] = [];
  parent: SceneNode | null = null;

  // Layout
  layout: LayoutRect = { x: 0, y: 0, width: 0, height: 0 };

  // Text measurement cache (invalidated when content/fontSize change)
  textCache: {
    content: string;
    fontSize: number;
    slugData: unknown;
    totalWidth: number;
    ascender: number;
    descender: number;
    measuredWidth: number;
    measuredHeight: number;
  } | null = null;

  // Interaction
  isHovered = false;
  isActive = false;

  // Drag state (for draggable elements)
  dragOffset: { x: number; y: number } = { x: 0, y: 0 };

  // Animation
  tweens: Map<string, PropertyTween> = new Map();
  phase: NodePhase = "entering";

  constructor(type: string, key: string | number | null, props: Record<string, unknown>) {
    this.type = type;
    this.key = key;
    this.props = props;
  }

  // ---------------------------------------------------------------------------
  // Animation
  // ---------------------------------------------------------------------------

  /**
   * Resolve an animated property value. If the target changed, starts a new
   * tween from the current value. Returns the interpolated value.
   */
  resolveAnimatedValue(
    property: string,
    target: number,
    config: MotionConfig,
    now: number,
  ): number {
    const existing = this.tweens.get(property);
    const isSpring = config.type === "spring";

    // No existing tween — snap to target
    if (!existing) {
      this.tweens.set(property, {
        type: isSpring ? "spring" : "tween",
        from: target,
        to: target,
        current: target,
        startTime: now,
        delay: config.delay ?? 0,
        done: true,
        duration: isSpring ? undefined : (config as TweenConfig).duration,
        easing: isSpring ? undefined : (config as TweenConfig).easing,
        response: isSpring ? ((config as SpringConfig).response ?? 0.32) : undefined,
        startVelocity: 0,
        velocity: 0,
      });
      return target;
    }

    const configChanged =
      (existing.type === "spring") !== isSpring ||
      (existing.type === "tween" &&
        !isSpring &&
        (existing.duration !== (config as TweenConfig).duration ||
          existing.easing !== (config as TweenConfig).easing)) ||
      (existing.type === "spring" &&
        isSpring &&
        existing.response !== ((config as SpringConfig).response ?? 0.32));

    // Target changed — start a new motion from the current value
    if (existing.to !== target || configChanged) {
      existing.from = existing.current;
      existing.to = target;
      existing.startTime = now;
      existing.delay = config.delay ?? 0;
      existing.done = false;

      if (isSpring) {
        existing.type = "spring";
        existing.response = config.response ?? 0.32;
        existing.startVelocity = existing.velocity ?? 0;
        existing.duration = undefined;
        existing.easing = undefined;
      } else {
        existing.type = "tween";
        existing.duration = config.duration;
        existing.easing = config.easing;
        existing.response = undefined;
        existing.startVelocity = 0;
      }
    }

    if (existing.done) return target;

    const elapsed = now - existing.startTime - existing.delay;
    if (elapsed < 0) return existing.current; // Still in delay

    if (existing.type === "spring") {
      const value = sampleSpring(
        existing.from,
        existing.to,
        existing.startVelocity ?? 0,
        existing.response ?? 0.32,
        elapsed,
      );
      if (value.done) {
        existing.current = existing.to;
        existing.velocity = 0;
        existing.done = true;
        return existing.current;
      }

      existing.current = value.current;
      existing.velocity = value.velocity;
      return existing.current;
    }

    const duration = existing.duration ?? 0;
    const easing = existing.easing ?? ((t: number) => t);
    const rawProgress = duration > 0 ? elapsed / duration : 1;
    const progress = Math.max(0, Math.min(1, rawProgress));
    const easedT = easing(progress);
    existing.current = existing.from + (existing.to - existing.from) * easedT;

    if (progress >= 1) {
      existing.current = existing.to;
      existing.velocity = 0;
      existing.done = true;
    }

    return existing.current;
  }

  /** Returns true if any tweens are still active (not done). */
  get hasActiveTweens(): boolean {
    for (const tween of this.tweens.values()) {
      if (!tween.done) return true;
    }
    return false;
  }

  /** Begin exit phase. The node stays in the tree until exit animation completes. */
  beginExit(): void {
    this.phase = "exiting";
    // If no tweens are active, the node can be pruned immediately
  }

  /** Returns true if this node is exiting and all its exit animations are done. */
  get canPrune(): boolean {
    return this.phase === "exiting" && !this.hasActiveTweens;
  }
}

// ---------------------------------------------------------------------------
// Tree traversal helpers
// ---------------------------------------------------------------------------

/** Walk the tree depth-first, calling fn on each node. */
export function walkSceneTree(root: SceneNode, fn: (node: SceneNode) => void): void {
  fn(root);
  for (const child of root.children) {
    walkSceneTree(child, fn);
  }
}

/** Returns true if any node in the subtree has active tweens. */
export function hasActiveAnimations(root: SceneNode): boolean {
  if (root.hasActiveTweens) return true;
  for (const child of root.children) {
    if (hasActiveAnimations(child)) return true;
  }
  return false;
}
