import { type PropsWithChildren } from "react";
import { Drawer } from "../drawer";
import { useColorPicker } from "./use-color-picker";

export function DrawerTrigger({ children }: PropsWithChildren) {
  const {
    meta: { isDisabled },
  } = useColorPicker();

  return (
    <Drawer.Trigger
      className="color-picker"
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
