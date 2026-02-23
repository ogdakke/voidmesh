/**
 * Export Format Configurations
 *
 * Defines supported export formats, quality presets, and ffmpeg argument builders.
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
}[] = [
  { value: "png", label: "PNG (larger)" },
  { value: "jpeg", label: "JPEG (smaller)" },
];

export function imageExportOptionsForFormat(format: ImageExportFormat): ImageExportOptions {
  return { format, quality: config.imageExporting.quality[format] };
}

export type ExportFormat = "mp4" | "webm" | "gif" | "mov";

export type QualityPreset = "high" | "medium" | "low";

export type ResolutionPreset = "original" | "1080p" | "720p" | "480p";

export type GifDitherMode = "bayer" | "floyd_steinberg" | "sierra2" | "none";

export interface FormatConfig {
  extension: string;
  mimeType: string;
  supportsAudio: boolean;
  /** Video codec for ffmpeg */
  videoCodec: string;
  /** Audio codec for ffmpeg (null if no audio support) */
  audioCodec: string | null;
  /** Additional ffmpeg output flags */
  outputFlags: string[];
}

export interface QualityConfig {
  /** CRF value for quality-based encoding (lower = better quality, higher file size) */
  crf: number;
  /** Fallback bitrate if CRF not supported */
  bitrateFactor: number;
}

export interface GifConfig {
  /** Maximum FPS for GIF (lower = smaller file) */
  maxFps: number;
  /** Maximum width (maintains aspect ratio) */
  maxWidth: number;
  /** Dither algorithm */
  dither: GifDitherMode;
  /** Stats mode for palette generation */
  statsMode: "full" | "diff";
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
    videoCodec: "libx264",
    audioCodec: "aac",
    outputFlags: ["-movflags", "+faststart", "-pix_fmt", "yuv420p"],
  },
  webm: {
    extension: "webm",
    mimeType: "video/webm",
    supportsAudio: true,
    videoCodec: "libvpx", // VP8 - VP9 has timestamp bugs in ffmpeg.wasm
    audioCodec: "libvorbis", // Vorbis pairs better with VP8
    outputFlags: ["-pix_fmt", "yuv420p"],
  },
  mov: {
    extension: "mov",
    mimeType: "video/quicktime",
    supportsAudio: true,
    videoCodec: "libx264",
    audioCodec: "aac",
    outputFlags: ["-pix_fmt", "yuv420p"],
  },
  gif: {
    extension: "gif",
    mimeType: "image/gif",
    supportsAudio: false,
    videoCodec: "gif",
    audioCodec: null,
    outputFlags: [],
  },
};

export const qualityConfigs: Record<QualityPreset, QualityConfig> = {
  high: { crf: 18, bitrateFactor: 1.5 },
  medium: { crf: 23, bitrateFactor: 1.0 },
  low: { crf: 28, bitrateFactor: 0.6 },
};

export const defaultGifConfig: GifConfig = {
  maxFps: 30,
  maxWidth: 256,
  dither: "floyd_steinberg",
  statsMode: "diff",
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
// FFmpeg Argument Builders
// ============================================================================

export interface FFmpegEncodeOptions {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  quality: QualityPreset;
  crf?: number;
  bitrate?: number;
  inputPattern: string;
  outputFile: string;
  audioInputFile?: string;
  twoPass?: boolean;
}

/**
 * Build ffmpeg arguments for video encoding (non-GIF formats)
 */
export function buildVideoEncodeArgs(options: FFmpegEncodeOptions): string[] {
  const config = formatConfigs[options.format];
  const qualityConfig = qualityConfigs[options.quality];

  const args: string[] = [
    // Input: image sequence with explicit start number for proper timestamps
    "-start_number",
    "0",
    "-framerate",
    options.fps.toString(),
    "-i",
    options.inputPattern,
  ];

  // Add audio input if provided and format supports it
  if (options.audioInputFile && config.supportsAudio) {
    args.push("-i", options.audioInputFile);
  }

  // Video codec
  args.push("-c:v", config.videoCodec);

  // Quality settings
  const crf = options.crf ?? qualityConfig.crf;

  if (options.format === "webm") {
    // VP8: constrained quality mode with -crf and -b:v 0
    // CRF must be within qmin/qmax range
    args.push("-crf", crf.toString(), "-b:v", "0");
    args.push("-qmin", "0", "-qmax", "50");
    // Speed up VP8 encoding for ffmpeg.wasm
    args.push("-deadline", "realtime", "-cpu-used", "5");
  } else if (options.bitrate) {
    // Explicit bitrate overrides CRF
    args.push("-b:v", `${options.bitrate}k`);
  } else {
    // H.264/H.265 CRF mode
    args.push("-crf", crf.toString());
  }

  // Audio settings
  if (options.audioInputFile && config.supportsAudio && config.audioCodec) {
    args.push("-c:a", config.audioCodec, "-b:a", "192k", "-shortest");
  }

  // Output format flags
  args.push(...config.outputFlags);

  // Explicit output framerate for proper timing
  args.push("-r", options.fps.toString());

  // Output file
  args.push("-y", options.outputFile);

  return args;
}

export interface FFmpegGifOptions {
  width: number;
  height: number;
  fps: number;
  inputPattern: string;
  outputFile: string;
  maxWidth?: number;
  dither?: GifDitherMode;
}

/**
 * Build ffmpeg arguments for GIF encoding (two-pass with palette)
 *
 * Pass 1: Generate palette
 * Pass 2: Encode with palette
 */
export function buildGifPaletteArgs(options: FFmpegGifOptions): string[] {
  const maxWidth = options.maxWidth ?? defaultGifConfig.maxWidth;
  const scale =
    options.width > maxWidth ? `scale=${maxWidth}:-1:flags=lanczos` : "scale=trunc(iw/2)*2:-2";

  return [
    "-framerate",
    options.fps.toString(),
    "-i",
    options.inputPattern,
    "-vf",
    `${scale},palettegen=max_colors=${defaultGifConfig.maxColors}:stats_mode=${defaultGifConfig.statsMode}`,
    "-frames:v",
    "1",
    "-update",
    "1",
    "-y",
    "palette.png",
  ];
}

export function buildGifEncodeArgs(options: FFmpegGifOptions): string[] {
  const maxWidth = options.maxWidth ?? defaultGifConfig.maxWidth;
  const dither = options.dither ?? defaultGifConfig.dither;
  const scale =
    options.width > maxWidth ? `scale=${maxWidth}:-1:flags=lanczos` : "scale=trunc(iw/2)*2:-2";

  // Build paletteuse options: dither + diff_mode for smaller file size
  const paletteuseOpts = [dither !== "none" ? `dither=${dither}` : null, "diff_mode=rectangle"]
    .filter(Boolean)
    .join(":");

  return [
    "-framerate",
    options.fps.toString(),
    "-i",
    options.inputPattern,
    "-i",
    "palette.png",
    "-lavfi",
    `${scale}[x];[x][1:v]paletteuse=${paletteuseOpts}`,
    "-r",
    options.fps.toString(),
    "-loop",
    "0",
    "-y",
    options.outputFile,
  ];
}

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
    // Source is wider, fit to width
    width = Math.min(sourceWidth, target.width);
    height = Math.round(width / sourceAspect);
  } else {
    // Source is taller, fit to height
    height = Math.min(sourceHeight, target.height);
    width = Math.round(height * sourceAspect);
  }

  // Ensure even dimensions
  return {
    width: Math.floor(width / 2) * 2,
    height: Math.floor(height / 2) * 2,
  };
}
