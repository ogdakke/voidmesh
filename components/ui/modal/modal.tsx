// oxlint-disable react/only-export-components -- compound component: sub-components are internal, only the namespace object is exported

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import clsx from "clsx";
import { type ComponentProps, type ComponentPropsWithoutRef, type PropsWithChildren } from "react";
import "./modal.css";

export interface ModalProps extends Omit<
  ComponentPropsWithoutRef<typeof BaseDialog.Popup>,
  "children"
> {
  open: boolean;
  onClose: () => void;
}

function Root({ open, onClose, children, className, ...props }: PropsWithChildren<ModalProps>) {
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="modal-backdrop" />
        <BaseDialog.Viewport className="modal-viewport">
          <BaseDialog.Popup {...props} className={clsx("modal", className)}>
            {children}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

function Content({ children, className, ...props }: PropsWithChildren<ComponentProps<"div">>) {
  return (
    <div {...props} className={clsx("modal-content", className)}>
      {children}
    </div>
  );
}

export const Modal = {
  Root,
  Content,
  Close: BaseDialog.Close,
};
