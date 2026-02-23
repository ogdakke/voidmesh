import clsx from "clsx";
import { NavArrowDown } from "iconoir-react";
import type { ComponentProps } from "react";
import "./native-select.css";

type NativeSelectProps = Omit<ComponentProps<"select">, "size"> & {
  size?: "sm" | "default";
  variant?: "default" | "quiet";
};

function NativeSelect({
  className,
  size = "default",
  variant = "default",
  ...props
}: NativeSelectProps) {
  return (
    <div
      data-slot="native-select-wrapper"
      data-size={size}
      data-variant={variant}
      className={clsx("native-select-wrapper", className)}
    >
      <select
        data-slot="native-select"
        data-size={size}
        data-variant={variant}
        className="native-select"
        {...props}
      />
      <NavArrowDown
        data-slot="native-select-icon"
        className="native-select-icon"
        aria-hidden="true"
      />
    </div>
  );
}

function NativeSelectOption({ ...props }: ComponentProps<"option">) {
  return <option data-slot="native-select-option" {...props} />;
}

function NativeSelectOptGroup({ className, ...props }: ComponentProps<"optgroup">) {
  return <optgroup data-slot="native-select-optgroup" className={clsx(className)} {...props} />;
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
export type { NativeSelectProps };
