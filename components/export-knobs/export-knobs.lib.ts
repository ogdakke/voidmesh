import type {
  ExportFormat,
  QualityPreset,
  ResolutionPreset,
  GifDitherMode,
} from "#renderer/export-formats.ts";

const FORMAT_OPTIONS: { value: ExportFormat; label: string; subLabel?: string }[] = [
  { value: "mp4", label: "MP4", subLabel: "h.264" },
  { value: "mov", label: "MOV", subLabel: "h.264" },
  { value: "gif", label: "GIF" },
];

const QUALITY_OPTIONS: { value: QualityPreset; label: string }[] = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

const RESOLUTION_OPTIONS: { value: ResolutionPreset; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
];

const GIF_DITHER_OPTIONS: { value: GifDitherMode; label: string }[] = [
  { value: "floyd_steinberg", label: "Floyd-Steinberg" },
  { value: "none", label: "None" },
];

export const exportUiConstants = {
  FORMAT_OPTIONS,
  QUALITY_OPTIONS,
  RESOLUTION_OPTIONS,
  GIF_DITHER_OPTIONS,
};
