import { Button as BaseButton } from "@base-ui/react/button";
import clsx from "clsx";
import "./button.css";

interface ButtonProps extends React.ComponentPropsWithoutRef<"button"> {
  /**
   * The visual style of the button.
   * @default 'primary'
   */
  variant?: "primary" | "secondary" | "quiet" | "destructive";
  /**
   * The size of the button.
   * @default 'md'
   */
  size?: "sm" | "md" | "lg";
  /**
   * Icon-only button — forces 1:1 aspect ratio and round shape.
   */
  icon?: boolean;
  /**
   * Whether the button is in a pending/loading state.
   */
  isPending?: boolean;
}

export function Button({ variant, size, icon, isPending, children, ...props }: ButtonProps) {
  return (
    <BaseButton
      {...props}
      className={clsx("ui-button", props.className)}
      data-variant={variant || "primary"}
      data-size={size || "md"}
      data-icon={icon || undefined}
      data-pending={isPending || undefined}
    >
      {children}
    </BaseButton>
  );
}
