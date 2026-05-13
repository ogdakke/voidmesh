/**
 * Export Format Configurations
 *
 * Defines supported export formats, quality presets, and encoding helpers.
 */

import { config } from "#config";

// ============================================================================
// Types
// ============================================================================

export type ImageExportFormat = "png" | "jpeg";

export interface ImageExportOptions {
  format: ImageExportFormat;
  /** JPEG quality 0–1 (ignored for PNG) */
  quality: number;
}

export const IMAGE_FORMAT_OPTIONS: {
  value: ImageExportFormat;
  label: string;
  subLabel?: string;
}[] = [
  { value: "png", label: "PNG", subLabel: "Larger, lossless" },
  { value: "jpeg", label: "JPEG", subLabel: "Smaller, lossy" },
];

export function imageExportOptionsForFormat(format: ImageExportFormat): ImageExportOptions {
  return { format, quality: config.imageExporting.quality[format] };
}

export type ExportFormat = "mp4" | "gif" | "mov";

export type QualityPreset = "high" | "medium" | "low";

export type ResolutionPreset = "original" | "1080p" | "720p" | "480p";

export type GifDitherMode = "floyd_steinberg" | "none";

export interface FormatConfig {
  extension: string;
  mimeType: string;
  supportsAudio: boolean;
}

export interface QualityConfig {
  /** Multiplier applied to auto-calculated bitrate (higher = better quality, larger file) */
  bitrateFactor: number;
}

export interface GifConfig {
  /** Maximum FPS for GIF (lower = smaller file) */
  maxFps: number;
  /** Maximum width (maintains aspect ratio) */
  maxWidth: number;
  /** Dither algorithm */
  dither: GifDitherMode;
  /** Max colors in palette (lower = smaller file, default 128) */
  maxColors: number;
}

// ============================================================================
// Format Configurations
// ============================================================================

export const formatConfigs: Record<ExportFormat, FormatConfig> = {
  mp4: {
    extension: "mp4",
    mimeType: "video/mp4",
    supportsAudio: true,
  },
  mov: {
    extension: "mov",
    mimeType: "video/quicktime",
    supportsAudio: true,
  },
  gif: {
    extension: "gif",
    mimeType: "image/gif",
    supportsAudio: false,
  },
};

export const qualityConfigs: Record<QualityPreset, QualityConfig> = {
  high: { bitrateFactor: 1.5 },
  medium: { bitrateFactor: 1.0 },
  low: { bitrateFactor: 0.6 },
};

export const defaultGifConfig: GifConfig = {
  maxFps: 30,
  maxWidth: 256,
  dither: "floyd_steinberg",
  maxColors: 128,
};

export const resolutionPresets: Record<
  Exclude<ResolutionPreset, "original">,
  { width: number; height: number }
> = {
  "1080p": { width: 1920, height: 1080 },
  "720p": { width: 1280, height: 720 },
  "480p": { width: 854, height: 480 },
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get MIME type for an image export format
 */
export function getImageMimeType(format: ImageExportFormat): "image/png" | "image/jpeg" {
  return format === "jpeg" ? "image/jpeg" : "image/png";
}

/**
 * Get file extension for an image export format
 */
export function getImageExtension(format: ImageExportFormat): "png" | "jpg" {
  return format === "jpeg" ? "jpg" : "png";
}

/**
 * Get the appropriate file extension for a format
 */
export function getFormatExtension(format: ExportFormat): string {
  return formatConfigs[format].extension;
}

/**
 * Get MIME type for a format
 */
export function getFormatMimeType(format: ExportFormat): string {
  return formatConfigs[format].mimeType;
}

/**
 * Check if a format supports audio
 */
export function formatSupportsAudio(format: ExportFormat): boolean {
  return formatConfigs[format].supportsAudio;
}

/**
 * Calculate target resolution maintaining aspect ratio
 */
export function calculateTargetResolution(
  sourceWidth: number,
  sourceHeight: number,
  preset: ResolutionPreset | { width: number; height: number },
): { width: number; height: number } {
  if (preset === "original") {
    // Ensure dimensions are even (required by most codecs)
    return {
      width: Math.floor(sourceWidth / 2) * 2,
      height: Math.floor(sourceHeight / 2) * 2,
    };
  }

  const target = typeof preset === "string" ? resolutionPresets[preset] : preset;
  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = target.width / target.height;

  let width: number;
  let height: number;

  if (sourceAspect > targetAspect) {
    width = Math.min(sourceWidth, target.width);
    height = Math.round(width / sourceAspect);
  } else {
    height = Math.min(sourceHeight, target.height);
    width = Math.round(height * sourceAspect);
  }

  // Ensure even dimensions
  return {
    width: Math.floor(width / 2) * 2,
    height: Math.floor(height / 2) * 2,
  };
}
