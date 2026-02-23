/**
 * Context for managing shared video export options across the app
 * The actual export logic is handled by ExportQueueContext
 */

import { useState, type PropsWithChildren } from "react";
import { VideoExportContext } from "./use-video-export.ts";
import {
  type ExportFormat,
  type QualityPreset,
  type ResolutionPreset,
  type GifDitherMode,
} from "#renderer/video-exporter.ts";
import { config } from "#config";
import { isGifEntity, isVideoEntity, type ShaderCanvasEntity } from "#types/canvas.ts";
import { preloadFFmpeg } from "#lib/ffmpeg-service.ts";

/** Global export settings state */
export interface ExportOptionsState {
  format: ExportFormat;
  quality: QualityPreset;
  fps: number;
  includeAudio: boolean;
  advanced: {
    resolution: ResolutionPreset;
    crf?: number;
    bitrate?: number;
    twoPass: boolean;
    gifMaxWidth: number;
    gifDither: GifDitherMode;
  };
}

const DEFAULT_EXPORT_OPTIONS: ExportOptionsState = {
  format: "mp4",
  quality: "high",
  fps: config.videoExporting.defaults.fps,
  includeAudio: true,
  advanced: {
    resolution: "original",
    crf: undefined,
    bitrate: undefined,
    twoPass: false,
    gifMaxWidth: 256,
    gifDither: "floyd_steinberg",
  },
};

/** Type for partial updates to export options (deep partial for advanced) */
export type ExportOptionsUpdate = Partial<Omit<ExportOptionsState, "advanced">> & {
  advanced?: Partial<ExportOptionsState["advanced"]>;
};

export interface VideoExportContextValue {
  exportOptions: ExportOptionsState;
  updateExportOptions: (options: ExportOptionsUpdate) => void;
  /** Preload FFmpeg in background to reduce export wait time. Call on hover over export button. */
  preloadFFmpeg: () => void;
  /** Sync export FPS with the selected entity's native frame rate (if available) */
  syncFpsWithEntity: (entity: ShaderCanvasEntity | null) => void;
}

export function VideoExportProvider({ children }: PropsWithChildren) {
  const [exportOptions, setExportOptions] = useState<ExportOptionsState>(DEFAULT_EXPORT_OPTIONS);

  const updateExportOptions = (options: ExportOptionsUpdate) => {
    setExportOptions((prev) => ({
      ...prev,
      ...options,
      advanced: {
        ...prev.advanced,
        ...options.advanced,
      },
    }));
  };

  const syncFpsWithEntity = (entity: ShaderCanvasEntity | null) => {
    if (!entity) return;

    let fps: number | null = null;
    if (isVideoEntity(entity)) {
      fps = entity.mediaSource.fps;
    } else if (isGifEntity(entity)) {
      fps = entity.mediaSource.fps;
    }

    if (fps !== null && fps > 0) {
      // Only update if different from current to avoid unnecessary re-renders
      setExportOptions((prev) => {
        if (prev.fps === fps) return prev;
        return { ...prev, fps };
      });
    }
  };

  return (
    <VideoExportContext.Provider
      value={{
        exportOptions,
        updateExportOptions,
        preloadFFmpeg,
        syncFpsWithEntity,
      }}
    >
      {children}
    </VideoExportContext.Provider>
  );
}
