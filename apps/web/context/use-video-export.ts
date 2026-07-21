import { createContext, use } from "react";
import type { VideoExportContextValue } from "./video-export-context.tsx";

export const VideoExportContext = createContext<VideoExportContextValue | null>(null);

export function useVideoExportContext(): VideoExportContextValue {
  const context = use(VideoExportContext);
  if (!context) {
    throw new Error("useVideoExportContext must be used within a VideoExportProvider");
  }
  return context;
}
