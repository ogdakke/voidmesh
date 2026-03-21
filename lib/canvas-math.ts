import type { Point, Viewport, Bounds } from "#types/canvas.ts";
import { config } from "./config/index.ts";

/**
 * Convert screen coordinates to world coordinates
 * @param dpr Device pixel ratio - needed because canvas is sized in device pixels
 */
export function screenToWorld(
  screenPoint: Point,
  viewport: Viewport,
  containerRect: DOMRect,
  dpr: number = 1,
): Point {
  return {
    x: ((screenPoint.x - containerRect.left) * dpr) / viewport.zoom + viewport.offset.x,
    y: ((screenPoint.y - containerRect.top) * dpr) / viewport.zoom + viewport.offset.y,
  };
}

/**
 * Convert world coordinates to screen coordinates
 * @param dpr Device pixel ratio - needed because canvas is sized in device pixels
 */
export function worldToScreen(
  worldPoint: Point,
  viewport: Viewport,
  containerRect: DOMRect,
  dpr: number = 1,
): Point {
  return {
    x: ((worldPoint.x - viewport.offset.x) * viewport.zoom) / dpr + containerRect.left,
    y: ((worldPoint.y - viewport.offset.y) * viewport.zoom) / dpr + containerRect.top,
  };
}

/**
 * Calculate new viewport to zoom towards a point (zoom-to-cursor)
 * This is the key formula for natural-feeling zoom behavior.
 *
 * @param viewport Current viewport state
 * @param cursorPos Cursor position relative to container (not screen coords)
 * @param newZoom Target zoom level
 */
export function zoomToPoint(viewport: Viewport, cursorPos: Point, newZoom: number): Viewport {
  // The world point under the cursor before zoom
  const worldX = cursorPos.x / viewport.zoom + viewport.offset.x;
  const worldY = cursorPos.y / viewport.zoom + viewport.offset.y;

  // Calculate new offset so the world point stays under the cursor after zoom
  const newOffset: Point = {
    x: worldX - cursorPos.x / newZoom,
    y: worldY - cursorPos.y / newZoom,
  };

  return {
    offset: newOffset,
    zoom: newZoom,
  };
}

/**
 * Clamp zoom to reasonable bounds
 */
export function clampZoom(
  zoom: number,
  min = config.canvas.minZoom,
  max = config.canvas.maxZoom,
): number {
  return Math.max(min, Math.min(max, zoom));
}

/**
 * iOS-style rubber-band damping for a positive offset past a boundary.
 *
 * @param offset How far past the boundary (must be >= 0)
 * @param range  Scale factor controlling max stretch (larger = more stretch)
 * @returns Damped offset that asymptotically approaches `range`
 */
const RUBBER_BAND_COEFFICIENT = 0.55;

function rubberBandOffset(offset: number, range: number): number {
  if (offset <= 0 || range <= 0) return 0;
  return (1 - 1 / ((offset / range) * RUBBER_BAND_COEFFICIENT + 1)) * range;
}

/**
 * Apply rubber-band damping to zoom beyond min/max bounds.
 * Works in log-space so the stretch feels perceptually uniform.
 * Returns the zoom unchanged if within bounds.
 */
export function rubberBandZoom(
  zoom: number,
  min = config.canvas.minZoom,
  max = config.canvas.maxZoom,
): number {
  if (zoom >= min && zoom <= max) return zoom;

  const logRange = Math.log(max) - Math.log(min);

  if (zoom > max) {
    const overshoot = Math.log(zoom) - Math.log(max);
    const damped = rubberBandOffset(overshoot, logRange);
    return Math.exp(Math.log(max) + damped);
  }

  // zoom < min
  const overshoot = Math.log(min) - Math.log(zoom);
  const damped = rubberBandOffset(overshoot, logRange);
  return Math.exp(Math.log(min) - damped);
}

/**
 * Check if a point is inside bounds
 */
export function pointInBounds(point: Point, bounds: Bounds): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

/**
 * Check if two bounds intersect (for drag-to-select)
 */
export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

/**
 * Create bounds from position and size
 */
export function createBounds(position: Point, size: { width: number; height: number }): Bounds {
  return {
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
  };
}

/**
 * Get the world-space AABB of the visible viewport area, expanded by a buffer margin.
 * Used for viewport culling — entities outside this bounds can skip GPU rendering.
 *
 * @param viewport Current viewport state
 * @param canvasWidth Canvas width in device pixels (already DPR-scaled)
 * @param canvasHeight Canvas height in device pixels (already DPR-scaled)
 * @param bufferFraction Margin as fraction of viewport size
 */
export function getViewportWorldBounds(
  viewport: Viewport,
  canvasWidth: number,
  canvasHeight: number,
  bufferFraction: number,
): Bounds {
  const viewportWidth = canvasWidth / viewport.zoom;
  const viewportHeight = canvasHeight / viewport.zoom;
  const margin = Math.max(viewportWidth, viewportHeight) * bufferFraction;

  return {
    x: viewport.offset.x - margin,
    y: viewport.offset.y - margin,
    width: viewportWidth + 2 * margin,
    height: viewportHeight + 2 * margin,
  };
}

/**
 * Get the axis-aligned bounding box of a potentially rotated entity.
 * For 0° rotation (common case), returns bounds directly without trig.
 *
 * @param position Entity top-left position in world coordinates
 * @param size Entity dimensions
 * @param rotationDeg Rotation in degrees
 */
export function getRotatedAABB(
  position: Point,
  size: { width: number; height: number },
  rotationDeg: number,
): Bounds {
  if (rotationDeg === 0) {
    return createBounds(position, size);
  }

  const cx = position.x + size.width / 2;
  const cy = position.y + size.height / 2;
  const hw = size.width / 2;
  const hh = size.height / 2;

  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));

  // Rotated half-extents
  const rotatedHW = hw * cos + hh * sin;
  const rotatedHH = hw * sin + hh * cos;

  return {
    x: cx - rotatedHW,
    y: cy - rotatedHH,
    width: rotatedHW * 2,
    height: rotatedHH * 2,
  };
}

/**
 * Get the 3x3 viewport transformation matrix for GPU use
 * This matrix transforms world coordinates to clip space [-1, 1]
 *
 * The matrix performs:
 * 1. Translate by -offset (move world origin)
 * 2. Scale by zoom
 * 3. Scale and translate to clip space
 */
export function getViewportMatrix(
  viewport: Viewport,
  canvasWidth: number,
  canvasHeight: number,
): Float32Array {
  const { offset, zoom } = viewport;

  // Scale factors to convert from pixels to clip space
  const scaleX = (2 * zoom) / canvasWidth;
  const scaleY = (-2 * zoom) / canvasHeight; // Flip Y for WebGPU

  // Translation including offset and centering
  const translateX = -offset.x * scaleX - 1;
  const translateY = -offset.y * scaleY + 1;

  // Column-major 3x3 matrix (padded to 3x4 for WebGPU alignment)
  // [scaleX,  0,       0, 0]
  // [0,       scaleY,  0, 0]
  // [transX,  transY,  1, 0]
  return new Float32Array([scaleX, 0, 0, 0, 0, scaleY, 0, 0, translateX, translateY, 1, 0]);
}

/**
 * Get the center point of the viewport in world coordinates
 * @param dpr Device pixel ratio - needed because canvas is sized in device pixels
 */
export function getViewportCenter(
  viewport: Viewport,
  containerRect: DOMRect,
  dpr: number = 1,
): Point {
  const screenCenter = {
    x: containerRect.left + containerRect.width / 2,
    y: containerRect.top + containerRect.height / 2,
  };

  return screenToWorld(screenCenter, viewport, containerRect, dpr);
}

/**
 * Calculate viewport offset to center world origin (0,0) at viewport center.
 * Use this for initial viewport setup and "center canvas" functionality.
 *
 * @param containerWidth Container width in CSS pixels
 * @param containerHeight Container height in CSS pixels
 * @param zoom Current zoom level
 * @param dpr Device pixel ratio - needed because canvas is sized in device pixels
 */
export function calculateCenteredOffset(
  containerWidth: number,
  containerHeight: number,
  zoom: number,
  dpr: number = 1,
): Point {
  return {
    x: -(containerWidth * dpr) / (2 * zoom),
    y: -(containerHeight * dpr) / (2 * zoom),
  };
}

/**
 * Calculate viewport offset to center a specific world point at viewport center.
 *
 * @param worldPoint The world coordinate to center on
 * @param containerWidth Container width in CSS pixels
 * @param containerHeight Container height in CSS pixels
 * @param zoom Current zoom level
 * @param dpr Device pixel ratio
 */
export function calculateOffsetForWorldPoint(
  worldPoint: Point,
  containerWidth: number,
  containerHeight: number,
  zoom: number,
  dpr: number = 1,
): Point {
  const screenCenterX = (containerWidth * dpr) / 2;
  const screenCenterY = (containerHeight * dpr) / 2;

  return {
    x: worldPoint.x - screenCenterX / zoom,
    y: worldPoint.y - screenCenterY / zoom,
  };
}

/**
 * Calculate viewport state to fit an entity in view with padding.
 * Zooms to fit the entity while maintaining aspect ratio and respecting zoom limits.
 *
 * @param entityPosition Entity top-left position in world coordinates
 * @param entitySize Entity size in world pixels
 * @param containerWidth Container width in CSS pixels
 * @param containerHeight Container height in CSS pixels
 * @param dpr Device pixel ratio
 * @param padding Padding as a fraction (0.1 = 10% padding on each side)
 * @param minZoom Minimum allowed zoom level
 * @param maxZoom Maximum allowed zoom level
 */
export function calculateFitToView({
  entityPosition,
  entitySize,
  containerWidth,
  containerHeight,
  dpr = 1,
  padding = 0.1,
  minZoom = config.canvas.minZoom,
  maxZoom = config.canvas.maxZoom,
  bottomInset = 0,
}: {
  entityPosition: Point;
  entitySize: { width: number; height: number };
  containerWidth: number;
  containerHeight: number;
  dpr?: number;
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
  bottomInset?: number;
}): { offset: Point; zoom: number } {
  // Calculate entity center in world coordinates
  const entityCenter: Point = {
    x: entityPosition.x + entitySize.width / 2,
    y: entityPosition.y + entitySize.height / 2,
  };

  // Effective height accounts for occluded bottom area (e.g. mobile controls)
  const effectiveHeight = containerHeight - bottomInset;

  // Available screen space with padding (in device pixels)
  const availableWidth = containerWidth * dpr * (1 - padding * 2);
  const availableHeight = effectiveHeight * dpr * (1 - padding * 2);

  // Calculate zoom to fit width and height
  const zoomToFitWidth = availableWidth / entitySize.width;
  const zoomToFitHeight = availableHeight / entitySize.height;

  // Use the smaller zoom to ensure entity fits in both dimensions
  let zoom = Math.min(zoomToFitWidth, zoomToFitHeight);

  // Clamp to zoom limits
  zoom = clampZoom(zoom, minZoom, maxZoom);

  // Calculate offset to center the entity in the visible area (above bottom inset)
  const offset = calculateOffsetForWorldPoint(
    entityCenter,
    containerWidth,
    effectiveHeight,
    zoom,
    dpr,
  );

  return { offset, zoom };
}

// ============================================================================
// Grid Level Calculation (shared by dot-grid shader and snap-to-grid)
// ============================================================================

/** Subdivision factor for multi-level grid (must be odd for alignment) */
export const GRID_SUBDIVISIONS = 5;
const LOG_SUBDIVISIONS = Math.log(GRID_SUBDIVISIONS);

/**
 * Calculate the fine grid size and crossfade factor for the current zoom level.
 *
 * Uses base-N logarithmic scaling (N = GRID_SUBDIVISIONS) to create smooth
 * transitions between grid levels. At each level, minor dots (fineGridSize spacing)
 * fade in/out while major dots (fineGridSize * N spacing) stay visible.
 *
 * @param baseGridSize - Base grid spacing in world units (e.g., 100)
 * @param zoom - Current zoom level
 * @returns fineGridSize and fadeFactor (0 = minor invisible, 1 = minor fully visible)
 */
export function calculateGridLevel(
  baseGridSize: number,
  zoom: number,
): { fineGridSize: number; fadeFactor: number } {
  const continuousLevel = Math.log(zoom) / LOG_SUBDIVISIONS;
  const discreteLevel = Math.floor(continuousLevel);
  const fadeFactor = continuousLevel - discreteLevel;

  const fineGridSize = baseGridSize * Math.pow(GRID_SUBDIVISIONS, -discreteLevel);

  // Sharp ease-in (x^5): dots stay invisible most of the range, snap in near transition
  const f2 = fadeFactor * fadeFactor;
  const easedFade = f2 * f2 * fadeFactor;

  return { fineGridSize, fadeFactor: easedFade };
}

/** Major grid size used for snap-to-grid (base grid × subdivisions) */
export const SNAP_GRID_SIZE = config.rendering.grid.default.gridSize * GRID_SUBDIVISIONS;

/**
 * Snap a point to the nearest grid intersection.
 * @param position World-space position to snap
 * @param gridSize Grid spacing in world units
 * @returns Snapped position
 */
export function snapToGrid(position: Point, gridSize: number): Point {
  return {
    x: Math.round(position.x / gridSize) * gridSize,
    y: Math.round(position.y / gridSize) * gridSize,
  };
}

// ============================================================================
// Lerp (Linear Interpolation) Utilities
// ============================================================================

/**
 * Linear interpolation between two numbers.
 * @param start Starting value
 * @param end Target value
 * @param t Progress (0-1, clamped)
 */
export function lerp(start: number, end: number, t: number): number {
  const clampedT = Math.max(0, Math.min(1, t));
  return start + (end - start) * clampedT;
}

/**
 * Exponential interpolation between two numbers.
 * Useful for zoom which is perceptually logarithmic.
 * Each unit of t represents the same multiplicative factor.
 * @param start Starting value (must be > 0)
 * @param end Target value (must be > 0)
 * @param t Progress (0-1, clamped)
 */
export function lerpExp(start: number, end: number, t: number): number {
  const clampedT = Math.max(0, Math.min(1, t));
  return start * Math.pow(end / start, clampedT);
}

/**
 * Linear interpolation between two points.
 */
export function lerpPoint(start: Point, end: Point, t: number): Point {
  return {
    x: lerp(start.x, end.x, t),
    y: lerp(start.y, end.y, t),
  };
}

/**
 * Linear interpolation between two viewports.
 */
export function lerpViewport(start: Viewport, end: Viewport, t: number): Viewport {
  return {
    offset: lerpPoint(start.offset, end.offset, t),
    zoom: lerp(start.zoom, end.zoom, t),
  };
}

// ============================================================================
// Easing Functions
// ============================================================================

/** Easing function signature: maps t (0-1) to eased t (0-1) */
export type EasingFunction = (t: number) => number;

/** Collection of common easing functions */
export const easings = {
  /** Linear (no easing) */
  linear: (t: number): number => t,

  /** Ease in-out quadratic (smooth start and end) */
  easeInOut: (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),

  /** Ease out cubic (decelerating) */
  easeOutCubic: (t: number): number => 1 - Math.pow(1 - t, 3),

  /** Ease out quart (stronger deceleration) */
  easeOutQuart: (t: number): number => 1 - Math.pow(1 - t, 4),

  /** Ease out expo (exponential deceleration) */
  easeOutExpo: (t: number): number => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),

  /** Ease out with overshoot (back easing) */
  easeOutBack: (t: number): number => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
} as const;
