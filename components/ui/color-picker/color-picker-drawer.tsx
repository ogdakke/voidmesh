import { type PropsWithChildren } from "react";
import { Drawer } from "../drawer";
import { useColorPicker } from "./use-color-picker";
import type { DrawerTriggerProps } from "@base-ui/react";
import clsx from "clsx";

export function DrawerTrigger({ children, ...props }: DrawerTriggerProps) {
  const {
    meta: { isDisabled },
  } = useColorPicker();

  return (
    <Drawer.Trigger
      {...props}
      className={clsx("color-picker", props.className)}
      disabled={isDisabled}
      data-disabled={isDisabled || undefined}
    >
      {children}
    </Drawer.Trigger>
  );
}

export function DrawerPopup({ children }: PropsWithChildren) {
  return (
    <Drawer.Popup className="color-picker__drawer">
      <Drawer.Content className="color-picker__drawer-body">{children}</Drawer.Content>
    </Drawer.Popup>
  );
}
