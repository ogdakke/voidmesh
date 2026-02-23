import { Toast } from "@base-ui/react/toast";
import { Xmark } from "iconoir-react";
import "./toast.css";
import type { PropsWithChildren } from "react";
import { toastManager } from "./toast-manager.ts";

export function ToastProvider({ children }: PropsWithChildren) {
  return (
    <Toast.Provider toastManager={toastManager} timeout={5000}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="toast_viewport">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root key={toast.id} toast={toast} className="toast_root">
      <Toast.Content className="toast_content">
        <Toast.Title className="toast_title" />
        <Toast.Description className="toast_description" />
        <Toast.Close className="toast_close" aria-label="Close">
          <Xmark width={16} height={16} />
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ));
}
