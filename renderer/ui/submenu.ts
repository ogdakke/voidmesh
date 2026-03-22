// ---------------------------------------------------------------------------
// Submenu Controller
// ---------------------------------------------------------------------------
//
// Manages open/close timing and safety-polygon hit testing for nested
// submenu panels in the canvas UI system.
//
// Safety polygon algorithm is based on base-ui's safePolygon approach:
// a quadrilateral from cursor to the near edge of the submenu, plus a
// "trough" check for direct horizontal movement between trigger and panel.
//

import type { SceneNode } from "./scene-node.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubmenuRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SubmenuPosition {
  x: number;
  y: number;
  side: "left" | "right";
}

interface Point {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Point-in-quadrilateral test via cross-product winding.
 * Vertices must be in order (CW or CCW — we check for consistent sign).
 */
function isPointInQuadrilateral(
  px: number,
  py: number,
  v0: Point,
  v1: Point,
  v2: Point,
  v3: Point,
): boolean {
  const vertices = [v0, v1, v2, v3];
  let positive = 0;
  let negative = 0;

  for (let i = 0; i < 4; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % 4]!;
    const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);

    if (cross > 0) positive++;
    else if (cross < 0) negative++;

    // If we have both positive and negative, point is outside
    if (positive > 0 && negative > 0) return false;
  }

  return true;
}

/**
 * Check if point is inside an axis-aligned rectangle (the "trough"
 * between trigger and submenu for direct horizontal movement).
 */
function isPointInTrough(
  px: number,
  py: number,
  triggerRect: SubmenuRect,
  submenuRect: SubmenuRect,
): boolean {
  // Horizontal extent: from trigger right edge to submenu left edge (or vice versa)
  const leftEdge = Math.min(triggerRect.x + triggerRect.width, submenuRect.x);
  const rightEdge = Math.max(triggerRect.x + triggerRect.width, submenuRect.x);

  // Use trigger vertical bounds for trough height (more conservative)
  const troughTop = triggerRect.y;
  const troughBottom = triggerRect.y + triggerRect.height;

  return px >= leftEdge && px <= rightEdge && py >= troughTop && py <= troughBottom;
}

// ---------------------------------------------------------------------------
// SubmenuController
// ---------------------------------------------------------------------------

const OPEN_DELAY_MS = 100;
const CURSOR_BUFFER = 0.5;
const SLOW_SPEED_THRESHOLD = 0.1; // px/ms

export class SubmenuController {
  #activeTrigger: SceneNode | null = null;
  #submenuPosition: SubmenuPosition | null = null;
  #submenuDimensions: { width: number; height: number } | null = null;
  #triggerRect: SubmenuRect | null = null;

  #openTimer: ReturnType<typeof setTimeout> | null = null;

  #isOpen = false;

  // Callback fired when submenu state changes — consumer should re-render
  onChange: (() => void) | null = null;

  get isOpen(): boolean {
    return this.#isOpen;
  }

  get activeTrigger(): SceneNode | null {
    return this.#activeTrigger;
  }

  get submenuPosition(): SubmenuPosition | null {
    return this.#submenuPosition;
  }

  /**
   * Check if the submenu is currently open for a specific trigger node.
   */
  isOpenFor(triggerNode: SceneNode): boolean {
    return this.#isOpen && this.#activeTrigger === triggerNode;
  }

  /**
   * Open a submenu for the given trigger node.
   * Computes position based on trigger layout rect and available viewport space.
   */
  open(
    triggerNode: SceneNode,
    submenuDimensions: { width: number; height: number },
    viewportRect: SubmenuRect,
  ): void {
    this.#clearOpenTimer();

    const alreadyOpen = this.#isOpen;

    // If a submenu is already open, switch immediately (no delay)
    if (alreadyOpen && this.#activeTrigger !== triggerNode) {
      this.#doOpen(triggerNode, submenuDimensions, viewportRect);
      return;
    }

    // If already open for this trigger, do nothing
    if (this.isOpenFor(triggerNode)) return;

    // Schedule open with delay
    this.#openTimer = setTimeout(() => {
      this.#openTimer = null;
      this.#doOpen(triggerNode, submenuDimensions, viewportRect);
    }, OPEN_DELAY_MS);
  }

  #doOpen(
    triggerNode: SceneNode,
    submenuDimensions: { width: number; height: number },
    viewportRect: SubmenuRect,
  ): void {
    this.#activeTrigger = triggerNode;
    this.#submenuDimensions = submenuDimensions;

    // Get trigger layout rect
    const layout = triggerNode.layout;
    this.#triggerRect = {
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height,
    };

    // Compute submenu position: prefer right side, fall back to left
    const rightX = layout.x + layout.width;
    const leftX = layout.x - submenuDimensions.width;

    const fitsRight = rightX + submenuDimensions.width <= viewportRect.x + viewportRect.width;
    const fitsLeft = leftX >= viewportRect.x;

    let side: "left" | "right";
    let x: number;
    if (fitsRight) {
      side = "right";
      x = rightX;
    } else if (fitsLeft) {
      side = "left";
      x = leftX;
    } else {
      // Default to right even if it overflows
      side = "right";
      x = rightX;
    }

    // Vertical alignment: align top of submenu with top of trigger
    let y = layout.y;
    // Clamp to viewport bottom
    const bottomOverflow = y + submenuDimensions.height - (viewportRect.y + viewportRect.height);
    if (bottomOverflow > 0) {
      y -= bottomOverflow;
    }
    // Clamp to viewport top
    if (y < viewportRect.y) {
      y = viewportRect.y;
    }

    this.#submenuPosition = { x, y, side };
    this.#isOpen = true;
    this.onChange?.();
  }

  /**
   * Close the currently open submenu.
   */
  close(): void {
    this.#clearOpenTimer();

    if (!this.#isOpen) return;

    this.#activeTrigger = null;
    this.#submenuPosition = null;
    this.#submenuDimensions = null;
    this.#triggerRect = null;
    this.#isOpen = false;
    this.onChange?.();
  }

  /**
   * Handle pointer movement. Returns true if the cursor is in the safe zone
   * (i.e., the submenu should stay open).
   */
  handlePointerMove(worldX: number, worldY: number, cursorSpeed: number): boolean {
    if (!this.#isOpen || !this.#submenuPosition || !this.#submenuDimensions || !this.#triggerRect) {
      return false;
    }

    // If cursor speed is very slow, it's likely the user stopped moving
    // toward the submenu — consider closing
    if (cursorSpeed < SLOW_SPEED_THRESHOLD && cursorSpeed > 0) {
      return false;
    }

    const submenuRect: SubmenuRect = {
      x: this.#submenuPosition.x,
      y: this.#submenuPosition.y,
      width: this.#submenuDimensions.width,
      height: this.#submenuDimensions.height,
    };

    // Check if cursor is inside the submenu itself
    if (
      worldX >= submenuRect.x &&
      worldX <= submenuRect.x + submenuRect.width &&
      worldY >= submenuRect.y &&
      worldY <= submenuRect.y + submenuRect.height
    ) {
      return true;
    }

    // Check if cursor is inside the trigger
    if (
      worldX >= this.#triggerRect.x &&
      worldX <= this.#triggerRect.x + this.#triggerRect.width &&
      worldY >= this.#triggerRect.y &&
      worldY <= this.#triggerRect.y + this.#triggerRect.height
    ) {
      return true;
    }

    // Check trough (direct horizontal path between trigger and submenu)
    if (isPointInTrough(worldX, worldY, this.#triggerRect, submenuRect)) {
      return true;
    }

    // Build safety quadrilateral from cursor to near edge of submenu
    const nearEdgeX =
      this.#submenuPosition.side === "right" ? submenuRect.x : submenuRect.x + submenuRect.width;

    // Two points at cursor position (with small buffer to create a wedge)
    const cursorTop: Point = { x: worldX, y: worldY - CURSOR_BUFFER };
    const cursorBottom: Point = { x: worldX, y: worldY + CURSOR_BUFFER };

    // Two points at the near edge of the submenu
    const submenuTop: Point = { x: nearEdgeX, y: submenuRect.y };
    const submenuBottom: Point = { x: nearEdgeX, y: submenuRect.y + submenuRect.height };

    // The quad is: cursorTop → submenuTop → submenuBottom → cursorBottom
    return isPointInQuadrilateral(
      worldX,
      worldY,
      cursorTop,
      submenuTop,
      submenuBottom,
      cursorBottom,
    );
  }

  /**
   * Cancel any pending open timer.
   */
  #clearOpenTimer(): void {
    if (this.#openTimer !== null) {
      clearTimeout(this.#openTimer);
      this.#openTimer = null;
    }
  }

  /**
   * Clean up timers.
   */
  destroy(): void {
    this.#clearOpenTimer();
    this.#isOpen = false;
    this.#activeTrigger = null;
    this.#submenuPosition = null;
    this.#submenuDimensions = null;
    this.#triggerRect = null;
    this.onChange = null;
  }
}
