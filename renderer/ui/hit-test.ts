// ---------------------------------------------------------------------------
// Hit Testing
// ---------------------------------------------------------------------------
//
// Point-in-rect queries against the retained scene graph.
// Traverses depth-first in reverse child order (front-most first).
// Only returns nodes that have event handlers (interactive nodes).
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

  // Point must be inside this node's bounds to check children
  const inside = worldX >= x && worldX <= x + width && worldY >= y && worldY <= y + height;
  if (!inside) return null;

  // Check children in reverse order (last rendered = front-most)
  for (let i = root.children.length - 1; i >= 0; i--) {
    const hit = hitTest(root.children[i]!, worldX, worldY);
    if (hit) return hit;
  }

  // No child hit — check if this node is interactive
  if (isInteractive(root)) return root;

  return null;
}
