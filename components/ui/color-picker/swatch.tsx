import type { ComponentProps } from "react";

interface SwatchProps extends ComponentProps<"span"> {
  color: string;
}

export function Swatch({ color, className, ...props }: SwatchProps) {
  return (
    <span
      {...props}
      className={`color-picker__swatch ${className ?? ""}`}
      style={{ ...props.style, background: color }}
    />
  );
}
