// ---------------------------------------------------------------------------
// Canvas UI Primitives
// ---------------------------------------------------------------------------
//
// Thin wrapper components over the ui-* intrinsic elements.
// These provide a clean PascalCase API and avoid direct use of prefixed names.
//

import type { ReactNode } from "react";
import type {
  BoxElementProps,
  TextElementProps,
  IconElementProps,
  AnchorElementProps,
} from "./elements.ts";

// Ensure JSX type augmentation is loaded
import "./jsx-types.ts";

export function Box(props: BoxElementProps & { children?: ReactNode }) {
  return <ui-box {...props} />;
}

export function Text(props: TextElementProps & { children?: string }) {
  return <ui-text {...props} />;
}

export function Icon(props: IconElementProps) {
  return <ui-icon {...props} />;
}

export function Anchor(props: AnchorElementProps & { children?: ReactNode }) {
  return <ui-anchor {...props} />;
}
