import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { logger } from "#lib/client.logger.ts";
import { toastManager } from "#ui/toast/toast-manager.ts";

const UPDATE_TOAST_ID = "pwa-update-available";
const UPDATE_CHECK_THROTTLE_MS = 60_000;

export function PwaUpdateManager() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | undefined>(
    undefined,
  );
  const lastUpdateCheckAtRef = useRef(0);
  const hasUpdateToastRef = useRef(false);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swScriptUrl, swRegistration) {
      setRegistration(swRegistration);
    },
    onRegisterError(error) {
      logger.error("[PWA] Service worker registration failed", error);
    },
  });

  const clearUpdatePrompt = useEffectEvent(() => {
    hasUpdateToastRef.current = false;
    setNeedRefresh(false);
  });

  const applyUpdate = useEffectEvent(() => {
    clearUpdatePrompt();
    void updateServiceWorker(true);
  });

  useEffect(() => {
    if (!needRefresh) {
      if (hasUpdateToastRef.current) {
        hasUpdateToastRef.current = false;
        toastManager.close(UPDATE_TOAST_ID);
      }
      return;
    }

    if (hasUpdateToastRef.current) return;

    hasUpdateToastRef.current = true;
    toastManager.add({
      id: UPDATE_TOAST_ID,
      title: "Update available",
      description: "A new version of Voidmesh is ready. Reload to update.",
      timeout: 0,
      onClose: clearUpdatePrompt,
      actionProps: {
        children: "Update now",
        onClick: applyUpdate,
      },
    });
  }, [needRefresh]);

  const checkForUpdates = useEffectEvent(() => {
    if (!registration || document.visibilityState !== "visible") return;

    const now = Date.now();
    if (now - lastUpdateCheckAtRef.current < UPDATE_CHECK_THROTTLE_MS) return;

    lastUpdateCheckAtRef.current = now;
    void registration.update();
  });

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkForUpdates();
      }
    };

    window.addEventListener("focus", checkForUpdates);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", checkForUpdates);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return null;
}
