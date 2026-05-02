import clsx from "clsx";
import type { ComponentProps, ReactNode } from "react";
import "./button-group.css";

interface ButtonGroupProps extends ComponentProps<"div"> {
  orientation?: "horizontal" | "vertical";
}

export function ButtonGroup({ orientation = "horizontal", className, ...props }: ButtonGroupProps) {
  return (
    <div
      {...props}
      role={props.role ?? "group"}
      className={clsx("button-group", className)}
      data-orientation={orientation}
    />
  );
}

interface ButtonGroupSeparatorProps extends ComponentProps<"div"> {
  orientation?: "horizontal" | "vertical";
}

export function ButtonGroupSeparator({
  orientation,
  className,
  ...props
}: ButtonGroupSeparatorProps) {
  return (
    <div
      {...props}
      role="separator"
      aria-orientation={orientation}
      className={clsx("button-group-separator", className)}
      data-orientation={orientation}
    />
  );
}

interface ButtonGroupTextProps extends ComponentProps<"span"> {
  children: ReactNode;
}

export function ButtonGroupText({ className, ...props }: ButtonGroupTextProps) {
  return <span {...props} className={clsx("button-group-text", className)} />;
}
