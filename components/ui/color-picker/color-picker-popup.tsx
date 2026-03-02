import { Popover } from "@base-ui/react/popover";
import { type PropsWithChildren } from "react";
import { useColorPicker } from "./use-color-picker";

export function Trigger({ children }: PropsWithChildren) {
  const {
    meta: { isDisabled },
  } = useColorPicker();

  return (
    <Popover.Trigger
      className="color-picker"
      disabled={isDisabled}
      data-disabled={isDisabled || undefined}
    >
      {children}
    </Popover.Trigger>
  );
}

export function Popup({ children }: PropsWithChildren) {
  return (
    <Popover.Portal>
      <Popover.Positioner sideOffset={8} align="start">
        <Popover.Popup className="color-picker-popup">{children}</Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}
