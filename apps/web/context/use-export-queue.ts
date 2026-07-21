import { createContext, use } from "react";
import type { ExportQueueContextValue } from "./export-queue-context.tsx";

export const ExportQueueContext = createContext<ExportQueueContextValue | null>(null);

export function useExportQueue(): ExportQueueContextValue {
  const context = use(ExportQueueContext);
  if (!context) {
    throw new Error("useExportQueue must be used within an ExportQueueProvider");
  }
  return context;
}
