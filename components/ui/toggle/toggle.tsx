import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import clsx from "clsx";
import "./toggle.css";

interface ToggleProps extends React.ComponentPropsWithoutRef<"button"> {
  /**
   * The visual style of the toggle.
   * @default 'default'
   */
  variant?: "default" | "outline";
  /**
   * Whether the toggle is currently pressed.
   * This is the controlled counterpart of `defaultPressed`.
   */
  pressed?: boolean;
  /**
   * Whether the toggle is currently pressed.
   * This is the uncontrolled counterpart of `pressed`.
   * @default false
   */
  defaultPressed?: boolean;
  /**
   * Callback fired when the pressed state changes.
   */
  onPressedChange?: BaseToggle.Props["onPressedChange"];
  /**
   * A unique string that identifies the toggle in a toggle group.
   */
  value?: string;
}

export function Toggle({ variant, className, ...props }: ToggleProps) {
  return (
    <BaseToggle
      {...props}
      className={clsx("ui-toggle", className)}
      data-variant={variant || "default"}
    />
  );
}
