// ---------------------------------------------------------------------------
// Canvas UI Element Types
// ---------------------------------------------------------------------------

import type { ComponentType } from "react";

export type ReactIconComponent = ComponentType<Record<string, unknown>>;

export interface UIColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface UIEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type UIBackground =
  | { type: "solid"; color: UIColor }
  | { type: "gradient"; top: UIColor; bottom: UIColor };

// ---------------------------------------------------------------------------
// Animation / transition config
// ---------------------------------------------------------------------------

export interface TweenConfig {
  duration: number; // ms
  easing: (t: number) => number;
  delay?: number;
}

export type AnimateConfig = Record<string, TweenConfig>;

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface UIPointerEvent {
  worldX: number;
  worldY: number;
  type: "down" | "up" | "move";
}

export type UIEventHandler = (event: UIPointerEvent) => void;

export interface UIDragEvent {
  worldX: number;
  worldY: number;
  deltaX: number;
  deltaY: number;
}

export type UIDragHandler = (event: UIDragEvent) => void;

// ---------------------------------------------------------------------------
// State styles — partial overrides applied on hover / active
// ---------------------------------------------------------------------------

export interface StateStyle {
  background?: UIBackground;
  borderColor?: UIColor;
  borderWidth?: number;
  borderRadius?: number;
  opacity?: number;
  scale?: number; // visual scale (1.0 = normal, 0.95 = slightly smaller)
}

// ---------------------------------------------------------------------------
// UIElement — the descriptor produced by JSX (analogous to React.Element)
// ---------------------------------------------------------------------------

export type ComponentFn = (props: Record<string, unknown>) => UIElement | null;

export interface UIElement {
  type: string | ComponentFn;
  props: Record<string, unknown>;
  key: string | number | null;
}

// ---------------------------------------------------------------------------
// Intrinsic element prop types
// ---------------------------------------------------------------------------

export interface BoxElementProps {
  key?: string | number;
  direction?: "row" | "col";
  gap?: number;
  padding?: UIEdges | number;
  align?: "start" | "center" | "end";
  justifyContent?: "start" | "center" | "end" | "space-between" | "space-around";
  flexGrow?: number;
  background?: UIBackground;
  borderRadius?: number;
  borderWidth?: number;
  borderColor?: UIColor;
  opacity?: number;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  position?: "relative" | "absolute" | "fixed";
  zIndex?: number;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  animate?: AnimateConfig;
  // State styles
  hover?: StateStyle;
  active?: StateStyle;
  // Transitions for state style properties (interpolates on state change)
  transition?: Record<string, TweenConfig>;
  // Event handlers
  onClick?: UIEventHandler;
  onPointerDown?: UIEventHandler;
  onPointerUp?: UIEventHandler;
  // Draggable
  draggable?: boolean;
  onDrag?: UIDragHandler;
  children?: UIElement | UIElement[];
}

export interface TextElementProps {
  key?: string | number;
  fontSize: number;
  color: UIColor;
  opacity?: number;
  children?: string;
}

export interface IconElementProps {
  key?: string | number;
  /** Raw SVG string. Provide either `svg` or `icon`, not both. */
  svg?: string;
  /** React icon component (e.g. from iconoir-react). Converted to SVG string automatically. */
  icon?: ReactIconComponent;
  size: number;
  tint?: UIColor;
  opacity?: number;
  animate?: AnimateConfig;
}

export interface AnchorElementProps {
  key?: string | number;
  entityId: string;
  edge?: "top" | "bottom" | "left" | "right" | "center";
  offset?: { x: number; y: number };
  children?: UIElement | UIElement[];
}

// ---------------------------------------------------------------------------
// Edge inset helper (CSS-like shorthand)
// ---------------------------------------------------------------------------

export function edges(top: number, right?: number, bottom?: number, left?: number): UIEdges {
  if (right === undefined) {
    return { top, right: top, bottom: top, left: top };
  }
  if (bottom === undefined) {
    return { top, right, bottom: top, left: right };
  }
  return { top, right, bottom, left: left ?? right };
}

// ---------------------------------------------------------------------------
// Convenience component functions
// ---------------------------------------------------------------------------

export function Row(props: Record<string, unknown>): UIElement {
  return { type: "box", props: { ...props, direction: "row" }, key: null };
}

export function Col(props: Record<string, unknown>): UIElement {
  return { type: "box", props: { ...props, direction: "col" }, key: null };
}
