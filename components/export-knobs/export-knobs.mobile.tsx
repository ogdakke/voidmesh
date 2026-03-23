import { ExportQueuePanel } from "#components/export-queue-panel.tsx";
import { UploadControls } from "#components/upload-button-controls.tsx";
import { useSelectedEntities } from "#context/use-canvas.ts";
import { useExportQueue } from "#context/use-export-queue.ts";
import {
  formatSupportsAudio,
  type ExportFormat,
  type QualityPreset,
  type ResolutionPreset,
  type GifDitherMode,
  type ImageExportFormat,
  IMAGE_FORMAT_OPTIONS,
} from "#renderer/export-formats.ts";
import { isAnimatedEntity, isVideoEntity } from "#types/canvas.ts";
import { Button } from "#ui/button/button.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#ui/collapsible/collapsible.tsx";
import { Drawer } from "#ui/drawer/drawer.tsx";
import { NativeSelect, NativeSelectOption } from "#ui/native-select/native-select.tsx";
import { NavArrowRight, Download } from "iconoir-react";
import { useRef, useEffect, type ChangeEvent, useState } from "react";
import { ExportSaveButtons } from "./export-knobs.shared";
import { Checkbox } from "#ui/checkbox/checkbox.tsx";
import { config } from "#config";
import { exportUiConstants } from "./export-knobs.lib";
import { Slider } from "#ui/slider/slider.tsx";
import "./export-knobs.css";

const { ui: exportUiConfig } = config.videoExporting;
const { FORMAT_OPTIONS, QUALITY_OPTIONS, RESOLUTION_OPTIONS, GIF_DITHER_OPTIONS } =
  exportUiConstants;

/** Mobile export settings - uses native selects for OS-level pickers */
function MobileExportSettingsKnobs() {
  const { exportOptions, updateExportOptions, syncFpsWithEntity } = useExportQueue();
  const selectedEntities = useSelectedEntities();

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

  const formatOptions = FORMAT_OPTIONS;

  const isGif = exportOptions.format === "gif";
  const entityHasAudio =
    firstAnimatedEntity &&
    isVideoEntity(firstAnimatedEntity) &&
    firstAnimatedEntity.mediaSource.hasAudio;
  const supportsAudio = formatSupportsAudio(exportOptions.format) && entityHasAudio;

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

  const handleGifMaxWidthChange = (value: number | number[]) => {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined) {
      updateExportOptions({
        advanced: { gifMaxWidth: val },
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
            {formatOptions.map(({ value, label }) => (
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

          {isGif && (
            <>
              <div className="mobile-row gif-export-slider">
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
  const selectedEntities = useSelectedEntities();
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
