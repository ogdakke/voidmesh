import { ExportQueuePanel } from "#components/export-queue-panel.tsx";
import {
  useCanvasCommands,
  useCanvasRendererService,
  useSelectedEntities,
  useSelectionState,
} from "#context/use-canvas.ts";
import { useExportQueue } from "#context/use-export-queue.ts";
import {
  formatSupportsAudio,
  type ExportFormat,
  type QualityPreset,
  type ResolutionPreset,
  type GifDitherMode,
  type ImageExportFormat,
  IMAGE_FORMAT_OPTIONS,
  imageExportOptionsForFormat,
} from "#renderer/export-formats.ts";
import { isAnimatedEntity, isVideoEntity } from "#types/canvas.ts";
import { Button } from "#ui/button/button.tsx";
import { Drawer } from "#ui/drawer/drawer.tsx";
import { NativeSelect, NativeSelectOption } from "#ui/native-select/native-select.tsx";
import { Copy, Download } from "iconoir-react";
import { useRef, useEffect, type ChangeEvent, useState } from "react";
import { Checkbox } from "#ui/checkbox/checkbox.tsx";
import { config } from "#config";
import { exportUiConstants } from "./export-knobs.lib";
import { Slider } from "#ui/slider/slider.tsx";
import "./export-knobs.css";
import "../ui/toggle/toggle.css";
import { Radio, RadioGroup } from "@base-ui/react";
import { toastManager } from "#application/notifications.ts";
import { SnapPoints } from "#ui/drawer/snappoints.ts";

const { ui: exportUiConfig } = config.videoExporting;
const { FORMAT_OPTIONS, QUALITY_OPTIONS, RESOLUTION_OPTIONS, GIF_DITHER_OPTIONS } =
  exportUiConstants;

/** Mobile export settings - uses native selects for OS-level pickers */
function MobileExportSettingsKnobs() {
  const { exportOptions, updateExportOptions, syncFpsWithEntity } = useExportQueue();
  const selectedEntities = useSelectedEntities();

  const [imageFormat, setImageFormat] = useState<ImageExportFormat>("png");
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

  const handleFormatChange = (format: ExportFormat) => {
    updateExportOptions({
      format,
      includeAudio: formatSupportsAudio(format) ? exportOptions.includeAudio : false,
    });
  };

  const handleImageFormatChange = (value: ImageExportFormat) => {
    setImageFormat(value);
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
    return (
      <>
        <div className="main-settings" data-image-only>
          <div className="mobile-row image-format">
            <div className="format">
              <RadioGroup
                name="image-format"
                className="format-toggle-group"
                value={imageFormat}
                onValueChange={handleImageFormatChange}
              >
                {IMAGE_FORMAT_OPTIONS.map(({ value, label, subLabel }) => (
                  <Radio.Root
                    key={value}
                    value={value}
                    nativeButton
                    render={(props) => (
                      <button
                        {...props}
                        data-pressed={value === imageFormat || undefined}
                        className="ui-toggle format-toggle"
                      >
                        <span className="format-label">{label}</span>
                        {subLabel && <span className="format-sub-label">{subLabel}</span>}
                      </button>
                    )}
                  />
                ))}
              </RadioGroup>
            </div>
          </div>
          <MobileExportButtons imageFormat={imageFormat} />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="main-settings">
        <div className="mobile-row">
          <div className="format">
            <RadioGroup
              id="mobile-export-format"
              className="format-toggle-group"
              onValueChange={(val) => handleFormatChange(val)}
              value={exportOptions.format}
              name="export-format"
            >
              {formatOptions.map(({ value, label, subLabel }) => (
                <Radio.Root
                  key={value}
                  value={value}
                  nativeButton
                  render={(props) => (
                    <button
                      {...props}
                      data-pressed={value === exportOptions.format || undefined}
                      className="ui-toggle format-toggle"
                    >
                      <span className="format-label">{label}</span>
                      {subLabel && <span className="format-sub-label">{subLabel}</span>}
                    </button>
                  )}
                />
              ))}
            </RadioGroup>
          </div>
        </div>
        <div className="main-settings-buttons">
          <MobileExportButtons imageFormat={imageFormat} />
        </div>
      </div>

      <p className="mobile-row advanced-settings">Advanced settings</p>
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

      {hasAnimated && <hr className="divider" />}
      <p className="advanced-settings mobile-row">Single frame settings</p>
      <div className="mobile-row">
        <div className="format">
          <RadioGroup
            name="image-format"
            className="format-toggle-group"
            value={imageFormat}
            aria-label="Image format"
            onValueChange={handleImageFormatChange}
          >
            {IMAGE_FORMAT_OPTIONS.map(({ value, label, subLabel }) => (
              <Radio.Root
                key={value}
                value={value}
                nativeButton
                render={(props) => (
                  <button
                    {...props}
                    data-pressed={value === imageFormat || undefined}
                    className="ui-toggle format-toggle"
                  >
                    <span className="format-label">{label}</span>
                    <span className="format-sub-label">{subLabel}</span>
                  </button>
                )}
              />
            ))}
          </RadioGroup>
        </div>
      </div>
    </>
  );
}

function MobileExportButtons({ imageFormat }: { imageFormat: ImageExportFormat }) {
  const { exportOptions, addToQueue, isExporting } = useExportQueue();
  const selectionState = useSelectionState();
  const selectedEntities = useSelectedEntities();
  const { saveSelectedEntityToFile: saveToFile, copySelectedEntityToClipboard } =
    useCanvasCommands();
  const { renderer } = useCanvasRendererService();

  const saveSelectedEntityToFile = () => saveToFile(imageExportOptionsForFormat(imageFormat));

  const animatedEntities = selectedEntities.filter(isAnimatedEntity);
  const hasAnimated = animatedEntities.length > 0;
  const animatedCount = animatedEntities.length;
  const isMultiAnimated = animatedCount > 1;
  const isMany = selectionState.isMultiple;
  const isGif = exportOptions.format === "gif";

  const handleStartExport = () => {
    if (!renderer || animatedEntities.length === 0) return;
    for (const entity of animatedEntities) {
      addToQueue(entity, renderer);
    }
    toastManager.add({
      title: "Export started",
      description: "See progress in the bottom of the export panel",
    });
  };

  return (
    <>
      {/* Video export button - adds to queue */}
      {hasAnimated && (
        <div className="export-video-row mobile-row">
          <Button onClick={handleStartExport} className="export-video-btn" isPending={isExporting}>
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
      <div className="export-row mobile-row">
        <Button onClick={saveSelectedEntityToFile} variant={hasAnimated ? "secondary" : "primary"}>
          <span className="text-xs no-wrap">
            {hasAnimated ? `Save Frame${isMany ? "s" : ""}` : `Save Image${isMany ? "s" : ""}`}
          </span>
        </Button>
        {selectionState.isSingle && (
          <Button onClick={copySelectedEntityToClipboard} variant="secondary">
            <Copy />
            <span className="text-xs no-wrap">{hasAnimated ? "Copy Frame" : "Copy Image"}</span>
          </Button>
        )}
      </div>
    </>
  );
}

interface MobileExportDrawerProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: boolean;
}

export function MobileExportDrawer({
  open,
  onOpenChange,
  trigger = true,
}: MobileExportDrawerProps) {
  const selectedEntities = useSelectedEntities();
  const hasAnimated = selectedEntities.some(isAnimatedEntity);
  const firstSnapPoint = SnapPoints.compute().at(0)!;
  const [snapPoint, setSnapPoint] = useState<number | string | null>(firstSnapPoint);

  const drawer = (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      snapPoint={snapPoint}
      onSnapPointChange={(val) => setSnapPoint(val)}
      snapPoints={firstSnapPoint !== null ? [firstSnapPoint, 1] : undefined}
    >
      {trigger && (
        <Drawer.Trigger
          render={(props) => (
            <Button {...props} className="mobile-export-btn">
              <Download />
              <span>Export</span>
            </Button>
          )}
        ></Drawer.Trigger>
      )}
      <Drawer.Popup
        className="mobile-exports-drawer-content"
        data-image-only={!hasAnimated || undefined}
      >
        <Drawer.Content>
          <div className="mobile-exports-drawer-inner">
            <div
              className="mobile-exports-settings"
              data-fully-snapped={snapPoint === 1 || undefined}
            >
              <MobileExportSettingsKnobs />
            </div>
            <ExportQueuePanel />
          </div>
        </Drawer.Content>
      </Drawer.Popup>
    </Drawer.Root>
  );

  if (!trigger) return drawer;

  return (
    <div className="mobile-exports">
      <div className="mobile-row">{drawer}</div>
    </div>
  );
}

export function MobileExportKnobs() {
  return <MobileExportDrawer />;
}
