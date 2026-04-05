import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { RegisterSWOptions } from "vite-plugin-pwa/types";

type MockPwaState = {
  registration?: ServiceWorkerRegistration;
  error?: unknown;
  updateServiceWorker: (reloadPage?: boolean) => Promise<void>;
  setNeedRefresh: Dispatch<SetStateAction<boolean>>;
  setOfflineReady: Dispatch<SetStateAction<boolean>>;
};

export const mockPwaState: MockPwaState = {
  registration: undefined,
  error: undefined,
  updateServiceWorker: async () => undefined,
  setNeedRefresh: () => undefined,
  setOfflineReady: () => undefined,
};

export function resetMockPwaState() {
  mockPwaState.registration = undefined;
  mockPwaState.error = undefined;
  mockPwaState.updateServiceWorker = async () => undefined;
  mockPwaState.setNeedRefresh = () => undefined;
  mockPwaState.setOfflineReady = () => undefined;
}

export function useRegisterSW(options?: RegisterSWOptions) {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);

  useEffect(() => {
    mockPwaState.setNeedRefresh = setNeedRefresh;
    mockPwaState.setOfflineReady = setOfflineReady;
  }, [setNeedRefresh, setOfflineReady]);

  useEffect(() => {
    options?.onRegisteredSW?.("/sw.js", mockPwaState.registration);
    if (mockPwaState.error) {
      options?.onRegisterError?.(mockPwaState.error);
    }
  }, [options]);

  return {
    needRefresh: [needRefresh, setNeedRefresh] as const,
    offlineReady: [offlineReady, setOfflineReady] as const,
    updateServiceWorker: mockPwaState.updateServiceWorker,
  };
}
