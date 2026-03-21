// ---------------------------------------------------------------------------
// Canvas UI Layout Engine
// ---------------------------------------------------------------------------
//
// Two-pass flexbox-like layout operating on the retained SceneNode tree.
//
// Pass 1 (measure): Bottom-up, computes intrinsic width/height for each node.
// Pass 2 (position): Top-down, assigns x/y positions and distributes space.
//
// Scale parameter: When rendering screen-space UI (default), all size values
// are multiplied by `scale = dpr / zoom` so elements maintain constant screen
// size regardless of canvas zoom level. Authors write in CSS-like pixel values.
//

import type {
  UIEdges,
  UIColor,
  UIBackground,
  AnimateConfig,
  TweenConfig,
  StateStyle,
} from "./elements.ts";
import type { SceneNode } from "./scene-node.ts";

// ---------------------------------------------------------------------------
// Text measurement interface (decouples layout from GPU text rendering)
// ---------------------------------------------------------------------------

export interface TextMeasurer {
  measureText(content: string, fontSize: number): TextMetrics;
}

export interface TextMetrics {
  width: number;
  height: number;
  ascender: number;
  descender: number;
  slugData: unknown;
  totalAdvance: number;
}

// ---------------------------------------------------------------------------
// Anchor resolution
// ---------------------------------------------------------------------------

export interface AnchorTarget {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Viewport info (for position: "fixed" elements)
// ---------------------------------------------------------------------------

export interface ViewportInfo {
  offsetX: number;
  offsetY: number;
  zoom: number;
  width: number; // canvas width in device pixels
  height: number; // canvas height in device pixels
  dpr: number;
}

// ---------------------------------------------------------------------------
// Layout result types (consumed by rendering pipelines)
// ---------------------------------------------------------------------------

export interface UILayoutResult {
  boxes: UILayoutBox[];
  texts: UILayoutText[];
  icons: UILayoutIcon[];
}

export interface UILayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
  background: UIBackground;
  borderRadius: number;
  borderWidth: number;
  borderColor: UIColor;
  opacity: number;
  zIndex: number;
}

export interface UILayoutText {
  x: number;
  y: number;
  fontSize: number;
  color: UIColor;
  opacity: number;
  slugData: unknown;
  totalWidth: number;
  ascender: number;
  descender: number;
  zIndex: number;
}

export interface UILayoutIcon {
  x: number;
  y: number;
  width: number;
  height: number;
  svg: string;
  tint: UIColor;
  opacity: number;
  zIndex: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_EDGES: UIEdges = { top: 0, right: 0, bottom: 0, left: 0 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };

function resolvePadding(raw: unknown, scale: number): UIEdges {
  if (raw == null) return ZERO_EDGES;
  if (typeof raw === "number") {
    const v = raw * scale;
    return { top: v, right: v, bottom: v, left: v };
  }
  const e = raw as UIEdges;
  return {
    top: e.top * scale,
    right: e.right * scale,
    bottom: e.bottom * scale,
    left: e.left * scale,
  };
}

function resolveAnimatedProps(node: SceneNode, now: number): Record<string, number> {
  const animate = node.props["animate"] as AnimateConfig | undefined;
  if (!animate) return {};

  const resolved: Record<string, number> = {};
  for (const [prop, config] of Object.entries(animate)) {
    const target = node.props[prop];
    if (typeof target !== "number") continue;
    resolved[prop] = node.resolveAnimatedValue(prop, target, config as TweenConfig, now);
  }
  return resolved;
}

/** Get a numeric prop value, checking animated overrides, then applying scale. */
function getScaled(
  node: SceneNode,
  key: string,
  animated: Record<string, number>,
  fallback: number,
  scale: number,
): number {
  const val =
    key in animated ? animated[key]! : ((node.props[key] as number | undefined) ?? fallback);
  return val * scale;
}

/** Get a prop without scaling (for non-size values like opacity, flexGrow). */
function getRaw<T>(node: SceneNode, key: string, animated: Record<string, number>, fallback: T): T {
  if (key in animated) return animated[key] as T;
  const val = node.props[key];
  return val !== undefined ? (val as T) : fallback;
}

/** Get the active state style (active takes priority over hover). */
function getStateStyle(node: SceneNode): StateStyle | undefined {
  if (node.isActive) {
    const active = node.props["active"] as StateStyle | undefined;
    if (active) return active;
  }
  if (node.isHovered) {
    const hover = node.props["hover"] as StateStyle | undefined;
    if (hover) return hover;
  }
  return undefined;
}

function getEffectiveBackground(node: SceneNode): UIBackground | undefined {
  const state = getStateStyle(node);
  if (state?.background) return state.background;
  return node.props["background"] as UIBackground | undefined;
}

function getEffectiveBorderColor(node: SceneNode): UIColor {
  const state = getStateStyle(node);
  if (state?.borderColor) return state.borderColor;
  return (node.props["borderColor"] as UIColor) ?? TRANSPARENT;
}

function getEffectiveOpacity(node: SceneNode, animated: Record<string, number>): number {
  let opacity = getRaw(node, "opacity", animated, 1);
  const state = getStateStyle(node);
  if (state?.opacity !== undefined) opacity = state.opacity;
  return opacity;
}

/** Resolve visual scale with transition support. */
function resolveVisualScale(node: SceneNode, now: number): number {
  const state = getStateStyle(node);
  const targetScale = state?.scale ?? 1;
  const transition = node.props["transition"] as Record<string, TweenConfig> | undefined;
  if (transition?.["scale"]) {
    return node.resolveAnimatedValue("_visualScale", targetScale, transition["scale"], now);
  }
  return targetScale;
}

// ---------------------------------------------------------------------------
// Pass 1: Measure (bottom-up)
// ---------------------------------------------------------------------------

function measure(
  node: SceneNode,
  measurer: TextMeasurer,
  now: number,
  scale: number,
  viewport?: ViewportInfo,
): void {
  const animated = resolveAnimatedProps(node, now);

  switch (node.type) {
    case "text": {
      const content = node.props["content"] as string | undefined;
      const fontSize = getScaled(node, "fontSize", animated, 14, scale);

      if (!content || content.length === 0) {
        node.layout.width = 0;
        node.layout.height = 0;
        return;
      }

      // Check text cache (compare against scaled fontSize)
      if (
        node.textCache &&
        node.textCache.content === content &&
        node.textCache.fontSize === fontSize
      ) {
        node.layout.width = node.textCache.measuredWidth;
        node.layout.height = node.textCache.measuredHeight;
        return;
      }

      const metrics = measurer.measureText(content, fontSize);
      node.layout.width = metrics.width;
      node.layout.height = metrics.height;
      node.textCache = {
        content,
        fontSize,
        slugData: metrics.slugData,
        totalWidth: metrics.width,
        ascender: metrics.ascender,
        descender: metrics.descender,
        measuredWidth: metrics.width,
        measuredHeight: metrics.height,
      };
      return;
    }

    case "icon": {
      const size = getScaled(node, "size", animated, 0, scale);
      node.layout.width = size > 0 ? size : 0;
      node.layout.height = size > 0 ? size : 0;
      return;
    }

    case "box":
    case "anchor": {
      const direction = (node.props["direction"] as "row" | "col") ?? "col";
      const gap = getScaled(node, "gap", animated, 0, scale);
      const padding = resolvePadding(node.props["padding"], scale);

      // Measure children first
      const flowChildren: SceneNode[] = [];
      for (const child of node.children) {
        const pos = child.props["position"] as string | undefined;
        // Fixed children use screen-space scale
        const childScale = pos === "fixed" && viewport ? viewport.dpr / viewport.zoom : scale;
        measure(child, measurer, now, childScale, viewport);
        if (pos !== "absolute" && pos !== "fixed" && child.phase !== "exiting") {
          flowChildren.push(child);
        }
      }

      const visible = flowChildren.filter((c) => c.layout.width > 0 || c.layout.height > 0);
      const visibleCount = visible.length;

      let mainSize = 0;
      let crossSize = 0;

      if (direction === "row") {
        for (const child of visible) {
          mainSize += child.layout.width;
          crossSize = Math.max(crossSize, child.layout.height);
        }
        if (visibleCount > 1) mainSize += (visibleCount - 1) * gap;
      } else {
        for (const child of visible) {
          mainSize += child.layout.height;
          crossSize = Math.max(crossSize, child.layout.width);
        }
        if (visibleCount > 1) mainSize += (visibleCount - 1) * gap;
      }

      let totalWidth: number;
      let totalHeight: number;
      if (direction === "row") {
        totalWidth = mainSize + padding.left + padding.right;
        totalHeight = crossSize + padding.top + padding.bottom;
      } else {
        totalWidth = crossSize + padding.left + padding.right;
        totalHeight = mainSize + padding.top + padding.bottom;
      }

      // Apply explicit sizing (scaled)
      const explicitWidth = node.props["width"] as number | undefined;
      const explicitHeight = node.props["height"] as number | undefined;
      if (explicitWidth !== undefined) totalWidth = explicitWidth * scale;
      if (explicitHeight !== undefined) totalHeight = explicitHeight * scale;

      // Apply constraints (scaled)
      const minWidth = node.props["minWidth"] as number | undefined;
      const minHeight = node.props["minHeight"] as number | undefined;
      const maxWidth = node.props["maxWidth"] as number | undefined;
      const maxHeight = node.props["maxHeight"] as number | undefined;
      if (minWidth !== undefined && totalWidth < minWidth * scale) totalWidth = minWidth * scale;
      if (minHeight !== undefined && totalHeight < minHeight * scale)
        totalHeight = minHeight * scale;
      if (maxWidth !== undefined && totalWidth > maxWidth * scale) totalWidth = maxWidth * scale;
      if (maxHeight !== undefined && totalHeight > maxHeight * scale)
        totalHeight = maxHeight * scale;

      node.layout.width = totalWidth;
      node.layout.height = totalHeight;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 2: Position (top-down) + emit to flat arrays
// ---------------------------------------------------------------------------

function position(
  node: SceneNode,
  x: number,
  y: number,
  now: number,
  scale: number,
  result: UILayoutResult,
  parentZIndex = 0,
  viewport?: ViewportInfo,
): void {
  const animated = resolveAnimatedProps(node, now);
  node.layout.x = x;
  node.layout.y = y;

  switch (node.type) {
    case "text": {
      if (node.layout.width <= 0) break;
      const opacity = getEffectiveOpacity(node, animated);
      const color = (node.props["color"] as UIColor) ?? WHITE;
      result.texts.push({
        x: x + node.layout.width / 2,
        y: y + node.layout.height,
        fontSize: getScaled(node, "fontSize", animated, 14, scale),
        color,
        opacity,
        slugData: node.textCache?.slugData,
        totalWidth: node.textCache?.totalWidth ?? 0,
        ascender: node.textCache?.ascender ?? 0,
        descender: node.textCache?.descender ?? 0,
        zIndex: parentZIndex,
      });
      break;
    }

    case "icon": {
      if (node.layout.width <= 0) break;
      const opacity = getEffectiveOpacity(node, animated);
      const svg = node.props["svg"] as string;
      const tint = (node.props["tint"] as UIColor) ?? WHITE;
      result.icons.push({
        x,
        y,
        width: node.layout.width,
        height: node.layout.height,
        svg,
        tint,
        opacity,
        zIndex: parentZIndex,
      });
      break;
    }

    case "box":
    case "anchor": {
      const zIndex = parentZIndex + ((node.props["zIndex"] as number | undefined) ?? 0);
      const opacity = getEffectiveOpacity(node, animated);
      const background = getEffectiveBackground(node);
      const stateStyle = getStateStyle(node);
      const visualScale = resolveVisualScale(node, now);

      // Track emit start indices for visual scale transform
      const boxStart = result.boxes.length;
      const textStart = result.texts.length;
      const iconStart = result.icons.length;

      if (background) {
        result.boxes.push({
          x,
          y,
          width: node.layout.width,
          height: node.layout.height,
          background,
          borderRadius:
            stateStyle?.borderRadius !== undefined
              ? stateStyle.borderRadius * scale
              : getScaled(node, "borderRadius", animated, 0, scale),
          borderWidth:
            stateStyle?.borderWidth !== undefined
              ? stateStyle.borderWidth * scale
              : getScaled(node, "borderWidth", animated, 0, scale),
          borderColor: getEffectiveBorderColor(node),
          opacity,
          zIndex,
        });
      }

      positionChildren(node, x, y, now, scale, animated, result, zIndex, viewport);

      // Apply visual scale transform to all entries emitted by this subtree
      if (visualScale !== 1) {
        const cx = x + node.layout.width / 2;
        const cy = y + node.layout.height / 2;
        applyScaleToEntries(result, boxStart, textStart, iconStart, cx, cy, visualScale);
      }
      break;
    }
  }
}

function positionChildren(
  parent: SceneNode,
  parentX: number,
  parentY: number,
  now: number,
  scale: number,
  animated: Record<string, number>,
  result: UILayoutResult,
  parentZIndex = 0,
  viewport?: ViewportInfo,
): void {
  if (parent.children.length === 0) return;

  const direction = (parent.props["direction"] as "row" | "col") ?? "col";
  const gap = getScaled(parent, "gap", animated, 0, scale);
  const padding = resolvePadding(parent.props["padding"], scale);
  const align = (parent.props["align"] as "start" | "center" | "end") ?? "start";
  const justify = (parent.props["justifyContent"] as string) ?? "start";

  const contentX = parentX + padding.left;
  const contentY = parentY + padding.top;
  const contentWidth = parent.layout.width - padding.left - padding.right;
  const contentHeight = parent.layout.height - padding.top - padding.bottom;

  const flowChildren: SceneNode[] = [];
  const absoluteChildren: SceneNode[] = [];
  const fixedChildren: SceneNode[] = [];

  for (const child of parent.children) {
    const pos = child.props["position"] as string | undefined;
    if (pos === "absolute") {
      absoluteChildren.push(child);
    } else if (pos === "fixed") {
      fixedChildren.push(child);
    } else {
      flowChildren.push(child);
    }
  }

  // --- Flow children ---
  const visible = flowChildren.filter((c) => c.layout.width > 0 || c.layout.height > 0);

  if (visible.length > 0) {
    let childrenMainSize = 0;
    let totalFlexGrow = 0;

    for (const child of visible) {
      childrenMainSize += direction === "row" ? child.layout.width : child.layout.height;
      totalFlexGrow += (child.props["flexGrow"] as number) ?? 0;
    }
    if (visible.length > 1) childrenMainSize += (visible.length - 1) * gap;

    const availableMain = direction === "row" ? contentWidth : contentHeight;
    const freeSpace = Math.max(0, availableMain - childrenMainSize);

    if (totalFlexGrow > 0 && freeSpace > 0) {
      for (const child of visible) {
        const grow = (child.props["flexGrow"] as number) ?? 0;
        if (grow > 0) {
          const extra = (grow / totalFlexGrow) * freeSpace;
          if (direction === "row") {
            child.layout.width += extra;
          } else {
            child.layout.height += extra;
          }
        }
      }
    }

    let mainCursor: number;
    let justifyGap = gap;

    if (totalFlexGrow > 0 || justify === "start") {
      mainCursor = direction === "row" ? contentX : contentY;
    } else if (justify === "center") {
      const remaining = availableMain - childrenMainSize;
      mainCursor = (direction === "row" ? contentX : contentY) + remaining / 2;
    } else if (justify === "end") {
      const remaining = availableMain - childrenMainSize;
      mainCursor = (direction === "row" ? contentX : contentY) + remaining;
    } else if (justify === "space-between" && visible.length > 1) {
      mainCursor = direction === "row" ? contentX : contentY;
      const totalChildSize = childrenMainSize - (visible.length - 1) * gap;
      justifyGap = (availableMain - totalChildSize) / (visible.length - 1);
    } else if (justify === "space-around" && visible.length > 0) {
      const totalChildSize = childrenMainSize - (visible.length - 1) * gap;
      const eachGap = (availableMain - totalChildSize) / (visible.length * 2);
      mainCursor = (direction === "row" ? contentX : contentY) + eachGap;
      justifyGap = eachGap * 2;
    } else {
      mainCursor = direction === "row" ? contentX : contentY;
    }

    for (const child of visible) {
      if (direction === "row") {
        let childY: number;
        if (align === "center") {
          childY = contentY + (contentHeight - child.layout.height) / 2;
        } else if (align === "end") {
          childY = contentY + contentHeight - child.layout.height;
        } else {
          childY = contentY;
        }
        position(child, mainCursor, childY, now, scale, result, parentZIndex, viewport);
        mainCursor += child.layout.width + justifyGap;
      } else {
        let childX: number;
        if (align === "center") {
          childX = contentX + (contentWidth - child.layout.width) / 2;
        } else if (align === "end") {
          childX = contentX + contentWidth - child.layout.width;
        } else {
          childX = contentX;
        }
        position(child, childX, mainCursor, now, scale, result, parentZIndex, viewport);
        mainCursor += child.layout.height + justifyGap;
      }
    }

    for (const child of flowChildren) {
      if (child.layout.width <= 0 && child.layout.height <= 0) {
        position(child, contentX, contentY, now, scale, result, parentZIndex, viewport);
      }
    }
  }

  // --- Absolute children ---
  for (const child of absoluteChildren) {
    const left = child.props["left"] as number | undefined;
    const top = child.props["top"] as number | undefined;
    const right = child.props["right"] as number | undefined;
    const bottom = child.props["bottom"] as number | undefined;

    let childX = parentX;
    let childY = parentY;

    if (left !== undefined) childX = parentX + left * scale;
    else if (right !== undefined)
      childX = parentX + parent.layout.width - child.layout.width - right * scale;

    if (top !== undefined) childY = parentY + top * scale;
    else if (bottom !== undefined)
      childY = parentY + parent.layout.height - child.layout.height - bottom * scale;

    position(child, childX, childY, now, scale, result, parentZIndex, viewport);
  }

  // --- Fixed children (positioned relative to viewport) ---
  if (viewport && fixedChildren.length > 0) {
    const screenScale = viewport.dpr / viewport.zoom;
    const vpLeft = viewport.offsetX;
    const vpTop = viewport.offsetY;
    const vpRight = viewport.offsetX + viewport.width / viewport.zoom;
    const vpBottom = viewport.offsetY + viewport.height / viewport.zoom;

    for (const child of fixedChildren) {
      const left = child.props["left"] as number | undefined;
      const top = child.props["top"] as number | undefined;
      const right = child.props["right"] as number | undefined;
      const bottom = child.props["bottom"] as number | undefined;

      let childX = vpLeft;
      let childY = vpTop;

      if (left !== undefined) childX = vpLeft + left * screenScale;
      else if (right !== undefined) childX = vpRight - child.layout.width - right * screenScale;

      if (top !== undefined) childY = vpTop + top * screenScale;
      else if (bottom !== undefined) childY = vpBottom - child.layout.height - bottom * screenScale;

      position(child, childX, childY, now, screenScale, result, parentZIndex, viewport);
    }
  }
}

// ---------------------------------------------------------------------------
// Visual scale transform (for :active press effect)
// ---------------------------------------------------------------------------

function applyScaleToEntries(
  result: UILayoutResult,
  boxStart: number,
  textStart: number,
  iconStart: number,
  cx: number,
  cy: number,
  s: number,
): void {
  for (let i = boxStart; i < result.boxes.length; i++) {
    const b = result.boxes[i]!;
    b.x = cx + (b.x - cx) * s;
    b.y = cy + (b.y - cy) * s;
    b.width *= s;
    b.height *= s;
    b.borderRadius *= s;
    b.borderWidth *= s;
  }
  for (let i = textStart; i < result.texts.length; i++) {
    const t = result.texts[i]!;
    t.x = cx + (t.x - cx) * s;
    t.y = cy + (t.y - cy) * s;
    t.fontSize *= s;
  }
  for (let i = iconStart; i < result.icons.length; i++) {
    const ic = result.icons[i]!;
    ic.x = cx + (ic.x - cx) * s;
    ic.y = cy + (ic.y - cy) * s;
    ic.width *= s;
    ic.height *= s;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute layout for a SceneNode tree rooted at an anchor position.
 *
 * @param root     Root scene node
 * @param anchorX  Center-X position in world space
 * @param anchorY  Bottom-edge Y position in world space
 * @param measurer Text measurement interface
 * @param now      Current timestamp for animations
 * @param anchors  Optional map of entity IDs to their world-space bounds
 * @param scale    Size multiplier (dpr/zoom for screen-space, 1 for world-space)
 * @param viewport Viewport info for resolving position: "fixed" elements
 */
export function computeLayout(
  root: SceneNode,
  anchorX: number,
  anchorY: number,
  measurer: TextMeasurer,
  now: number,
  anchors?: Map<string, AnchorTarget>,
  scale = 1,
  viewport?: ViewportInfo,
): UILayoutResult {
  const result: UILayoutResult = { boxes: [], texts: [], icons: [] };

  // If root is an anchor node, resolve its position from entity bounds
  if (root.type === "anchor" && anchors) {
    const entityId = root.props["entityId"] as string;
    const target = anchors.get(entityId);
    if (target) {
      const edge = (root.props["edge"] as string) ?? "top";
      const offset = (root.props["offset"] as { x: number; y: number }) ?? { x: 0, y: 0 };

      measure(root, measurer, now, scale, viewport);

      let resolvedX: number;
      let resolvedY: number;

      switch (edge) {
        case "top":
          resolvedX = target.x + target.width / 2 + offset.x * scale;
          resolvedY = target.y + offset.y * scale;
          break;
        case "bottom":
          resolvedX = target.x + target.width / 2 + offset.x * scale;
          resolvedY = target.y + target.height + offset.y * scale;
          break;
        case "left":
          resolvedX = target.x + offset.x * scale;
          resolvedY = target.y + target.height / 2 + offset.y * scale;
          break;
        case "right":
          resolvedX = target.x + target.width + offset.x * scale;
          resolvedY = target.y + target.height / 2 + offset.y * scale;
          break;
        case "center":
        default:
          resolvedX = target.x + target.width / 2 + offset.x * scale;
          resolvedY = target.y + target.height / 2 + offset.y * scale;
          break;
      }

      const rootX = resolvedX - root.layout.width / 2;
      const rootY = resolvedY - root.layout.height;
      position(root, rootX, rootY, now, scale, result, 0, viewport);
      sortByZIndex(result);
      return result;
    }
  }

  measure(root, measurer, now, scale, viewport);

  // Apply drag offset for draggable elements
  const dragX = root.dragOffset.x;
  const dragY = root.dragOffset.y;

  const rootX = anchorX - root.layout.width / 2 + dragX;
  const rootY = anchorY - root.layout.height + dragY;
  position(root, rootX, rootY, now, scale, result, 0, viewport);
  sortByZIndex(result);

  return result;
}

/** Stable-sort all layout arrays by z-index (preserves document order for equal z-indices). */
function sortByZIndex(result: UILayoutResult): void {
  if (result.boxes.length > 1) result.boxes.sort((a, b) => a.zIndex - b.zIndex);
  if (result.texts.length > 1) result.texts.sort((a, b) => a.zIndex - b.zIndex);
  if (result.icons.length > 1) result.icons.sort((a, b) => a.zIndex - b.zIndex);
}
