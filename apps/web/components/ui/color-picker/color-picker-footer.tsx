import type { ComponentProps } from "react";

export function Footer({ children, className, ...props }: ComponentProps<"div">) {
  return (
    <div {...props} className={`color-picker-footer ${className ?? ""}`}>
      {children}
    </div>
  );
}
