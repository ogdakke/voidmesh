// ---------------------------------------------------------------------------
// Hit Testing
// ---------------------------------------------------------------------------
//
// Point-in-rect queries against the retained scene graph.
// Traverses depth-first in reverse child order (front-most first).
// Only returns nodes that have event handlers (interactive nodes).
//
// Fixed-position children are checked regardless of parent bounds.
// Nodes with overflow "hidden" or "scroll" clip child hit-testing to their bounds.
//

import type { SceneNode } from "./scene-node.ts";

const EVENT_PROPS = [
  "onClick",
  "onPointerDown",
  "onPointerUp",
  "onDrag",
  "onHoverEnter",
  "onHoverLeave",
] as const;

function isInteractive(node: SceneNode): boolean {
  for (const prop of EVENT_PROPS) {
    if (node.props[prop]) return true;
  }
  return (
    node.props["hover"] != null || node.props["active"] != null || node.props["draggable"] === true
  );
}

function pointInBounds(x: number, y: number, node: SceneNode): boolean {
  const { x: nx, y: ny, width, height } = node.layout;
  return x >= nx && x <= nx + width && y >= ny && y <= ny + height;
}

/**
 * Find the deepest interactive node at (worldX, worldY).
 * Returns null if no interactive node contains the point.
 */
export function hitTest(root: SceneNode, worldX: number, worldY: number): SceneNode | null {
  if (root.phase === "exiting") return null;

  // Check fixed children FIRST — they're positioned by viewport, not parent bounds.
  // This must happen before the zero-size bail-out below, because a parent with only
  // fixed children has zero flow size but its fixed children are still hittable.
  for (let i = root.children.length - 1; i >= 0; i--) {
    const child = root.children[i]!;
    if (child.props["position"] === "fixed") {
      const hit = hitTest(child, worldX, worldY);
      if (hit) return hit;
    }
  }

  const { x, y, width, height } = root.layout;
  if (width <= 0 || height <= 0) return null;

  const overflow = root.props["overflow"] as string | undefined;
  const clips = overflow === "hidden" || overflow === "scroll";

  // For clipping containers, skip non-fixed children if point is outside bounds
  if (clips && !pointInBounds(worldX, worldY, root)) {
    return null;
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

/**
 * Find the frontmost node with overflow "scroll" that contains the given point.
 * Used for wheel event targeting.
 */
export function findScrollableNode(
  root: SceneNode,
  worldX: number,
  worldY: number,
): SceneNode | null {
  if (root.phase === "exiting") return null;

  const { width, height } = root.layout;
  if (width <= 0 || height <= 0) return null;

  // Recurse into children (front-most first) to find deepest scrollable
  for (let i = root.children.length - 1; i >= 0; i--) {
    const found = findScrollableNode(root.children[i]!, worldX, worldY);
    if (found) return found;
  }

  // Check if this node is a scroll container containing the point
  if (root.props["overflow"] === "scroll" && pointInBounds(worldX, worldY, root)) {
    return root;
  }

  return null;
}
