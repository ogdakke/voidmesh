// ---------------------------------------------------------------------------
// Retained Scene Graph Node
// ---------------------------------------------------------------------------
//
// SceneNodes persist across frames. They are created/updated/removed by the
// reconciler and decorated with layout positions by the layout engine.
// Each node owns its animation state.
//

import type { TweenConfig } from "./elements.ts";

// ---------------------------------------------------------------------------
// Property tween (owned by SceneNode)
// ---------------------------------------------------------------------------

export interface PropertyTween {
  from: number;
  to: number;
  current: number;
  startTime: number;
  duration: number;
  delay: number;
  easing: (t: number) => number;
  done: boolean;
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
  layoutDirty = true;

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
  resolveAnimatedValue(property: string, target: number, config: TweenConfig, now: number): number {
    const existing = this.tweens.get(property);

    // No existing tween — snap to target
    if (!existing) {
      this.tweens.set(property, {
        from: target,
        to: target,
        current: target,
        startTime: now,
        duration: config.duration,
        delay: config.delay ?? 0,
        easing: config.easing,
        done: true,
      });
      return target;
    }

    // Target changed — start new tween from current value
    if (existing.to !== target) {
      existing.from = existing.current;
      existing.to = target;
      existing.startTime = now;
      existing.duration = config.duration;
      existing.delay = config.delay ?? 0;
      existing.easing = config.easing;
      existing.done = false;
    }

    if (existing.done) return target;

    // Interpolate
    const elapsed = now - existing.startTime - existing.delay;
    if (elapsed < 0) return existing.current; // Still in delay

    const rawProgress = existing.duration > 0 ? elapsed / existing.duration : 1;
    const progress = Math.max(0, Math.min(1, rawProgress));
    const easedT = existing.easing(progress);
    existing.current = existing.from + (existing.to - existing.from) * easedT;

    if (progress >= 1) {
      existing.current = existing.to;
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

  /** Mark layout as dirty up to the root. */
  markLayoutDirty(): void {
    let node: SceneNode | null = this;
    while (node && !node.layoutDirty) {
      node.layoutDirty = true;
      node = node.parent;
    }
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
