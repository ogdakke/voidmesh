import type { ShaderCanvasEntity, ShaderParams, ShaderType } from "#types/canvas.ts";
import { isGifEntity, isVideoEntity } from "#types/canvas.ts";
import type { GpuColorConfig } from "./gpu-color-space.ts";
import type { VideoExportOptions } from "./video-exporter.ts";

export type ExportMediaSnapshot =
  | {
      type: "video";
      blob: Blob;
      hasAudio: boolean;
    }
  | {
      type: "gif";
      blob: Blob;
    };

export interface ExportEntitySnapshot {
  id: string;
  shaderType: ShaderType;
  shaderParams: ShaderParams;
  mediaSource: ExportMediaSnapshot;
}

export interface ExportJobSnapshot {
  entity: ExportEntitySnapshot;
  options: VideoExportOptions;
  requiresP3?: boolean;
}

export function createExportJobSnapshot(
  entity: ShaderCanvasEntity,
  options: VideoExportOptions,
  colorConfig?: GpuColorConfig,
): ExportJobSnapshot {
  if (!isVideoEntity(entity) && !isGifEntity(entity)) {
    throw new Error("Entity is not a video or animated GIF");
  }

  const mediaSource: ExportMediaSnapshot = isVideoEntity(entity)
    ? {
        type: "video",
        blob: entity.mediaSource.blob,
        hasAudio: entity.mediaSource.hasAudio,
      }
    : {
        type: "gif",
        blob: entity.mediaSource.blob,
      };

  return {
    entity: {
      id: entity.id,
      shaderType: entity.shaderType,
      shaderParams: structuredClone(entity.shaderParams),
      mediaSource,
    },
    options: structuredClone(options),
    ...(colorConfig?.supportsP3 ? { requiresP3: true } : {}),
  };
}
