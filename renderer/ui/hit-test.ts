// ---------------------------------------------------------------------------
// Hit Testing
// ---------------------------------------------------------------------------
//
// Point-in-rect queries against the retained scene graph.
// Traverses depth-first in reverse child order (front-most first).
// Only returns nodes that have event handlers (interactive nodes).
//
// Fixed-position children are checked regardless of parent bounds.
// Other children are also allowed to overflow parent bounds because the
// canvas UI system does not currently implement clipping.
//

import type { SceneNode } from "./scene-node.ts";

const EVENT_PROPS = ["onClick", "onPointerDown", "onPointerUp", "onDrag"] as const;

function isInteractive(node: SceneNode): boolean {
  for (const prop of EVENT_PROPS) {
    if (node.props[prop]) return true;
  }
  return (
    node.props["hover"] != null || node.props["active"] != null || node.props["draggable"] === true
  );
}

/**
 * Find the deepest interactive node at (worldX, worldY).
 * Returns null if no interactive node contains the point.
 */
export function hitTest(root: SceneNode, worldX: number, worldY: number): SceneNode | null {
  if (root.phase === "exiting") return null;

  const { x, y, width, height } = root.layout;
  if (width <= 0 || height <= 0) return null;

  // Check fixed children first — they're positioned by viewport, not parent bounds
  for (let i = root.children.length - 1; i >= 0; i--) {
    const child = root.children[i]!;
    if (child.props["position"] === "fixed") {
      const hit = hitTest(child, worldX, worldY);
      if (hit) return hit;
    }
  }

  for (let i = root.children.length - 1; i >= 0; i--) {
    const child = root.children[i]!;
    if (child.props["position"] !== "fixed") {
      const hit = hitTest(child, worldX, worldY);
      if (hit) return hit;
    }
  }

  // No child hit — check if this node is interactive
  const inside = worldX >= x && worldX <= x + width && worldY >= y && worldY <= y + height;
  if (inside && isInteractive(root)) return root;

  return null;
}
