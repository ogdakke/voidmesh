/**
 * Export settings knobs component
 * Controls video export format, quality, and advanced encoding options
 * Uses export queue system for non-blocking concurrent exports
 */

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { NavArrowRight, MediaVideo, Copy, Download } from "iconoir-react";
import { useExportQueue } from "../context/use-export-queue.ts";
import type { ExportOptionsState } from "../context/video-export-context.tsx";
import { useCanvasActions } from "../hooks/use-canvas-actions.ts";
import { useCanvas } from "../context/use-canvas.ts";
import { isAnimatedEntity } from "#types/canvas.ts";
import {
  type ExportFormat,
  type QualityPreset,
  type ResolutionPreset,
  type GifDitherMode,
  formatSupportsAudio,
} from "#renderer/video-exporter.ts";
import {
  type ImageExportFormat,
  IMAGE_FORMAT_OPTIONS,
  imageExportOptionsForFormat,
} from "#renderer/export-formats.ts";
import { config } from "#config";
import { Button } from "./ui/button/index.tsx";
import { Select, SelectItem } from "./ui/select/index.tsx";
import { NativeSelect, NativeSelectOption } from "./ui/native-select/native-select.tsx";
import { Checkbox } from "./ui/checkbox/index.tsx";
import { Slider } from "./ui/slider/index.tsx";
import { NumberField } from "./ui/number-field/number-field.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible/collapsible.tsx";
import { Drawer } from "./ui/drawer/index.tsx";
import { ExportQueuePanel } from "./export-queue-panel.tsx";
import "../styles/sidebar.css";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { UploadControls } from "./upload-button-controls.tsx";

// Option definitions
const FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: "mp4", label: "MP4 (H.264)" },
  { value: "webm", label: "WebM (VP8)" },
  { value: "mov", label: "MOV (H.264)" },
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
  { value: "bayer", label: "Bayer (Ordered)" },
  { value: "sierra2", label: "Sierra" },
  { value: "none", label: "None" },
];

const { ui: exportUiConfig } = config.videoExporting;

/** Export save buttons - frame copy/save and video export */
export function ExportSaveButtons({ imageFormat }: { imageFormat: ImageExportFormat }) {
  const isMobile = useIsMobile();
  const { exportOptions, preloadFFmpeg, addToQueue } = useExportQueue();
  const { selectionState, selectedEntities } = useCanvasActions();
  const {
    saveSelectedEntityToFile: saveToFile,
    copySelectedEntityToClipboard,
    renderer,
  } = useCanvas();

  const saveSelectedEntityToFile = () => saveToFile(imageExportOptionsForFormat(imageFormat));

  const animatedEntities = selectedEntities.filter(isAnimatedEntity);
  const hasAnimated = animatedEntities.length > 0;
  const animatedCount = animatedEntities.length;
  const isMultiAnimated = animatedCount > 1;
  const isGif = exportOptions.format === "gif";

  const handleStartExport = () => {
    if (!renderer || animatedEntities.length === 0) return;
    for (const entity of animatedEntities) {
      addToQueue(entity, renderer);
    }
  };

  return (
    <>
      {/* Video export button - adds to queue */}
      {hasAnimated && (
        <div className="export-video-row sidebar-row">
          <Button
            onClick={handleStartExport}
            onMouseEnter={preloadFFmpeg}
            onFocus={preloadFFmpeg}
            className="export-video-btn"
          >
            <MediaVideo />
            <span>
              {isMultiAnimated
                ? `Export ${animatedCount} ${isGif ? "GIFs" : "Videos"}`
                : isGif
                  ? "Export GIF"
                  : "Export Video"}
            </span>
          </Button>
        </div>
      )}

      {/* Frame export buttons (always shown, labeled differently for video) */}
      <div className="export-row sidebar-row">
        {selectionState.isSingle && (
          <Button
            onClick={copySelectedEntityToClipboard}
            size={isMobile ? "md" : "sm"}
            variant="secondary"
          >
            <Copy />
            <span className="text-xs no-wrap">{hasAnimated ? "Copy Frame" : "Copy"}</span>
          </Button>
        )}
        <Button
          onClick={saveSelectedEntityToFile}
          size={isMobile ? "md" : "sm"}
          variant={hasAnimated ? "secondary" : "primary"}
        >
          <Download />
          <span className="text-xs no-wrap">{hasAnimated ? "Save Frame" : "Save"}</span>
        </Button>
      </div>
    </>
  );
}

/** Export settings knobs - format, quality, advanced options */
export function ExportSettingsKnobs() {
  const { exportOptions, updateExportOptions, syncFpsWithEntity } = useExportQueue();
  const { selectedEntities } = useCanvasActions();

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

  const isGif = exportOptions.format === "gif";
  const supportsAudio = formatSupportsAudio(exportOptions.format);

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
  const handleIncludeAudioChange = (e: ChangeEvent<HTMLInputElement>) => {
    updateExportOptions({ includeAudio: e.target.checked });
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

  // CRF change handler
  const handleCrfChange = (value: number | number[]) => {
    const val = Array.isArray(value) ? value[0] : value;
    updateExportOptions({
      advanced: { crf: val },
    });
  };

  // Two-pass change handler
  const handleTwoPassChange = (e: ChangeEvent<HTMLInputElement>) => {
    updateExportOptions({
      advanced: { twoPass: e.target.checked },
    });
  };

  // GIF max width handler
  const handleGifMaxWidthChange = (value: number | null) => {
    if (value !== null) {
      updateExportOptions({
        advanced: { gifMaxWidth: value },
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
          items={FORMAT_OPTIONS}
        >
          {FORMAT_OPTIONS.map(({ value, label }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </Select>
      </div>

      {/* Quality - only for video formats (controls CRF) */}
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

      {/* Include Audio - only for formats that support it */}
      {supportsAudio && (
        <div className="sidebar-row">
          <Checkbox
            name="include_audio"
            checked={exportOptions.includeAudio}
            onChange={handleIncludeAudioChange}
            switch
          >
            Include audio
          </Checkbox>
        </div>
      )}

      {/* Advanced settings collapsible */}
      <Collapsible className="collapsible-depth-1">
        <CollapsibleTrigger>
          <NavArrowRight />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent>
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

          {/* CRF - not for GIF */}
          {!isGif && (
            <div className="sidebar-row">
              <Slider
                name="export-crf"
                label="CRF (Quality)"
                min={exportUiConfig.crf.min}
                max={exportUiConfig.crf.max}
                step={exportUiConfig.crf.step}
                value={exportOptions.advanced.crf ?? 23}
                onValueChange={handleCrfChange}
                showValue
              />
              <span className="hint-text">Lower = better quality, larger file</span>
            </div>
          )}

          {/* Two-pass - only for video formats */}
          {!isGif && (
            <div className="sidebar-row">
              <Checkbox
                name="two_pass"
                checked={exportOptions.advanced.twoPass}
                onChange={handleTwoPassChange}
                switch
              >
                Two-pass encoding
              </Checkbox>
            </div>
          )}

          {/* GIF-specific options */}
          {isGif && (
            <>
              <div className="sidebar-row">
                <NumberField
                  label="Max Width"
                  name="gif-max-width"
                  value={exportOptions.advanced.gifMaxWidth}
                  onValueChange={handleGifMaxWidthChange}
                  min={exportUiConfig.gifMaxWidth.min}
                  max={exportUiConfig.gifMaxWidth.max}
                  enableScrubArea
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
export function ExportKnobs() {
  const { selectedEntities } = useCanvasActions();
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

/** Mobile export settings - uses native selects for OS-level pickers */
function MobileExportSettingsKnobs() {
  const { exportOptions, updateExportOptions, syncFpsWithEntity } = useExportQueue();
  const { selectedEntities } = useCanvasActions();

  const animatedEntities = selectedEntities.filter(isAnimatedEntity);
  const firstAnimatedEntity = animatedEntities[0] ?? null;
  const hasAnimated = animatedEntities.length > 0;
  const lastSyncedAnimatedEntityIdRef = useRef<string | null>(null);

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

  const isGif = exportOptions.format === "gif";
  const supportsAudio = formatSupportsAudio(exportOptions.format);

  const handleFormatChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const format = e.target.value as ExportFormat;
    updateExportOptions({
      format,
      includeAudio: formatSupportsAudio(format) ? exportOptions.includeAudio : false,
    });
  };

  const handleQualityChange = (e: ChangeEvent<HTMLSelectElement>) => {
    updateExportOptions({ quality: e.target.value as QualityPreset });
  };

  const handleIncludeAudioChange = (e: ChangeEvent<HTMLInputElement>) => {
    updateExportOptions({ includeAudio: e.target.checked });
  };

  const handleFpsChange = (value: number | number[]) => {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined) {
      updateExportOptions({ fps: val });
    }
  };

  const handleResolutionChange = (e: ChangeEvent<HTMLSelectElement>) => {
    updateExportOptions({
      advanced: { resolution: e.target.value as ResolutionPreset },
    });
  };

  const handleCrfChange = (value: number | number[]) => {
    const val = Array.isArray(value) ? value[0] : value;
    updateExportOptions({
      advanced: { crf: val },
    });
  };

  const handleTwoPassChange = (e: ChangeEvent<HTMLInputElement>) => {
    updateExportOptions({
      advanced: { twoPass: e.target.checked },
    });
  };

  const handleGifMaxWidthChange = (value: number | null) => {
    if (value !== null) {
      updateExportOptions({
        advanced: { gifMaxWidth: value },
      });
    }
  };

  const handleGifDitherChange = (e: ChangeEvent<HTMLSelectElement>) => {
    updateExportOptions({
      advanced: { gifDither: e.target.value as GifDitherMode },
    });
  };

  if (!hasAnimated) {
    return null;
  }

  return (
    <>
      <div className="mobile-row">
        <div className="native-select-field native-select-field--mobile">
          <label className="select-label" htmlFor="mobile-export-format">
            Format
          </label>
          <NativeSelect
            id="mobile-export-format"
            value={exportOptions.format}
            onChange={handleFormatChange}
            variant="quiet"
            name="export-format"
          >
            {FORMAT_OPTIONS.map(({ value, label }) => (
              <NativeSelectOption key={value} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>

      {!isGif && (
        <div className="mobile-row">
          <div className="native-select-field native-select-field--mobile">
            <label className="select-label" htmlFor="mobile-export-quality">
              Quality
            </label>
            <NativeSelect
              id="mobile-export-quality"
              value={exportOptions.quality}
              onChange={handleQualityChange}
              variant="quiet"
              name="export-quality"
            >
              {QUALITY_OPTIONS.map(({ value, label }) => (
                <NativeSelectOption key={value} value={value}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
      )}

      {supportsAudio && (
        <div className="mobile-row">
          <Checkbox
            name="include_audio"
            checked={exportOptions.includeAudio}
            onChange={handleIncludeAudioChange}
            switch
          >
            Include audio
          </Checkbox>
        </div>
      )}

      <Collapsible>
        <CollapsibleTrigger>
          <NavArrowRight />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mobile-row">
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

          {!isGif && (
            <div className="mobile-row">
              <div className="native-select-field native-select-field--mobile">
                <label className="select-label" htmlFor="mobile-export-resolution">
                  Resolution
                </label>
                <NativeSelect
                  id="mobile-export-resolution"
                  value={exportOptions.advanced.resolution}
                  onChange={handleResolutionChange}
                  name="export-resolution"
                  variant="quiet"
                >
                  {RESOLUTION_OPTIONS.map(({ value, label }) => (
                    <NativeSelectOption key={value} value={value}>
                      {label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
          )}

          {!isGif && (
            <div className="mobile-row">
              <Slider
                name="export-crf"
                label="CRF (Quality)"
                min={exportUiConfig.crf.min}
                max={exportUiConfig.crf.max}
                step={exportUiConfig.crf.step}
                value={exportOptions.advanced.crf ?? 23}
                onValueChange={handleCrfChange}
                showValue
              />
              <span className="hint-text">Lower = better quality, larger file</span>
            </div>
          )}

          {!isGif && (
            <div className="mobile-row">
              <Checkbox
                name="two_pass"
                checked={exportOptions.advanced.twoPass}
                onChange={handleTwoPassChange}
                switch
              >
                Two-pass encoding
              </Checkbox>
            </div>
          )}

          {isGif && (
            <>
              <div className="mobile-row">
                <NumberField
                  label="Max Width"
                  name="gif-max-width"
                  value={exportOptions.advanced.gifMaxWidth}
                  onValueChange={handleGifMaxWidthChange}
                  min={exportUiConfig.gifMaxWidth.min}
                  max={exportUiConfig.gifMaxWidth.max}
                  enableScrubArea
                />
              </div>
              <div className="mobile-row">
                <div className="native-select-field native-select-field--mobile">
                  <label className="select-label" htmlFor="mobile-gif-dither">
                    Dither
                  </label>
                  <NativeSelect
                    id="mobile-gif-dither"
                    value={exportOptions.advanced.gifDither}
                    onChange={handleGifDitherChange}
                    name="gif-dither"
                    variant="quiet"
                  >
                    {GIF_DITHER_OPTIONS.map(({ value, label }) => (
                      <NativeSelectOption key={value} value={value}>
                        {label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              </div>
            </>
          )}
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

export function MobileExportKnobs() {
  const { selectedEntities } = useCanvasActions();
  const [imageFormat, setImageFormat] = useState<ImageExportFormat>("png");

  const hasAnimated = selectedEntities.some(isAnimatedEntity);

  const handleImageFormatChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setImageFormat(e.target.value as ImageExportFormat);
  };

  return (
    <div className="mobile-exports">
      <div className="mobile-exports-common">
        <UploadControls />
      </div>
      <div className="mobile-row">
        <Drawer.Root>
          <Drawer.Trigger
            render={(props) => (
              <Button {...props} className="mobile-export-btn" variant="secondary">
                <Download />
                <span>Export</span>
              </Button>
            )}
          ></Drawer.Trigger>
          <Drawer.Popup
            className="mobile-exports-drawer-content"
            data-image-only={!hasAnimated || undefined}
          >
            <Drawer.Content>
              <div className="mobile-exports-drawer-inner">
                <div className="mobile-exports-settings">
                  <MobileExportSettingsKnobs />
                  {/* divider if there's animated entity knobs above */}
                  {hasAnimated && <hr className="divider" />}
                  <div className="mobile-row">
                    <div className="native-select-field native-select-field--mobile">
                      <label className="select-label" htmlFor="mobile-image-format">
                        {hasAnimated ? "Format (frame export)" : "Format"}
                      </label>
                      <NativeSelect
                        id="mobile-image-format"
                        value={imageFormat}
                        onChange={handleImageFormatChange}
                        variant="quiet"
                        name="image-format"
                      >
                        {IMAGE_FORMAT_OPTIONS.map(({ value, label }) => (
                          <NativeSelectOption key={value} value={value}>
                            {label}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                  </div>
                </div>
                <ExportQueuePanel />
                <div className="mobile-exports-actions">
                  <ExportSaveButtons imageFormat={imageFormat} />
                </div>
              </div>
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Root>
      </div>
    </div>
  );
}

// Re-export types for external use
export type { ExportOptionsState };
