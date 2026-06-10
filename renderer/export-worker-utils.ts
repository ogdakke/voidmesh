import { calculateVideoBitrate } from "#config";
import { calculateTargetResolution, defaultGifConfig, qualityConfigs } from "./export-formats.ts";
import type { VideoExportOptions } from "./video-exporter.ts";

export function getGifExportDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth = defaultGifConfig.maxWidth,
): { width: number; height: number } {
  let width = sourceWidth;
  let height = sourceHeight;
  if (width > maxWidth) {
    const scale = maxWidth / width;
    width = maxWidth;
    height = Math.round(sourceHeight * scale);
  }

  return {
    width: Math.floor(width / 2) * 2 || 2,
    height: Math.floor(height / 2) * 2 || 2,
  };
}

export function getGifFrameDelayCentiseconds(
  fps: number,
  accumulatedError: number,
): { delayCentiseconds: number; nextAccumulatedError: number } {
  const idealDelay = 100 / fps + accumulatedError;
  const delayCentiseconds = Math.max(1, Math.round(idealDelay));
  return {
    delayCentiseconds,
    nextAccumulatedError: idealDelay - delayCentiseconds,
  };
}

export function getVideoExportDimensions(
  sourceWidth: number,
  sourceHeight: number,
  options: VideoExportOptions,
): { width: number; height: number } {
  return calculateTargetResolution(
    sourceWidth,
    sourceHeight,
    options.advanced?.resolution ?? "original",
  );
}

export function getVideoExportBitrate(
  width: number,
  height: number,
  options: VideoExportOptions,
): number {
  const qualityFactor = qualityConfigs[options.quality ?? "high"].bitrateFactor;
  return (
    options.advanced?.bitrate ?? Math.round(calculateVideoBitrate(width, height) * qualityFactor)
  );
}
