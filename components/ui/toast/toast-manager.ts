import { Toast } from "@base-ui/react/toast";
import { createEnum } from "#types/index.ts";

export const ToastType = createEnum({
  primary: "primary",
  secondary: "secondary",
  destructive: "destructive",
});

export const toastManager = Toast.createToastManager<{
  position: "top-center" | "bottom-center";
}>();
