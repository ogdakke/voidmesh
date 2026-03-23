/**
 * Export settings knobs component
 * Controls video export format, quality, and advanced encoding options
 * Uses export queue system for non-blocking concurrent exports
 */

import { useEffect, useRef, useState } from "react";
import { NavArrowRight, SoundHigh } from "iconoir-react";
import { useSelectedEntities } from "#context/use-canvas.ts";
import { useExportQueue } from "#context/use-export-queue.ts";
import { isAnimatedEntity, isVideoEntity } from "#types/canvas.ts";
import {
  type ExportFormat,
  type QualityPreset,
  type ResolutionPreset,
  type GifDitherMode,
  formatSupportsAudio,
} from "#renderer/video-exporter.ts";
import { type ImageExportFormat, IMAGE_FORMAT_OPTIONS } from "#renderer/export-formats.ts";
import { config } from "#config";
import { Select, SelectItem } from "#ui/select/index.tsx";
import { Toggle } from "#ui/toggle/index.tsx";
import { Slider } from "#ui/slider/index.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#ui/collapsible/collapsible.tsx";
import "#styles/sidebar.css";
import { ExportSaveButtons } from "./export-knobs.shared.tsx";
import { exportUiConstants } from "./export-knobs.lib.ts";
import "./export-knobs.css";

const { ui: exportUiConfig } = config.videoExporting;
const { FORMAT_OPTIONS, QUALITY_OPTIONS, RESOLUTION_OPTIONS, GIF_DITHER_OPTIONS } =
  exportUiConstants;

/** Export settings knobs - format, quality, advanced options */
export function ExportSettingsKnobs() {
  const { exportOptions, updateExportOptions, syncFpsWithEntity } = useExportQueue();
  const selectedEntities = useSelectedEntities();

  const animatedEntities = selectedEntities.filter(isAnimatedEntity);
  const firstAnimatedEntity = animatedEntities[0] ?? null;
  const hasAnimated = animatedEntities.length > 0;
  const lastSyncedAnimatedEntityIdRef = useRef<string | null>(null);

  // Sync only when the selected animated entity changes, not on every render.
  useEffect(() => {
    const currentEntityId = firstAnimatedEntity?.id ?? null;
    if (!currentEntityId) {
      lastSyncedAnimatedEntityIdRef.current = null;
      return;
    }
    if (lastSyncedAnimatedEntityIdRef.current === currentEntityId) return;
    syncFpsWithEntity(firstAnimatedEntity);
    lastSyncedAnimatedEntityIdRef.current = currentEntityId;
  }, [firstAnimatedEntity, syncFpsWithEntity]);

  const formatOptions = FORMAT_OPTIONS;

  const isGif = exportOptions.format === "gif";
  const entityHasAudio =
    firstAnimatedEntity &&
    isVideoEntity(firstAnimatedEntity) &&
    firstAnimatedEntity.mediaSource.hasAudio;
  const supportsAudio = formatSupportsAudio(exportOptions.format) && entityHasAudio;

  // Format change handler
  const handleFormatChange = (value: string | null) => {
    if (value) {
      const format = value as ExportFormat;
      updateExportOptions({
        format,
        includeAudio: formatSupportsAudio(format) ? exportOptions.includeAudio : false,
      });
    }
  };

  // Quality change handler
  const handleQualityChange = (value: string | null) => {
    if (value) {
      updateExportOptions({ quality: value as QualityPreset });
    }
  };

  // Include audio handler
  const handleIncludeAudioChange = (pressed: boolean) => {
    updateExportOptions({ includeAudio: pressed });
  };

  // FPS change handler
  const handleFpsChange = (value: number | number[]) => {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined) {
      updateExportOptions({ fps: val });
    }
  };

  // Resolution change handler
  const handleResolutionChange = (value: string | null) => {
    if (value) {
      updateExportOptions({
        advanced: { resolution: value as ResolutionPreset },
      });
    }
  };

  // GIF max width handler
  const handleGifMaxWidthChange = (value: number | number[]) => {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined) {
      updateExportOptions({
        advanced: { gifMaxWidth: val },
      });
    }
  };

  // GIF dither handler
  const handleGifDitherChange = (value: string | null) => {
    if (value) {
      updateExportOptions({
        advanced: { gifDither: value as GifDitherMode },
      });
    }
  };

  if (!hasAnimated) {
    return null;
  }

  return (
    <>
      <div className="sidebar-row">
        <Select
          label="Format"
          value={exportOptions.format}
          onValueChange={handleFormatChange}
          name="export-format"
          items={formatOptions}
        >
          {formatOptions.map(({ value, label }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </Select>
      </div>

      {/* Quality - only for video formats (controls bitrate) */}
      {!isGif && (
        <div className="sidebar-row">
          <Select
            label="Quality"
            value={exportOptions.quality}
            onValueChange={handleQualityChange}
            name="export-quality"
            items={QUALITY_OPTIONS}
          >
            {QUALITY_OPTIONS.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </Select>
        </div>
      )}

      {/* Advanced settings collapsible */}
      <Collapsible className="collapsible-depth-1">
        <CollapsibleTrigger>
          <NavArrowRight />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent>
          {/* Include Audio - only for formats that support it */}
          {supportsAudio && (
            <div className="sidebar-row">
              <Toggle
                pressed={exportOptions.includeAudio}
                onPressedChange={handleIncludeAudioChange}
                title="Include audio"
              >
                <SoundHigh /> Include Audio
              </Toggle>
            </div>
          )}

          {/* FPS - GIFs have lower max due to format limitations */}
          <div className="sidebar-row">
            <Slider
              name="export-fps"
              label="Frame Rate (FPS)"
              min={isGif ? exportUiConfig.gifFps.min : exportUiConfig.fps.min}
              max={isGif ? exportUiConfig.gifFps.max : exportUiConfig.fps.max}
              step={isGif ? exportUiConfig.gifFps.step : exportUiConfig.fps.step}
              value={Math.min(
                exportOptions.fps,
                isGif ? exportUiConfig.gifFps.max : exportUiConfig.fps.max,
              )}
              onValueChange={handleFpsChange}
              showValue
            />
          </div>

          {/* Resolution - not for GIF (maxWidth controls size instead) */}
          {!isGif && (
            <div className="sidebar-row">
              <Select
                label="Resolution"
                value={exportOptions.advanced.resolution}
                onValueChange={handleResolutionChange}
                name="export-resolution"
                items={RESOLUTION_OPTIONS}
              >
                {RESOLUTION_OPTIONS.map(({ value, label }) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </Select>
            </div>
          )}

          {/* GIF-specific options */}
          {isGif && (
            <>
              <div className="sidebar-row gif-export-slider">
                <Slider
                  label="Max Width"
                  name="gif-max-width"
                  value={exportOptions.advanced.gifMaxWidth}
                  onValueChange={handleGifMaxWidthChange}
                  min={exportUiConfig.gifMaxWidth.min}
                  max={exportUiConfig.gifMaxWidth.max}
                  step={exportUiConfig.gifMaxWidth.step}
                  showValue
                />
              </div>
              <div className="sidebar-row">
                <Select
                  label="Dither"
                  value={exportOptions.advanced.gifDither}
                  onValueChange={handleGifDitherChange}
                  name="gif-dither"
                  items={GIF_DITHER_OPTIONS}
                >
                  {GIF_DITHER_OPTIONS.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            </>
          )}
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

/** Combined export knobs for desktop sidebar */
export function DesktopExportKnobs() {
  const selectedEntities = useSelectedEntities();
  const [imageFormat, setImageFormat] = useState<ImageExportFormat>("png");
  const hasAnimated = selectedEntities.some(isAnimatedEntity);

  const handleImageFormatChange = (value: string | null) => {
    if (value) setImageFormat(value as ImageExportFormat);
  };

  const imageFormatLabel = hasAnimated ? "Format (frame export)" : "Format";

  return (
    <>
      <ExportSettingsKnobs />
      <div className="sidebar-row">
        <Select
          label={imageFormatLabel}
          value={imageFormat}
          onValueChange={handleImageFormatChange}
          name="image-format"
          items={IMAGE_FORMAT_OPTIONS}
        >
          {IMAGE_FORMAT_OPTIONS.map(({ value, label }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </Select>
      </div>
      <ExportSaveButtons imageFormat={imageFormat} />
    </>
  );
}
