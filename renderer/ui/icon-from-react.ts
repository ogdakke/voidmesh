import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ComponentType } from "react";

/**
 * Convert a React icon component (e.g. from iconoir-react) to a static SVG
 * string for use with the canvas UI `<icon>` element.
 *
 * Call at module scope — the result is a static string, no per-frame cost.
 */
export function iconSvgFrom(
  component: ComponentType<Record<string, unknown>>,
  props?: Record<string, unknown>,
): string {
  return renderToStaticMarkup(createElement(component, props));
}
