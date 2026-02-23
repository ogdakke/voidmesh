// oxlint-disable react/only-export-components -- compound component: sub-components are internal, only the namespace object is exported
import type { DrawerPopupProps, DrawerContentProps } from "@base-ui/react/drawer";
import { DrawerPreview as BaseDrawer } from "@base-ui/react/drawer";
import clsx from "clsx";
import { type PropsWithChildren } from "react";
import "./drawer.css";

interface DrawerProps extends PropsWithChildren<DrawerPopupProps> {
  handle?: boolean;
}

const Popup = ({ children, handle = true, ...props }: DrawerProps) => {
  return (
    <BaseDrawer.Portal>
      <BaseDrawer.Backdrop className="drawer-overlay" />
      <BaseDrawer.Viewport className="drawer-viewport">
        <BaseDrawer.Popup {...props} className={clsx("drawer-popup", props.className)}>
          {handle ? <div className="drawer-handle" /> : null}
          {children}
        </BaseDrawer.Popup>
      </BaseDrawer.Viewport>
    </BaseDrawer.Portal>
  );
};

const Content = ({ children, ...props }: PropsWithChildren<DrawerContentProps>) => {
  return (
    <BaseDrawer.Content {...props} className={clsx("drawer-content", props.className)}>
      {children}
    </BaseDrawer.Content>
  );
};

export const Drawer = {
  Root: BaseDrawer.Root,
  Trigger: BaseDrawer.Trigger,
  Popup,
  Content,
  Provider: BaseDrawer.Provider,
  Indent: BaseDrawer.Indent,
  IndentBackground: BaseDrawer.IndentBackground,
  Close: BaseDrawer.Close,
};
