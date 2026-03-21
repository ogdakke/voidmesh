// ---------------------------------------------------------------------------
// Custom JSX Runtime for Canvas UI
// ---------------------------------------------------------------------------
//
// This is NOT React. It produces UIElement descriptors that feed into
// the canvas UI reconciler and renderer.
//
// Usage: Add `/** @jsxImportSource ./jsx */` at the top of .tsx files
// in renderer/ui/ that should produce canvas UI elements instead of React.
//

import type {
  UIElement,
  ComponentFn,
  BoxElementProps,
  TextElementProps,
  IconElementProps,
  AnchorElementProps,
} from "../elements.ts";

// ---------------------------------------------------------------------------
// JSX namespace — TypeScript uses this for type-checking JSX expressions
// ---------------------------------------------------------------------------

export namespace JSX {
  export type Element = UIElement;

  export interface IntrinsicElements {
    box: BoxElementProps;
    text: TextElementProps;
    icon: IconElementProps;
    anchor: AnchorElementProps;
  }

  export interface ElementChildrenAttribute {
    children: object;
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export const Fragment = "__fragment__" as const;

function normalizeChildren(rawChildren: unknown): UIElement[] {
  if (rawChildren == null) return [];
  if (Array.isArray(rawChildren)) {
    const result: UIElement[] = [];
    for (const child of rawChildren) {
      if (child == null || child === false || child === true) continue;
      if (Array.isArray(child)) {
        for (const nested of child) {
          if (nested != null && nested !== false && nested !== true) {
            result.push(typeof nested === "string" ? textElement(nested) : (nested as UIElement));
          }
        }
      } else if (typeof child === "string") {
        result.push(textElement(child));
      } else {
        result.push(child as UIElement);
      }
    }
    return result;
  }
  if (typeof rawChildren === "string") {
    return [textElement(rawChildren)];
  }
  return [rawChildren as UIElement];
}

function textElement(content: string): UIElement {
  return { type: "__text_content__", props: { content }, key: null };
}

export function jsx(
  type: string | ComponentFn | typeof Fragment,
  props: Record<string, unknown>,
  key?: string | number,
): UIElement {
  const { children: rawChildren, ...rest } = props;
  const children = normalizeChildren(rawChildren);

  // Fragment: wrap children in a passthrough element
  if (type === Fragment) {
    return {
      type: "__fragment__",
      props: children.length > 0 ? { children } : {},
      key: key ?? null,
    };
  }

  // For text elements, extract string children as content
  if (type === "text" && children.length === 1 && children[0]!.type === "__text_content__") {
    rest["content"] = children[0]!.props["content"];
    return { type, props: rest, key: key ?? (rest["key"] as string | number | null) ?? null };
  }

  // For elements with children, attach them
  if (children.length > 0) {
    rest["children"] = children;
  }

  return { type, props: rest, key: key ?? (rest["key"] as string | number | null) ?? null };
}

export function jsxs(
  type: string | ComponentFn | typeof Fragment,
  props: Record<string, unknown>,
  key?: string | number,
): UIElement {
  return jsx(type, props, key);
}
