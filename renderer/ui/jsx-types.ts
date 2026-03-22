// ---------------------------------------------------------------------------
// Canvas UI JSX Intrinsic Element Types
// ---------------------------------------------------------------------------
//
// Augments React's JSX namespace so TypeScript recognizes <ui-box>, <ui-text>,
// <ui-icon>, and <ui-anchor> as valid JSX elements in .tsx files.
//

import type {
  BoxElementProps,
  TextElementProps,
  IconElementProps,
  AnchorElementProps,
} from "./elements.ts";

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "ui-box": BoxElementProps & { children?: React.ReactNode };
      "ui-text": TextElementProps & { children?: string };
      "ui-icon": IconElementProps;
      "ui-anchor": AnchorElementProps & { children?: React.ReactNode };
    }
  }
}
