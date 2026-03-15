// oxlint-disable react/only-export-components -- compound component: sub-components are internal, only the namespace object is exported
import type {
  DrawerPopupProps,
  DrawerContentProps,
  DrawerTitleProps,
  DrawerCloseProps,
} from "@base-ui/react/drawer";
import { Drawer as BaseDrawer } from "@base-ui/react/drawer";
import clsx from "clsx";
import "./drawer.css";

interface DrawerProps extends DrawerPopupProps {
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

const Content = ({ children, ...props }: DrawerContentProps) => {
  return (
    <BaseDrawer.Content {...props} className={clsx("drawer-content", props.className)}>
      {children}
    </BaseDrawer.Content>
  );
};

const Title = ({ children, ...props }: DrawerTitleProps) => {
  return (
    <BaseDrawer.Title {...props} className={clsx("drawer-title", props.className)}>
      {children}
    </BaseDrawer.Title>
  );
};

const Close = ({ children, ...props }: DrawerCloseProps) => {
  return (
    <BaseDrawer.Close {...props} className={clsx("drawer-close", props.className)}>
      {children}
    </BaseDrawer.Close>
  );
};

export const Drawer = {
  Root: BaseDrawer.Root,
  Trigger: BaseDrawer.Trigger,
  Title,
  Close,
  Popup,
  Content,
  Provider: BaseDrawer.Provider,
  Indent: BaseDrawer.Indent,
  IndentBackground: BaseDrawer.IndentBackground,
};
