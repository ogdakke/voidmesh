import { useRef, type ComponentProps } from "react";
import { useColorPicker, useRegisterElement } from "./use-color-picker";

interface SwatchProps extends ComponentProps<"span"> {
  /** Override color (for non-context usage like Suspense fallback) */
  color?: string;
}

export function Swatch({ color, className, style, ...props }: SwatchProps) {
  return (
    <span
      {...props}
      className={`color-picker__swatch ${className ?? ""}`}
      style={{ ...style, "--swatch-bg": color } as any}
    />
  );
}

/** Context-aware swatch that reads cssValue from the color picker */
export function ContextSwatch({ className, style, ...props }: ComponentProps<"span">) {
  const {
    state: { cssValue },
  } = useColorPicker();

  const ref = useRef<HTMLSpanElement>(null);

  // Register for imperative updates during scrubbing
  useRegisterElement("swatch", ref);

  return (
    <span
      ref={ref}
      {...props}
      className={`color-picker__swatch ${className ?? ""}`}
      style={{ ...style, "--swatch-bg": cssValue } as any}
    />
  );
}
