import clsx from "clsx";
import { useEffect, useRef, type DialogHTMLAttributes, type PropsWithChildren } from "react";
import "./modal.css";

export interface ModalProps extends DialogHTMLAttributes<HTMLDialogElement> {
  open: boolean;
}

export function Modal({ open, ...props }: PropsWithChildren<ModalProps>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) {
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [open]);
  return (
    // oxlint-disable
    <dialog
      ref={dialogRef}
      onClose={props.onClose}
      onCancel={props.onCancel}
      closedby={props.closedby || "any"}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          e.currentTarget.close();
        }
      }}
      {...props}
      className={clsx("modal", props.className)}
    >
      {props.children}
    </dialog>
  );
}
