// ---------------------------------------------------------------------------
// Canvas UI Element Types
// ---------------------------------------------------------------------------

import type { ComponentType } from "react";
import type { SceneNode } from "./scene-node.ts";

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

export interface UIThemeValue<T> {
  type: "theme";
  light: T;
  dark: T;
}

export type UIColorValue = UIColor | string | UIThemeValue<UIColor | string>;

export interface UISolidBackground {
  type: "solid";
  color: UIColorValue;
}

export interface UIGradientBackground {
  type: "gradient";
  top: UIColorValue;
  bottom: UIColorValue;
}

export type UIBackground =
  | UISolidBackground
  | UIGradientBackground
  | UIThemeValue<UISolidBackground | UIGradientBackground>;

export function rgba(r: number, g: number, b: number, a = 1): UIColor {
  return { r, g, b, a };
}

export function lightDark<T>(light: T, dark: T): UIThemeValue<T> {
  return { type: "theme", light, dark };
}

export function solid(color: UIColorValue): UISolidBackground {
  return { type: "solid", color };
}

export function gradient(top: UIColorValue, bottom: UIColorValue): UIGradientBackground {
  return { type: "gradient", top, bottom };
}

// ---------------------------------------------------------------------------
// Animation / transition config
// ---------------------------------------------------------------------------

export interface TweenConfig {
  type?: "tween";
  duration: number; // ms
  easing: (t: number) => number;
  delay?: number;
}

export interface SpringConfig {
  type: "spring";
  response?: number; // seconds, lower = snappier
  delay?: number;
}

export type MotionConfig = TweenConfig | SpringConfig;

export type AnimateConfig = Record<string, MotionConfig>;

export function spring(response = 0.32, delay?: number): SpringConfig {
  return { type: "spring", response, delay };
}

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
  borderColor?: UIColorValue;
  borderWidth?: number;
  borderRadius?: number;
  opacity?: number;
  scale?: number; // visual scale (1.0 = normal, 0.95 = slightly smaller)
}

// ---------------------------------------------------------------------------
// Intrinsic element prop types
// ---------------------------------------------------------------------------

export interface BoxElementProps {
  key?: string | number;
  direction?: "row" | "col";
  gap?: number;
  padding?: UIEdges | number;
  align?: "start" | "center" | "end" | "stretch";
  justifyContent?: "start" | "center" | "end" | "space-between" | "space-around";
  flexGrow?: number;
  flexShrink?: number;
  background?: UIBackground;
  borderRadius?: number;
  borderWidth?: number;
  borderColor?: UIColorValue;
  opacity?: number;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  overflow?: "visible" | "hidden" | "scroll";
  position?: "relative" | "absolute" | "fixed";
  /** Anchor-relative placement for absolute children (e.g. submenu to right of trigger) */
  placement?:
    | "right-start"
    | "right-end"
    | "left-start"
    | "left-end"
    | "bottom-start"
    | "top-start";
  /** Auto-clamp position to stay within viewport bounds */
  contain?: "viewport";
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
  transition?: Record<string, MotionConfig>;
  // Event handlers
  onClick?: UIEventHandler;
  onPointerDown?: UIEventHandler;
  onPointerUp?: UIEventHandler;
  onHoverEnter?: (node: SceneNode) => void;
  onHoverLeave?: (node: SceneNode) => void;
  onLayout?: (node: SceneNode) => void;
  // Draggable
  draggable?: boolean;
  onDrag?: UIDragHandler;
  children?: unknown;
}

export interface TextElementProps {
  key?: string | number;
  fontSize: number;
  color: UIColorValue;
  opacity?: number;
  maxWidth?: number;
  children?: string;
}

export interface IconElementProps {
  key?: string | number;
  /** Raw SVG string. Provide either `svg` or `icon`, not both. */
  svg?: string;
  /** React icon component (e.g. from iconoir-react). Converted to SVG string automatically. */
  icon?: ReactIconComponent;
  size: number;
  tint?: UIColorValue;
  opacity?: number;
  animate?: AnimateConfig;
}

export interface AnchorElementProps {
  key?: string | number;
  entityId: string;
  edge?: "top" | "bottom" | "left" | "right" | "center";
  offset?: { x: number; y: number };
  children?: unknown;
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
