import { createContext, use } from "react";
import type { UpscaleQueueContextValue } from "./upscale-queue-context.tsx";

export const UpscaleQueueContext = createContext<UpscaleQueueContextValue | null>(null);

export function useUpscaleQueue(): UpscaleQueueContextValue {
  const context = use(UpscaleQueueContext);
  if (!context) {
    throw new Error("useUpscaleQueue must be used within an UpscaleQueueProvider");
  }
  return context;
}
