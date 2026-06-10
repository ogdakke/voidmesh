import type { ShaderCanvasEntity, ShaderParams, ShaderType } from "#types/canvas.ts";
import { isGifEntity, isVideoEntity } from "#types/canvas.ts";
import type { GpuColorConfig } from "./gpu-color-space.ts";
import type { VideoExportOptions } from "./video-exporter.ts";

export type ExportMediaSnapshot =
  | {
      type: "video";
      blob: Blob;
      width: number;
      height: number;
      duration: number;
      fps: number | null;
      hasAudio: boolean;
    }
  | {
      type: "gif";
      blob: Blob;
      width: number;
      height: number;
      duration: number;
      fps: number;
    };

export interface ExportEntitySnapshot {
  id: string;
  name: string;
  originalSize: { width: number; height: number };
  shaderType: ShaderType;
  shaderParams: ShaderParams;
  mediaSource: ExportMediaSnapshot;
}

export interface ExportJobSnapshot {
  entity: ExportEntitySnapshot;
  options: VideoExportOptions;
  colorConfig?: Pick<
    GpuColorConfig,
    "supportsP3" | "canvasFormat" | "canvasColorSpace" | "intermediateFormat" | "textureColorSpace"
  >;
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
        width: entity.originalSize.width,
        height: entity.originalSize.height,
        duration: entity.mediaSource.duration,
        fps: entity.mediaSource.fps,
        hasAudio: entity.mediaSource.hasAudio,
      }
    : {
        type: "gif",
        blob: entity.mediaSource.blob,
        width: entity.originalSize.width,
        height: entity.originalSize.height,
        duration: entity.mediaSource.duration,
        fps: entity.mediaSource.fps,
      };

  return {
    entity: {
      id: entity.id,
      name: entity.name,
      originalSize: { ...entity.originalSize },
      shaderType: entity.shaderType,
      shaderParams: structuredClone(entity.shaderParams),
      mediaSource,
    },
    options: structuredClone(options),
    colorConfig: colorConfig
      ? {
          supportsP3: colorConfig.supportsP3,
          canvasFormat: colorConfig.canvasFormat,
          canvasColorSpace: colorConfig.canvasColorSpace,
          intermediateFormat: colorConfig.intermediateFormat,
          textureColorSpace: colorConfig.textureColorSpace,
        }
      : undefined,
  };
}
