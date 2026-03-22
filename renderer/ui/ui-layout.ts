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
  UIColorValue,
  UIBackground,
  AnimateConfig,
  StateStyle,
} from "./elements.ts";
import type { SceneNode } from "./scene-node.ts";
import type { UIResolvedBackground, UIStyleResolver } from "./style-resolver.ts";

// ---------------------------------------------------------------------------
// Text measurement interface (decouples layout from GPU text rendering)
// ---------------------------------------------------------------------------

export interface TextMeasurer {
  measureText(content: string, fontSize: number, maxWidth?: number): TextMetrics;
}

export interface TextMeasuredLine {
  slugData: unknown;
  width: number;
}

export interface TextMetrics {
  width: number;
  height: number;
  ascender: number;
  descender: number;
  lineHeight: number;
  lines: TextMeasuredLine[];
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

interface MeasureConstraints {
  availableWidth?: number;
  availableHeight?: number;
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
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
  background: UIResolvedBackground;
  borderRadius: number;
  borderWidth: number;
  borderColor: UIColor;
  opacity: number;
  zIndex: number;
}

export interface UILayoutText {
  order: number;
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
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
  svg: string;
  tint: UIColor;
  opacity: number;
  zIndex: number;
}

interface UITransform {
  scale: number;
  translateX: number;
  translateY: number;
}

interface OrderCounter {
  value: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_EDGES: UIEdges = { top: 0, right: 0, bottom: 0, left: 0 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };
const IDENTITY_TRANSFORM: UITransform = { scale: 1, translateX: 0, translateY: 0 };

function transformX(transform: UITransform, x: number): number {
  return x * transform.scale + transform.translateX;
}

function transformY(transform: UITransform, y: number): number {
  return y * transform.scale + transform.translateY;
}

function transformSize(transform: UITransform, value: number): number {
  return value * transform.scale;
}

function scaleAround(
  transform: UITransform,
  pivotX: number,
  pivotY: number,
  scale: number,
): UITransform {
  if (scale === 1) return transform;

  return {
    scale: transform.scale * scale,
    translateX: transform.translateX + transform.scale * pivotX * (1 - scale),
    translateY: transform.translateY + transform.scale * pivotY * (1 - scale),
  };
}

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
  const resolved = node.scratch.animatedProps;
  const keys = node.scratch.animatedKeys;

  for (let i = 0; i < keys.length; i++) {
    delete resolved[keys[i]!];
  }
  keys.length = 0;

  if (!animate) return resolved;

  for (const prop in animate) {
    const config = animate[prop]!;
    const target = node.props[prop];
    if (typeof target !== "number") continue;
    resolved[prop] = node.resolveAnimatedValue(prop, target, config, now);
    keys.push(prop);
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

function getEffectiveBackground(
  node: SceneNode,
  styleResolver: UIStyleResolver,
): UIResolvedBackground | undefined {
  const state = getStateStyle(node);
  if (state?.background) return styleResolver.resolveBackground(state.background);
  return styleResolver.resolveBackground(node.props["background"] as UIBackground | undefined);
}

function getEffectiveBorderColor(node: SceneNode, styleResolver: UIStyleResolver): UIColor {
  const state = getStateStyle(node);
  if (state?.borderColor) return styleResolver.resolveColor(state.borderColor, TRANSPARENT);
  return styleResolver.resolveColor(
    node.props["borderColor"] as UIColorValue | undefined,
    TRANSPARENT,
  );
}

function getEffectiveOpacity(node: SceneNode, animated: Record<string, number>): number {
  let opacity = getRaw(node, "opacity", animated, 1);
  const state = getStateStyle(node);
  if (state?.opacity !== undefined) opacity = state.opacity;
  return opacity;
}

function mainSizeOf(node: SceneNode, direction: "row" | "col"): number {
  return direction === "row" ? node.layout.width : node.layout.height;
}

function applyAvailableClamp(
  width: number,
  height: number,
  constraints: MeasureConstraints,
): { width: number; height: number } {
  let nextWidth = width;
  let nextHeight = height;
  if (constraints.availableWidth !== undefined && nextWidth > constraints.availableWidth) {
    nextWidth = constraints.availableWidth;
  }
  if (constraints.availableHeight !== undefined && nextHeight > constraints.availableHeight) {
    nextHeight = constraints.availableHeight;
  }
  return { width: nextWidth, height: nextHeight };
}

function shrinkChildrenToFit(
  visible: SceneNode[],
  direction: "row" | "col",
  availableMain: number,
  gap: number,
  measurer: TextMeasurer,
  now: number,
  scale: number,
  viewport: ViewportInfo | undefined,
  remaining: SceneNode[],
  nextRemaining: SceneNode[],
): void {
  if (visible.length === 0) return;

  const gapSpace = visible.length > 1 ? (visible.length - 1) * gap : 0;
  const maxChildrenMain = Math.max(0, availableMain - gapSpace);
  let childrenMainSize = 0;
  for (let i = 0; i < visible.length; i++) {
    childrenMainSize += mainSizeOf(visible[i]!, direction);
  }
  if (childrenMainSize <= maxChildrenMain) return;

  let overflow = childrenMainSize - maxChildrenMain;
  remaining.length = 0;
  nextRemaining.length = 0;
  for (let i = 0; i < visible.length; i++) {
    const child = visible[i]!;
    if (((child.props["flexShrink"] as number | undefined) ?? 1) > 0) {
      remaining.push(child);
    }
  }

  while (overflow > 0.5 && remaining.length > 0) {
    let totalShrinkFactor = 0;
    for (let i = 0; i < remaining.length; i++) {
      const child = remaining[i]!;
      totalShrinkFactor +=
        ((child.props["flexShrink"] as number | undefined) ?? 1) * mainSizeOf(child, direction);
    }
    if (totalShrinkFactor <= 0) break;

    let reduced = 0;
    nextRemaining.length = 0;

    for (const child of remaining) {
      const currentMain = mainSizeOf(child, direction);
      const minMain =
        direction === "row"
          ? ((child.props["minWidth"] as number | undefined) ?? 0) * scale
          : ((child.props["minHeight"] as number | undefined) ?? 0) * scale;
      const shrinkFactor =
        (((child.props["flexShrink"] as number | undefined) ?? 1) * currentMain) /
        totalShrinkFactor;
      const targetMain = Math.max(minMain, currentMain - overflow * shrinkFactor);

      const childConstraints: MeasureConstraints =
        direction === "row" ? { availableWidth: targetMain } : { availableHeight: targetMain };
      const pos = child.props["position"] as string | undefined;
      const childScale = pos === "fixed" && viewport ? viewport.dpr / viewport.zoom : scale;
      measure(child, measurer, now, childScale, viewport, childConstraints);

      const nextMain = mainSizeOf(child, direction);
      reduced += Math.max(0, currentMain - nextMain);
      if (nextMain > minMain + 0.5) {
        nextRemaining.push(child);
      }
    }

    if (reduced <= 0.5) break;
    overflow -= reduced;
    remaining.length = 0;
    for (let i = 0; i < nextRemaining.length; i++) {
      remaining.push(nextRemaining[i]!);
    }
    childrenMainSize = 0;
    for (let i = 0; i < visible.length; i++) {
      childrenMainSize += mainSizeOf(visible[i]!, direction);
    }
    if (childrenMainSize <= maxChildrenMain) break;
    overflow = childrenMainSize - maxChildrenMain;
  }
}

/** Resolve visual scale with transition support. */
function resolveVisualScale(node: SceneNode, now: number): number {
  const state = getStateStyle(node);
  const targetScale = state?.scale ?? 1;
  const transition = node.props["transition"] as AnimateConfig | undefined;
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
  constraints: MeasureConstraints = {},
): void {
  const animated = resolveAnimatedProps(node, now);
  // Cache for reuse in position() to avoid redundant spring sampling
  node.scratch.lastAnimated = animated;
  node.scratch.lastAnimatedTime = now;

  switch (node.type) {
    case "text": {
      const content = node.props["content"] as string | undefined;
      const fontSize = getScaled(node, "fontSize", animated, 14, scale);
      const rawMaxWidth = node.props["maxWidth"] as number | undefined;
      let maxWidth = rawMaxWidth !== undefined ? rawMaxWidth * scale : undefined;
      if (constraints.availableWidth !== undefined) {
        maxWidth =
          maxWidth !== undefined
            ? Math.min(maxWidth, constraints.availableWidth)
            : constraints.availableWidth;
      }

      if (!content || content.length === 0) {
        node.layout.width = 0;
        node.layout.height = 0;
        return;
      }

      // Check text cache (compare against scaled fontSize)
      if (
        node.textCache &&
        node.textCache.content === content &&
        node.textCache.fontSize === fontSize &&
        node.textCache.maxWidth === (maxWidth ?? null)
      ) {
        node.layout.width = node.textCache.measuredWidth;
        node.layout.height = node.textCache.measuredHeight;
        return;
      }

      const metrics = measurer.measureText(content, fontSize, maxWidth);
      node.layout.width = metrics.width;
      node.layout.height = metrics.height;
      const cachedLines = new Array(metrics.lines.length);
      for (let i = 0; i < metrics.lines.length; i++) {
        const line = metrics.lines[i]!;
        cachedLines[i] = {
          slugData: line.slugData,
          totalWidth: line.width,
        };
      }
      node.textCache = {
        content,
        fontSize,
        maxWidth: maxWidth ?? null,
        lineHeight: metrics.lineHeight,
        ascender: metrics.ascender,
        descender: metrics.descender,
        measuredWidth: metrics.width,
        measuredHeight: metrics.height,
        lines: cachedLines,
      };
      return;
    }

    case "icon": {
      const size = getScaled(node, "size", animated, 0, scale);
      const clamped = applyAvailableClamp(size > 0 ? size : 0, size > 0 ? size : 0, constraints);
      node.layout.width = clamped.width;
      node.layout.height = clamped.height;
      return;
    }

    case "box":
    case "anchor": {
      const direction = (node.props["direction"] as "row" | "col") ?? "col";
      const gap = getScaled(node, "gap", animated, 0, scale);
      const padding = resolvePadding(node.props["padding"], scale);
      const flowChildren = node.scratch.flowChildren;
      const visibleChildren = node.scratch.visibleChildren;
      const explicitWidth = node.props["width"] as number | undefined;
      const explicitHeight = node.props["height"] as number | undefined;
      const minWidth = node.props["minWidth"] as number | undefined;
      const minHeight = node.props["minHeight"] as number | undefined;
      const maxWidth = node.props["maxWidth"] as number | undefined;
      const maxHeight = node.props["maxHeight"] as number | undefined;

      let availableWidth = constraints.availableWidth;
      let availableHeight = constraints.availableHeight;
      if (maxWidth !== undefined) {
        const scaledMaxWidth = maxWidth * scale;
        availableWidth =
          availableWidth !== undefined ? Math.min(availableWidth, scaledMaxWidth) : scaledMaxWidth;
      }
      if (maxHeight !== undefined) {
        const scaledMaxHeight = maxHeight * scale;
        availableHeight =
          availableHeight !== undefined
            ? Math.min(availableHeight, scaledMaxHeight)
            : scaledMaxHeight;
      }
      if (explicitWidth !== undefined) availableWidth = explicitWidth * scale;
      if (explicitHeight !== undefined) availableHeight = explicitHeight * scale;

      const overflow = node.props["overflow"] as "visible" | "hidden" | "scroll" | undefined;
      const isScroll = overflow === "scroll";

      const contentAvailableWidth =
        availableWidth !== undefined
          ? Math.max(0, availableWidth - padding.left - padding.right)
          : undefined;
      // For scroll containers, don't constrain children's height — measure them unconstrained
      const contentAvailableHeight = isScroll
        ? undefined
        : availableHeight !== undefined
          ? Math.max(0, availableHeight - padding.top - padding.bottom)
          : undefined;

      // Measure children first
      flowChildren.length = 0;
      for (const child of node.children) {
        const pos = child.props["position"] as string | undefined;
        // Fixed children use screen-space scale
        const childScale = pos === "fixed" && viewport ? viewport.dpr / viewport.zoom : scale;
        const childConstraints: MeasureConstraints =
          pos === "absolute" || pos === "fixed"
            ? {}
            : direction === "col"
              ? {
                  availableWidth: contentAvailableWidth,
                  availableHeight: contentAvailableHeight,
                }
              : { availableHeight: contentAvailableHeight };
        measure(child, measurer, now, childScale, viewport, childConstraints);
        if (pos !== "absolute" && pos !== "fixed" && child.phase !== "exiting") {
          flowChildren.push(child);
        }
      }

      visibleChildren.length = 0;
      for (let i = 0; i < flowChildren.length; i++) {
        const child = flowChildren[i]!;
        if (child.layout.width > 0 || child.layout.height > 0) {
          visibleChildren.push(child);
        }
      }
      const visible = visibleChildren;
      const visibleCount = visibleChildren.length;

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

      if (direction === "row" && contentAvailableWidth !== undefined) {
        shrinkChildrenToFit(
          visible,
          direction,
          contentAvailableWidth,
          gap,
          measurer,
          now,
          scale,
          viewport,
          node.scratch.shrinkChildren,
          node.scratch.nextShrinkChildren,
        );
      } else if (direction === "col" && contentAvailableHeight !== undefined) {
        shrinkChildrenToFit(
          visible,
          direction,
          contentAvailableHeight,
          gap,
          measurer,
          now,
          scale,
          viewport,
          node.scratch.shrinkChildren,
          node.scratch.nextShrinkChildren,
        );
      }

      mainSize = 0;
      crossSize = 0;
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

      // For scroll containers, store the unconstrained content size before clamping
      if (isScroll) {
        node.contentSize.width = totalWidth;
        node.contentSize.height = totalHeight;
      }

      // Apply explicit sizing (scaled)
      if (explicitWidth !== undefined) totalWidth = explicitWidth * scale;
      if (explicitHeight !== undefined) totalHeight = explicitHeight * scale;

      // Apply constraints (scaled)
      if (minWidth !== undefined && totalWidth < minWidth * scale) totalWidth = minWidth * scale;
      if (minHeight !== undefined && totalHeight < minHeight * scale)
        totalHeight = minHeight * scale;
      if (maxWidth !== undefined && totalWidth > maxWidth * scale) totalWidth = maxWidth * scale;
      if (maxHeight !== undefined && totalHeight > maxHeight * scale)
        totalHeight = maxHeight * scale;

      const clamped = applyAvailableClamp(totalWidth, totalHeight, constraints);
      totalWidth = clamped.width;
      totalHeight = clamped.height;

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
  styleResolver: UIStyleResolver,
  transform: UITransform,
  orderCounter: OrderCounter,
  result: UILayoutResult,
  parentZIndex = 0,
  viewport?: ViewportInfo,
): void {
  // Reuse animated props from measure phase if available and from the same frame
  const animated =
    node.scratch.lastAnimated && node.scratch.lastAnimatedTime === now
      ? node.scratch.lastAnimated
      : resolveAnimatedProps(node, now);
  const offsetX = node.dragOffset.x;
  const offsetY = node.dragOffset.y;
  const resolvedX = x + offsetX;
  const resolvedY = y + offsetY;
  node.layout.x = resolvedX;
  node.layout.y = resolvedY;
  const onLayout = node.props["onLayout"] as ((node: SceneNode) => void) | undefined;
  onLayout?.(node);

  switch (node.type) {
    case "text": {
      if (node.layout.width <= 0) break;
      const opacity = getEffectiveOpacity(node, animated);
      const color = styleResolver.resolveColor(
        node.props["color"] as UIColorValue | undefined,
        WHITE,
      );
      const fontSize = transformSize(transform, getScaled(node, "fontSize", animated, 14, scale));
      const lineHeight = node.textCache?.lineHeight ?? node.layout.height;
      const lines = node.textCache?.lines ?? [];

      for (const [index, line] of lines.entries()) {
        result.texts.push({
          order: orderCounter.value++,
          x: transformX(transform, resolvedX + line.totalWidth / 2),
          y: transformY(transform, resolvedY + lineHeight * (index + 1)),
          fontSize,
          color,
          opacity,
          slugData: line.slugData,
          totalWidth: line.totalWidth,
          ascender: node.textCache?.ascender ?? 0,
          descender: node.textCache?.descender ?? 0,
          zIndex: parentZIndex,
        });
      }
      break;
    }

    case "icon": {
      if (node.layout.width <= 0) break;
      const opacity = getEffectiveOpacity(node, animated);
      const svg = node.props["svg"] as string;
      const tint = styleResolver.resolveColor(
        node.props["tint"] as UIColorValue | undefined,
        WHITE,
      );
      result.icons.push({
        order: orderCounter.value++,
        x: transformX(transform, resolvedX),
        y: transformY(transform, resolvedY),
        width: transformSize(transform, node.layout.width),
        height: transformSize(transform, node.layout.height),
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
      const background = getEffectiveBackground(node, styleResolver);
      const stateStyle = getStateStyle(node);
      const visualScale = resolveVisualScale(node, now);
      const nodeTransform = scaleAround(
        transform,
        resolvedX + node.layout.width / 2,
        resolvedY + node.layout.height / 2,
        visualScale,
      );

      if (background) {
        result.boxes.push({
          order: orderCounter.value++,
          x: transformX(nodeTransform, resolvedX),
          y: transformY(nodeTransform, resolvedY),
          width: transformSize(nodeTransform, node.layout.width),
          height: transformSize(nodeTransform, node.layout.height),
          background,
          borderRadius: transformSize(
            nodeTransform,
            stateStyle?.borderRadius !== undefined
              ? stateStyle.borderRadius * scale
              : getScaled(node, "borderRadius", animated, 0, scale),
          ),
          borderWidth: transformSize(
            nodeTransform,
            stateStyle?.borderWidth !== undefined
              ? stateStyle.borderWidth * scale
              : getScaled(node, "borderWidth", animated, 0, scale),
          ),
          borderColor: getEffectiveBorderColor(node, styleResolver),
          opacity,
          zIndex,
        });
      }

      positionChildren(
        node,
        resolvedX,
        resolvedY,
        now,
        scale,
        styleResolver,
        nodeTransform,
        orderCounter,
        animated,
        result,
        zIndex,
        viewport,
      );
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
  styleResolver: UIStyleResolver,
  transform: UITransform,
  orderCounter: OrderCounter,
  animated: Record<string, number>,
  result: UILayoutResult,
  parentZIndex = 0,
  viewport?: ViewportInfo,
): void {
  if (parent.children.length === 0) return;

  const direction = (parent.props["direction"] as "row" | "col") ?? "col";
  const gap = getScaled(parent, "gap", animated, 0, scale);
  const padding = resolvePadding(parent.props["padding"], scale);
  const align = (parent.props["align"] as "start" | "center" | "end" | "stretch") ?? "start";
  const justify = (parent.props["justifyContent"] as string) ?? "start";

  const overflow = parent.props["overflow"] as "visible" | "hidden" | "scroll" | undefined;
  const contentX = parentX + padding.left;
  const contentY = parentY + padding.top;
  // For scroll containers, offset flow children by the scroll position
  const scrolledContentY = overflow === "scroll" ? contentY - parent.scrollOffset.y : contentY;
  const contentWidth = parent.layout.width - padding.left - padding.right;
  const contentHeight = parent.layout.height - padding.top - padding.bottom;

  const flowChildren = parent.scratch.flowChildren;
  const absoluteChildren = parent.scratch.absoluteChildren;
  const fixedChildren = parent.scratch.fixedChildren;
  const visibleChildren = parent.scratch.visibleChildren;

  flowChildren.length = 0;
  absoluteChildren.length = 0;
  fixedChildren.length = 0;

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
  visibleChildren.length = 0;
  for (let i = 0; i < flowChildren.length; i++) {
    const child = flowChildren[i]!;
    if (child.layout.width > 0 || child.layout.height > 0) {
      visibleChildren.push(child);
    }
  }
  const visible = visibleChildren;

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
      mainCursor = direction === "row" ? contentX : scrolledContentY;
    } else if (justify === "center") {
      const remaining = availableMain - childrenMainSize;
      mainCursor = (direction === "row" ? contentX : scrolledContentY) + remaining / 2;
    } else if (justify === "end") {
      const remaining = availableMain - childrenMainSize;
      mainCursor = (direction === "row" ? contentX : scrolledContentY) + remaining;
    } else if (justify === "space-between" && visible.length > 1) {
      mainCursor = direction === "row" ? contentX : scrolledContentY;
      const totalChildSize = childrenMainSize - (visible.length - 1) * gap;
      justifyGap = (availableMain - totalChildSize) / (visible.length - 1);
    } else if (justify === "space-around" && visible.length > 0) {
      const totalChildSize = childrenMainSize - (visible.length - 1) * gap;
      const eachGap = (availableMain - totalChildSize) / (visible.length * 2);
      mainCursor = (direction === "row" ? contentX : scrolledContentY) + eachGap;
      justifyGap = eachGap * 2;
    } else {
      mainCursor = direction === "row" ? contentX : scrolledContentY;
    }

    for (const child of visible) {
      if (direction === "row") {
        let childY: number;
        if (align === "stretch") {
          childY = scrolledContentY;
          child.layout.height = contentHeight;
        } else if (align === "center") {
          childY = scrolledContentY + (contentHeight - child.layout.height) / 2;
        } else if (align === "end") {
          childY = scrolledContentY + contentHeight - child.layout.height;
        } else {
          childY = scrolledContentY;
        }
        position(
          child,
          mainCursor,
          childY,
          now,
          scale,
          styleResolver,
          transform,
          orderCounter,
          result,
          parentZIndex,
          viewport,
        );
        mainCursor += child.layout.width + justifyGap;
      } else {
        let childX: number;
        if (align === "stretch") {
          childX = contentX;
          child.layout.width = contentWidth;
        } else if (align === "center") {
          childX = contentX + (contentWidth - child.layout.width) / 2;
        } else if (align === "end") {
          childX = contentX + contentWidth - child.layout.width;
        } else {
          childX = contentX;
        }
        position(
          child,
          childX,
          mainCursor,
          now,
          scale,
          styleResolver,
          transform,
          orderCounter,
          result,
          parentZIndex,
          viewport,
        );
        mainCursor += child.layout.height + justifyGap;
      }
    }

    for (const child of flowChildren) {
      if (child.layout.width <= 0 && child.layout.height <= 0) {
        position(
          child,
          contentX,
          scrolledContentY,
          now,
          scale,
          styleResolver,
          transform,
          orderCounter,
          result,
          parentZIndex,
          viewport,
        );
      }
    }
  }

  // --- Absolute children ---
  for (const child of absoluteChildren) {
    const placement = child.props["placement"] as string | undefined;
    const left = child.props["left"] as number | undefined;
    const top = child.props["top"] as number | undefined;
    const right = child.props["right"] as number | undefined;
    const bottom = child.props["bottom"] as number | undefined;

    let childX = parentX;
    let childY = parentY;

    if (placement) {
      // Placement-based positioning — attach to parent edge
      const dashIdx = placement.indexOf("-");
      const side = dashIdx > 0 ? placement.slice(0, dashIdx) : placement;
      const align = dashIdx > 0 ? placement.slice(dashIdx + 1) : "start";

      switch (side) {
        case "right":
          childX = parentX + parent.layout.width;
          break;
        case "left":
          childX = parentX - child.layout.width;
          break;
        case "bottom":
          childY = parentY + parent.layout.height;
          break;
        case "top":
          childY = parentY - child.layout.height;
          break;
      }

      // Cross-axis alignment
      if (side === "right" || side === "left") {
        childY = align === "end" ? parentY + parent.layout.height - child.layout.height : parentY;
      } else {
        childX = align === "end" ? parentX + parent.layout.width - child.layout.width : parentX;
      }
    } else {
      // Manual left/top/right/bottom
      if (left !== undefined) childX = parentX + left * scale;
      else if (right !== undefined)
        childX = parentX + parent.layout.width - child.layout.width - right * scale;

      if (top !== undefined) childY = parentY + top * scale;
      else if (bottom !== undefined)
        childY = parentY + parent.layout.height - child.layout.height - bottom * scale;
    }

    // Viewport containment — auto-clamp to viewport bounds
    const absContain = child.props["contain"] as string | undefined;
    if (absContain === "viewport" && viewport) {
      const vpL = viewport.offsetX;
      const vpT = viewport.offsetY;
      const vpR = viewport.offsetX + viewport.width / viewport.zoom;
      const vpB = viewport.offsetY + viewport.height / viewport.zoom;
      const margin = 4 * scale;

      // Flip placement side if overflow
      if (placement) {
        const dashIdx = placement.indexOf("-");
        const side = dashIdx > 0 ? placement.slice(0, dashIdx) : placement;
        if (side === "right" && childX + child.layout.width > vpR) {
          childX = parentX - child.layout.width;
        } else if (side === "left" && childX < vpL) {
          childX = parentX + parent.layout.width;
        }
      }

      // Clamp to viewport bounds
      if (childX + child.layout.width > vpR) childX = vpR - child.layout.width;
      if (childY + child.layout.height > vpB) childY = vpB - child.layout.height;
      if (childX < vpL + margin) childX = vpL + margin;
      if (childY < vpT + margin) childY = vpT + margin;
    }

    position(
      child,
      childX,
      childY,
      now,
      scale,
      styleResolver,
      transform,
      orderCounter,
      result,
      parentZIndex,
      viewport,
    );
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

      // Viewport containment — auto-clamp to viewport bounds
      const fixedContain = child.props["contain"] as string | undefined;
      if (fixedContain === "viewport") {
        const margin = 4 * screenScale;
        if (childX + child.layout.width > vpRight) childX = vpRight - child.layout.width;
        if (childY + child.layout.height > vpBottom) childY = vpBottom - child.layout.height;
        if (childX < vpLeft + margin) childX = vpLeft + margin;
        if (childY < vpTop + margin) childY = vpTop + margin;
      }

      position(
        child,
        childX,
        childY,
        now,
        screenScale,
        styleResolver,
        transform,
        orderCounter,
        result,
        parentZIndex,
        viewport,
      );
    }
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
  styleResolver: UIStyleResolver,
  anchors?: Map<string, AnchorTarget>,
  scale = 1,
  viewport?: ViewportInfo,
  reusableResult?: UILayoutResult,
): UILayoutResult {
  const result = reusableResult ?? { boxes: [], texts: [], icons: [] };
  result.boxes.length = 0;
  result.texts.length = 0;
  result.icons.length = 0;
  const orderCounter: OrderCounter = { value: 0 };

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
      position(
        root,
        rootX,
        rootY,
        now,
        scale,
        styleResolver,
        IDENTITY_TRANSFORM,
        orderCounter,
        result,
        0,
        viewport,
      );
      sortByZIndex(result);
      return result;
    }
  }

  measure(root, measurer, now, scale, viewport);

  const rootX = anchorX - root.layout.width / 2;
  const rootY = anchorY - root.layout.height;
  position(
    root,
    rootX,
    rootY,
    now,
    scale,
    styleResolver,
    IDENTITY_TRANSFORM,
    orderCounter,
    result,
    0,
    viewport,
  );
  sortByZIndex(result);

  return result;
}

/** Stable-sort all layout arrays by z-index (preserves document order for equal z-indices). */
function sortByZIndex(result: UILayoutResult): void {
  const compare = (a: { zIndex: number; order: number }, b: { zIndex: number; order: number }) =>
    a.zIndex - b.zIndex || a.order - b.order;

  if (result.boxes.length > 1) result.boxes.sort(compare);
  if (result.texts.length > 1) result.texts.sort(compare);
  if (result.icons.length > 1) result.icons.sort(compare);
}
