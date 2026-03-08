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
        <ToastViewport />
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastViewport() {
  const { toasts } = Toast.useToastManager();
  const defaultPosition = "top-center";
  const viewportPosition = toasts[0]?.data?.position ?? defaultPosition;

  return (
    <Toast.Viewport className="toast_viewport" data-position={viewportPosition}>
      {toasts.map((toast) => {
        const pos = toast.data?.position ?? defaultPosition;
        return (
          <Toast.Root
            key={toast.id}
            toast={toast}
            className="toast_root"
            data-position={pos}
            swipeDirection={pos === "top-center" ? "up" : ["down", "right"]}
          >
            <Toast.Content className="toast_content">
              <Toast.Title className="toast_title" />
              <Toast.Description className="toast_description" />
              <Toast.Action className="toast_action" />
              <Toast.Close className="toast_close" aria-label="Close">
                <Xmark width={16} height={16} />
              </Toast.Close>
            </Toast.Content>
          </Toast.Root>
        );
      })}
    </Toast.Viewport>
  );
}
