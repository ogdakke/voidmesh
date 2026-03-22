// ---------------------------------------------------------------------------
// Submenu Controller
// ---------------------------------------------------------------------------
//
// Manages open/close timing and safe-polygon hit testing for nested submenu
// panels in the canvas UI system.
//
// The polygon logic is modeled after Base UI's safePolygon implementation,
// but it runs against the canvas UI scene graph using the actual laid-out
// trigger and submenu rects.
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

export interface Point {
  x: number;
  y: number;
}

export interface SubmenuDebugState {
  fixedOrigin: Point | null;
  triggerRect: SubmenuRect | null;
  submenuRect: SubmenuRect | null;
  troughRect: SubmenuRect | null;
  exitPoint: Point | null;
  polygon: Point[];
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function isPointInQuadrilateral(
  pointX: number,
  pointY: number,
  a: Point,
  b: Point,
  c: Point,
  d: Point,
): boolean {
  const vertices = [a, b, c, d];
  let isInside = false;

  for (let i = 0; i < 4; i++) {
    const current = vertices[i]!;
    const next = vertices[(i + 1) % 4]!;
    const intersects =
      current.y >= pointY !== next.y >= pointY &&
      pointX <= ((next.x - current.x) * (pointY - current.y)) / (next.y - current.y) + current.x;

    if (intersects) {
      isInside = !isInside;
    }
  }

  return isInside;
}

function isInsideRect(pointX: number, pointY: number, rect: SubmenuRect): boolean {
  return (
    pointX >= rect.x &&
    pointX <= rect.x + rect.width &&
    pointY >= rect.y &&
    pointY <= rect.y + rect.height
  );
}

function isInsideAxisAlignedRect(
  pointX: number,
  pointY: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  return pointX >= minX && pointX <= maxX && pointY >= minY && pointY <= maxY;
}

function rectFromPoints(x1: number, y1: number, x2: number, y2: number): SubmenuRect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function getFixedAncestorOrigin(node: SceneNode): Point {
  let cursor: SceneNode | null = node;
  let fixedAncestor: SceneNode | null = null;

  while (cursor) {
    if (cursor.props["position"] === "fixed") {
      fixedAncestor = cursor;
    }
    cursor = cursor.parent;
  }

  return fixedAncestor ? { x: fixedAncestor.layout.x, y: fixedAncestor.layout.y } : { x: 0, y: 0 };
}

// ---------------------------------------------------------------------------
// SubmenuController
// ---------------------------------------------------------------------------

const OPEN_DELAY_MS = 100;
const POLYGON_BUFFER = 0.5;
const CURSOR_SPEED_THRESHOLD = 0.1; // px/ms
const CURSOR_SPEED_THRESHOLD_SQUARED = CURSOR_SPEED_THRESHOLD * CURSOR_SPEED_THRESHOLD;

export class SubmenuController {
  #activeTrigger: SceneNode | null = null;
  #triggerRect: SubmenuRect | null = null;
  #submenuRect: SubmenuRect | null = null;
  #fixedOrigin: Point | null = null;

  #openTimer: ReturnType<typeof setTimeout> | null = null;

  #isOpen = false;
  #hasLanded = false;
  #exitPoint: Point | null = null;
  #lastPointer: Point | null = null;
  #lastPointerTime = 0;
  #debugTroughRect: SubmenuRect | null = null;
  #debugPolygon: Point[] = [];

  onChange: (() => void) | null = null;

  get isOpen(): boolean {
    return this.#isOpen;
  }

  get activeTrigger(): SceneNode | null {
    return this.#activeTrigger;
  }

  get submenuPosition(): SubmenuPosition | null {
    if (!this.#submenuRect || !this.#triggerRect) return null;

    const triggerCenterX = this.#triggerRect.x + this.#triggerRect.width / 2;
    const submenuCenterX = this.#submenuRect.x + this.#submenuRect.width / 2;

    return {
      x: this.#submenuRect.x,
      y: this.#submenuRect.y,
      side: submenuCenterX >= triggerCenterX ? "right" : "left",
    };
  }

  getDebugState(screenScale: number): SubmenuDebugState {
    const origin = this.#fixedOrigin;
    const s = screenScale || 1;

    const toRelativeRect = (rect: SubmenuRect | null): SubmenuRect | null => {
      if (!rect || !origin) return rect;
      return {
        x: (rect.x - origin.x) / s,
        y: (rect.y - origin.y) / s,
        width: rect.width / s,
        height: rect.height / s,
      };
    };

    const toRelativePoint = (point: Point | null): Point | null => {
      if (!point || !origin) return point;
      return { x: (point.x - origin.x) / s, y: (point.y - origin.y) / s };
    };

    return {
      fixedOrigin: origin,
      triggerRect: toRelativeRect(this.#triggerRect),
      submenuRect: toRelativeRect(this.#submenuRect),
      troughRect: toRelativeRect(this.#debugTroughRect),
      exitPoint: toRelativePoint(this.#exitPoint),
      polygon: origin
        ? this.#debugPolygon.map((point) => ({
            x: (point.x - origin.x) / s,
            y: (point.y - origin.y) / s,
          }))
        : this.#debugPolygon,
    };
  }

  isOpenFor(triggerNode: SceneNode): boolean {
    return this.#isOpen && this.#activeTrigger === triggerNode;
  }

  open(triggerNode: SceneNode): void {
    this.#clearOpenTimer();

    if (this.#isOpen && this.#activeTrigger !== triggerNode) {
      this.#doOpen(triggerNode);
      return;
    }

    if (this.isOpenFor(triggerNode)) return;

    this.#openTimer = setTimeout(() => {
      this.#openTimer = null;
      this.#doOpen(triggerNode);
    }, OPEN_DELAY_MS);
  }

  #doOpen(triggerNode: SceneNode): void {
    this.#activeTrigger = triggerNode;
    this.#fixedOrigin = getFixedAncestorOrigin(triggerNode);
    this.#triggerRect = {
      x: triggerNode.layout.x,
      y: triggerNode.layout.y,
      width: triggerNode.layout.width,
      height: triggerNode.layout.height,
    };
    this.#submenuRect = null;
    this.#isOpen = true;
    this.#hasLanded = false;
    this.#exitPoint = null;
    this.#lastPointer = null;
    this.#lastPointerTime = 0;
    this.#debugTroughRect = null;
    this.#debugPolygon = [];
    this.onChange?.();
  }

  syncSubmenuNode(node: SceneNode): void {
    if (!this.#isOpen) return;

    this.#fixedOrigin = getFixedAncestorOrigin(node);
    this.#submenuRect = {
      x: node.layout.x,
      y: node.layout.y,
      width: node.layout.width,
      height: node.layout.height,
    };
  }

  close(): void {
    this.#clearOpenTimer();

    if (!this.#isOpen) return;

    this.#activeTrigger = null;
    this.#triggerRect = null;
    this.#submenuRect = null;
    this.#fixedOrigin = null;
    this.#isOpen = false;
    this.#hasLanded = false;
    this.#exitPoint = null;
    this.#lastPointer = null;
    this.#lastPointerTime = 0;
    this.#debugTroughRect = null;
    this.#debugPolygon = [];
    this.onChange?.();
  }

  handlePointerMove(worldX: number, worldY: number, cursorSpeed: number): boolean {
    if (!this.#isOpen || !this.#triggerRect) {
      return false;
    }

    const submenuRect = this.#submenuRect;
    if (!submenuRect) {
      return true;
    }

    const submenuPosition = this.submenuPosition;
    if (!submenuPosition) {
      return true;
    }

    const previousPointer = this.#lastPointer;
    const previousTime = this.#lastPointerTime;
    this.#lastPointer = { x: worldX, y: worldY };
    this.#lastPointerTime = performance.now();

    // Always update debug geometry for the overlay visualization
    this.#updateDebugGeometry(worldX, worldY, submenuRect, submenuPosition);

    if (isInsideRect(worldX, worldY, submenuRect)) {
      this.#hasLanded = true;
      return true;
    }

    if (isInsideRect(worldX, worldY, this.#triggerRect)) {
      this.#hasLanded = false;
      this.#exitPoint = null;
      return true;
    }

    if (this.#hasLanded) {
      return false;
    }

    if (this.#exitPoint == null) {
      if (
        previousPointer &&
        isInsideRect(previousPointer.x, previousPointer.y, this.#triggerRect)
      ) {
        this.#exitPoint = previousPointer;
      } else if (previousPointer) {
        this.#exitPoint = previousPointer;
      } else {
        this.#exitPoint = { x: worldX, y: worldY };
      }
    }

    const exitPoint = this.#exitPoint;
    if (!exitPoint) return false;

    if (
      (submenuPosition.side === "right" && exitPoint.x <= this.#triggerRect.x + 1) ||
      (submenuPosition.side === "left" &&
        exitPoint.x >= this.#triggerRect.x + this.#triggerRect.width - 1)
    ) {
      return false;
    }

    const isFloatingTaller = submenuRect.height > this.#triggerRect.height;
    const top = (isFloatingTaller ? this.#triggerRect : submenuRect).y;
    const bottom =
      (isFloatingTaller ? this.#triggerRect : submenuRect).y +
      (isFloatingTaller ? this.#triggerRect.height : submenuRect.height);

    const troughRect =
      submenuPosition.side === "right"
        ? rectFromPoints(
            this.#triggerRect.x + this.#triggerRect.width - 1,
            bottom,
            submenuRect.x + 1,
            top,
          )
        : rectFromPoints(
            submenuRect.x + submenuRect.width - 1,
            bottom,
            this.#triggerRect.x + 1,
            top,
          );

    if (
      isInsideAxisAlignedRect(
        worldX,
        worldY,
        troughRect.x,
        troughRect.y,
        troughRect.x + troughRect.width,
        troughRect.y + troughRect.height,
      )
    ) {
      return true;
    }

    if (cursorSpeed > 0 && cursorSpeed < CURSOR_SPEED_THRESHOLD) {
      return false;
    }

    if (previousPointer && previousTime > 0) {
      const elapsed = this.#lastPointerTime - previousTime;
      if (elapsed > 0) {
        const deltaX = worldX - previousPointer.x;
        const deltaY = worldY - previousPointer.y;
        const distanceSquared = deltaX * deltaX + deltaY * deltaY;
        const thresholdSquared = elapsed * elapsed * CURSOR_SPEED_THRESHOLD_SQUARED;
        if (distanceSquared < thresholdSquared) {
          return false;
        }
      }
    }

    const polygon = this.#buildPolygon(exitPoint, submenuRect, submenuPosition);
    return isPointInQuadrilateral(
      worldX,
      worldY,
      polygon[0]!,
      polygon[1]!,
      polygon[2]!,
      polygon[3]!,
    );
  }

  /** Build the 4-point safe-zone polygon from an exit point to the submenu. */
  #buildPolygon(
    exitPoint: Point,
    submenuRect: SubmenuRect,
    submenuPosition: SubmenuPosition,
  ): Point[] {
    const triggerRect = this.#triggerRect!;
    const isFloatingTaller = submenuRect.height > triggerRect.height;
    const cursorLeaveFromBottom = exitPoint.y > triggerRect.y + triggerRect.height / 2;
    const cursorYOffset = isFloatingTaller ? POLYGON_BUFFER / 2 : POLYGON_BUFFER * 4;

    if (submenuPosition.side === "right") {
      const cursorPointOneY = isFloatingTaller
        ? exitPoint.y + cursorYOffset
        : cursorLeaveFromBottom
          ? exitPoint.y + cursorYOffset
          : exitPoint.y - cursorYOffset;
      const cursorPointTwoY = isFloatingTaller
        ? exitPoint.y - cursorYOffset
        : cursorLeaveFromBottom
          ? exitPoint.y + cursorYOffset
          : exitPoint.y - cursorYOffset;
      const cursorPointX = exitPoint.x - POLYGON_BUFFER;
      const commonXTop = cursorLeaveFromBottom
        ? submenuRect.x + POLYGON_BUFFER
        : isFloatingTaller
          ? submenuRect.x + POLYGON_BUFFER
          : submenuRect.x + submenuRect.width;
      const commonXBottom = cursorLeaveFromBottom
        ? isFloatingTaller
          ? submenuRect.x + POLYGON_BUFFER
          : submenuRect.x + submenuRect.width
        : submenuRect.x + POLYGON_BUFFER;

      return [
        { x: cursorPointX, y: cursorPointOneY },
        { x: cursorPointX, y: cursorPointTwoY },
        { x: commonXTop, y: submenuRect.y },
        { x: commonXBottom, y: submenuRect.y + submenuRect.height },
      ];
    }

    const cursorPointOneY = isFloatingTaller
      ? exitPoint.y + cursorYOffset
      : cursorLeaveFromBottom
        ? exitPoint.y + cursorYOffset
        : exitPoint.y - cursorYOffset;
    const cursorPointTwoY = isFloatingTaller
      ? exitPoint.y - cursorYOffset
      : cursorLeaveFromBottom
        ? exitPoint.y + cursorYOffset
        : exitPoint.y - cursorYOffset;
    const cursorPointX = exitPoint.x + POLYGON_BUFFER + 1;
    const commonXTop = cursorLeaveFromBottom
      ? submenuRect.x + submenuRect.width - POLYGON_BUFFER
      : isFloatingTaller
        ? submenuRect.x + submenuRect.width - POLYGON_BUFFER
        : submenuRect.x;
    const commonXBottom = cursorLeaveFromBottom
      ? isFloatingTaller
        ? submenuRect.x + submenuRect.width - POLYGON_BUFFER
        : submenuRect.x
      : submenuRect.x + submenuRect.width - POLYGON_BUFFER;

    return [
      { x: commonXTop, y: submenuRect.y },
      { x: commonXBottom, y: submenuRect.y + submenuRect.height },
      { x: cursorPointX, y: cursorPointOneY },
      { x: cursorPointX, y: cursorPointTwoY },
    ];
  }

  /** Always compute debug geometry so the overlay tracks the cursor in real time. */
  #updateDebugGeometry(
    worldX: number,
    worldY: number,
    submenuRect: SubmenuRect,
    submenuPosition: SubmenuPosition,
  ): void {
    const triggerRect = this.#triggerRect!;
    const isFloatingTaller = submenuRect.height > triggerRect.height;
    const top = (isFloatingTaller ? triggerRect : submenuRect).y;
    const bottom =
      (isFloatingTaller ? triggerRect : submenuRect).y +
      (isFloatingTaller ? triggerRect.height : submenuRect.height);

    this.#debugTroughRect =
      submenuPosition.side === "right"
        ? rectFromPoints(triggerRect.x + triggerRect.width - 1, bottom, submenuRect.x + 1, top)
        : rectFromPoints(submenuRect.x + submenuRect.width - 1, bottom, triggerRect.x + 1, top);

    // Use actual exit point if available, otherwise use cursor position
    // so the polygon is always visible and follows the cursor
    const refPoint = this.#exitPoint ?? { x: worldX, y: worldY };
    this.#debugPolygon = this.#buildPolygon(refPoint, submenuRect, submenuPosition);
  }

  #clearOpenTimer(): void {
    if (this.#openTimer !== null) {
      clearTimeout(this.#openTimer);
      this.#openTimer = null;
    }
  }

  destroy(): void {
    this.#clearOpenTimer();
    this.#isOpen = false;
    this.#activeTrigger = null;
    this.#triggerRect = null;
    this.#submenuRect = null;
    this.#fixedOrigin = null;
    this.#hasLanded = false;
    this.#exitPoint = null;
    this.#lastPointer = null;
    this.#lastPointerTime = 0;
    this.#debugTroughRect = null;
    this.#debugPolygon = [];
    this.onChange = null;
  }
}
