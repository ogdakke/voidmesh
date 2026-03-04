import { type ChangeEvent } from "react";
import { FloppyDiskArrowIn, Import, NavArrowRight } from "iconoir-react";
import { useCanvas } from "../context/use-canvas.ts";
import { SHADER_TYPE_OPTIONS, GlassKind, GLASS_KIND_OPTIONS } from "#types/canvas.ts";
import { useCanvasActions, useParamValue } from "../hooks/use-canvas-actions.ts";
import { NumberField } from "./ui/number-field/number-field.tsx";
import { Button } from "./ui/button/index.tsx";
import { Select, SelectItem } from "./ui/select/index.tsx";
import { Checkbox } from "./ui/checkbox/index.tsx";
import { Slider } from "./ui/slider/index.tsx";
import { Hint } from "./ui/hint/hint.tsx";
import { ColorPalette } from "./ui/color-palette/color-palette.tsx";
import { ColorPalettePresets } from "./palette-preset/color-palette-presets.tsx";
import { PaletteUpload } from "./palette-upload/index.ts";
import { PostProcessingKnobs } from "./post-processing-knobs.tsx";
import { AdjustmentsKnobs } from "./adjustments-knobs.tsx";
import { AsciiKnobs } from "./ascii-knobs.tsx";
import { DitheringKnobs } from "./dithering-knobs.tsx";
import { ShapeKnobs } from "./shape-knobs.tsx";
import { DesktopExportKnobs } from "./export-knobs/export-knobs.desktop.tsx";
import { ExportQueuePanel } from "./export-queue-panel.tsx";
import { DesktopTimeSlider } from "./desktop-time-slider/desktop-time-slider.tsx";
import { undo } from "#lib/undo.ts";
import { config } from "#config";
import { isUserPalette } from "#components/palette-preset/palette-presets.ts";
import { usePaletteStore } from "#lib/palette-store.ts";
import {
  Collapsible,
  CollapsibleCheckbox,
  CollapsibleContent,
  CollapsibleGroup,
  CollapsibleTrigger,
} from "#components/ui/collapsible/index.tsx";
import { FileUploadComponent } from "./upload-button-controls.tsx";
import { useStudioFile } from "#hooks/use-studio-file.ts";

interface SidebarRightControlsProps {
  className?: string;
  /** If true, renders minimal UI suitable for mobile */
  compact?: boolean;
}

export const SidebarRightControls = ({ className, compact }: SidebarRightControlsProps) => {
  const { updateSelectedEntityParams, entities } = useCanvas();
  const { exportStudioFile, importStudioFile, isExporting, isImporting } = useStudioFile();

  // Use shared canvas actions hook with selectionState for multi-select
  const {
    shaderType: selectedShaderType,
    handleShaderTypeChange,
    hasSelection,
    selectionState,
    handleShowOriginalChange,
    resetEntityToDefaults,
  } = useCanvasActions();
  const postProcessEnabled = useParamValue(
    "postProcess.enabled",
    config.defaults.shaderParams.postProcess.enabled,
  );
  const showOriginalEnabled = useParamValue(
    "showOriginal",
    config.defaults.shaderParams.showOriginal,
  );

  // Master enable/disable handler
  const handlePpEnabledChange = (e: ChangeEvent<HTMLInputElement>) => {
    updateSelectedEntityParams({
      postProcess: { enabled: e.target.checked },
    });
  };

  return (
    <form onSubmit={(e) => e.preventDefault()} className={className}>
      <div
        className="sidebar-controls-overflow fade-mask-y"
        style={{ "--box-padding": compact ? "40px" : "80px" } as React.CSSProperties}
      >
        <div>
          <div className="sidebar-row upload-row">
            <FileUploadComponent />
          </div>

          <hr className="divider" />
          {!hasSelection && (
            <>
              <div className="sidebar-row no-selection-message">
                <p>
                  {entities.length > 0
                    ? "Select an image or video on the canvas to edit it"
                    : "Drop or paste images, videos and links for editing"}
                </p>
              </div>
              <div className="sidebar-row last-row">
                <Hint className="sidebar-hint--no-selection" />
              </div>
            </>
          )}
          {hasSelection && (
            <>
              <div className="sidebar-row shader-type-row">
                <ShaderSelect
                  shaderType={selectedShaderType}
                  handleShaderTypeChange={handleShaderTypeChange}
                  isShaderMixed={!selectionState.hasUniformShader}
                />
              </div>
              <div className="sidebar-row show-original-row">
                <Checkbox
                  name="show_original"
                  checked={showOriginalEnabled.value}
                  indeterminate={showOriginalEnabled.isMixed}
                  onChange={(e) => {
                    // If mixed, clicking sets all to true; otherwise toggle
                    const newValue = showOriginalEnabled.isMixed ? true : e.target.checked;
                    handleShowOriginalChange(newValue);
                  }}
                >
                  Show original
                </Checkbox>
                <Button variant="quiet" size="sm" onClick={resetEntityToDefaults}>
                  Reset
                </Button>
              </div>
              <hr className="divider" />
              <Collapsible>
                <CollapsibleTrigger className="sidebar-collapsible-trigger">
                  <NavArrowRight className="collapsible-icon" />
                  Adjustments
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <AdjustmentsKnobs />
                </CollapsibleContent>
              </Collapsible>
              <hr className="divider" />
              <Collapsible defaultOpen>
                <CollapsibleTrigger className="sidebar-collapsible-trigger">
                  <NavArrowRight className="collapsible-icon" />
                  Style Parameters
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <BlobParams />

                  <GlassParamsControl />

                  <DitheringKnobs />

                  <AsciiKnobs />

                  <EffectParams />

                  <EntityParams />
                </CollapsibleContent>
              </Collapsible>
              <hr className="divider" />
              <Collapsible
                key={`pp-${!!postProcessEnabled.value}`}
                defaultOpen={!!postProcessEnabled.value}
              >
                <CollapsibleGroup>
                  <CollapsibleTrigger className="sidebar-collapsible-trigger">
                    <NavArrowRight />
                    Post Processing
                  </CollapsibleTrigger>
                  <CollapsibleCheckbox
                    aria-label="Enable Post Processing"
                    checked={postProcessEnabled.value}
                    indeterminate={postProcessEnabled.isMixed}
                    onChange={handlePpEnabledChange}
                  />
                </CollapsibleGroup>
                <CollapsibleContent>
                  <PostProcessingKnobs />
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
          {hasSelection && (
            <Collapsible>
              <CollapsibleTrigger className="sidebar-collapsible-trigger">
                <NavArrowRight />
                Export
              </CollapsibleTrigger>
              <CollapsibleContent className="exports-content">
                <DesktopExportKnobs />
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>

      {hasSelection && <DesktopTimeSlider />}

      {!hasSelection && (
        <div className="sidebar-row studio-file-row">
          {entities.length > 0 && (
            <Button
              variant="primary"
              onClick={exportStudioFile}
              disabled={isExporting || isImporting}
            >
              <FloppyDiskArrowIn />
              <span>Export voidmesh File</span>
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => importStudioFile()}
            disabled={isExporting || isImporting}
          >
            <Import />
            <span>Import voidmesh File</span>
          </Button>
        </div>
      )}

      <div className="last-row sidebar-row">
        <Hint className="sidebar-hint--image-selected" />
        {/* Export queue panel - shows all queued/active exports */}
        <ExportQueuePanel />
      </div>
    </form>
  );
};

interface ShaderSelectProps {
  shaderType: string;
  handleShaderTypeChange: (value: string | null) => void;
  isShaderMixed: boolean;
}

export function ShaderSelect({
  shaderType,
  handleShaderTypeChange,
  isShaderMixed,
}: ShaderSelectProps) {
  return (
    <Select
      label="Style"
      value={shaderType}
      onValueChange={handleShaderTypeChange}
      formatValue={isShaderMixed ? <span className="select-mixed">Mixed</span> : undefined}
      name="shader-type"
      items={SHADER_TYPE_OPTIONS}
    >
      {SHADER_TYPE_OPTIONS.map(({ label, value }) => (
        <SelectItem key={value} value={value}>
          {label}
        </SelectItem>
      ))}
    </Select>
  );
}

export function BlobParams() {
  const { updateSelectedEntityParams } = useCanvas();
  const eagerness = useParamValue("blobs.eagerness", config.defaults.shaderParams.blobs.eagerness);

  const handleEagernessChange = (value: number) => {
    if (value !== undefined) {
      updateSelectedEntityParams({ blobs: { eagerness: value } });
    }
  };

  if (!eagerness.isSupported) return null;

  return (
    <div className="sidebar-row eagerness-row">
      <Slider
        name="eagerness"
        label={eagerness.isMixed ? "Eagerness (Mixed)" : "Eagerness"}
        min={0}
        max={1}
        step={0.01}
        value={eagerness.value}
        onValueChange={handleEagernessChange}
        onPointerDown={() => {
          undo.beginTransaction();
        }}
        onValueCommitted={() => {
          undo.commitTransaction();
        }}
        showValue={!eagerness.isMixed}
      />
    </div>
  );
}

export function GlassParamsControl() {
  const { updateSelectedEntityParams } = useCanvas();
  const glassKind = useParamValue("glass.kind", config.defaults.shaderParams.glass!.kind);
  const angle = useParamValue("glass.angle", config.defaults.shaderParams.glass!.angle);
  const caustic = useParamValue("glass.caustic", config.defaults.shaderParams.glass!.caustic);
  const frostiness = useParamValue(
    "glass.frostiness",
    config.defaults.shaderParams.glass!.frostiness,
  );
  const highlight = useParamValue("glass.highlight", config.defaults.shaderParams.glass!.highlight);
  const dispersion = useParamValue(
    "glass.dispersion",
    config.defaults.shaderParams.glass!.dispersion,
  );
  const flow = useParamValue("glass.flow", config.defaults.shaderParams.glass!.flow);

  const handleGlassKindChange = (value: string | null) => {
    if (value) updateSelectedEntityParams({ glass: { kind: value as GlassKind } });
  };

  const handleAngleChange = (value: number) => {
    if (value !== undefined) {
      updateSelectedEntityParams({ glass: { angle: value } });
    }
  };

  const handleCausticChange = (value: number) => {
    if (value !== undefined) {
      updateSelectedEntityParams({ glass: { caustic: value } });
    }
  };

  const handleFrostinessChange = (value: number) => {
    if (value !== undefined) {
      updateSelectedEntityParams({ glass: { frostiness: value } });
    }
  };

  const handleHighlightChange = (value: number) => {
    if (value !== undefined) {
      updateSelectedEntityParams({ glass: { highlight: value } });
    }
  };

  const handleDispersionChange = (value: number) => {
    if (value !== undefined) {
      updateSelectedEntityParams({ glass: { dispersion: value } });
    }
  };

  const handleFlowChange = (value: number) => {
    if (value !== undefined) {
      updateSelectedEntityParams({ glass: { flow: value } });
    }
  };

  if (!glassKind.isSupported) return null;

  const isFluted = glassKind.value === GlassKind.fluted;
  const isFrosted = glassKind.value === GlassKind.frostedVoronoi;
  const isFlowing = glassKind.value === GlassKind.flowing;

  return (
    <>
      <div className="sidebar-row">
        <Select
          name="glass-kind"
          label="Glass Type"
          value={glassKind.isMixed ? "" : (glassKind.value ?? GlassKind.frostedVoronoi)}
          onValueChange={handleGlassKindChange}
          items={GLASS_KIND_OPTIONS}
        >
          {GLASS_KIND_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </Select>
      </div>
      {isFluted && (
        <>
          <div className="sidebar-row">
            <Slider
              name="angle"
              label={angle.isMixed ? "Angle (Mixed)" : "Angle"}
              min={0}
              max={360}
              step={1}
              value={angle.value}
              onValueChange={handleAngleChange}
              onPointerDown={() => undo.beginTransaction()}
              onValueCommitted={() => undo.commitTransaction()}
              showValue={!angle.isMixed}
            />
          </div>
          <div className="sidebar-row">
            <Slider
              name="caustic"
              label={caustic.isMixed ? "Caustic (Mixed)" : "Caustic"}
              min={0}
              max={2}
              step={0.01}
              value={caustic.value}
              onValueChange={handleCausticChange}
              onPointerDown={() => undo.beginTransaction()}
              onValueCommitted={() => undo.commitTransaction()}
              showValue={!caustic.isMixed}
            />
          </div>
        </>
      )}
      {isFrosted && (
        <>
          <div className="sidebar-row">
            <Slider
              name="frostiness"
              label={frostiness.isMixed ? "Frostiness (Mixed)" : "Frostiness"}
              min={0}
              max={1}
              step={0.01}
              value={frostiness.value}
              onValueChange={handleFrostinessChange}
              onPointerDown={() => undo.beginTransaction()}
              onValueCommitted={() => undo.commitTransaction()}
              showValue={!frostiness.isMixed}
            />
          </div>
          <div className="sidebar-row">
            <Slider
              name="highlight"
              label={highlight.isMixed ? "Highlight (Mixed)" : "Highlight"}
              min={0}
              max={1}
              step={0.01}
              value={highlight.value}
              onValueChange={handleHighlightChange}
              onPointerDown={() => undo.beginTransaction()}
              onValueCommitted={() => undo.commitTransaction()}
              showValue={!highlight.isMixed}
            />
          </div>
        </>
      )}
      {isFlowing && (
        <div className="sidebar-row">
          <Slider
            name="flow"
            label={flow.isMixed ? "Flow (Mixed)" : "Flow"}
            min={0}
            max={1}
            step={0.01}
            value={flow.value}
            onValueChange={handleFlowChange}
            onPointerDown={() => undo.beginTransaction()}
            onValueCommitted={() => undo.commitTransaction()}
            showValue={!flow.isMixed}
          />
        </div>
      )}
      <div className="sidebar-row">
        <Slider
          name="dispersion"
          label={dispersion.isMixed ? "Dispersion (Mixed)" : "Dispersion"}
          min={0}
          max={1}
          step={0.01}
          value={dispersion.value}
          onValueChange={handleDispersionChange}
          onPointerDown={() => undo.beginTransaction()}
          onValueCommitted={() => undo.commitTransaction()}
          showValue={!dispersion.isMixed}
        />
      </div>
    </>
  );
}

export function EffectParams({ show }: { show?: "scale" | "intensity" }) {
  const { updateSelectedEntityParams, selectedShaderType } = useCanvas();
  const scaleParam = useParamValue("scale", config.defaults.shaderParams.scale);
  const intensity = useParamValue("intensity", config.defaults.shaderParams.intensity);
  const isGlass = selectedShaderType === "glass";

  const handleScaleChange = (value: number | number[]) => {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined) {
      updateSelectedEntityParams({ scale: val });
    }
  };

  const handleIntensityChange = (value: number | number[]) => {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined) {
      updateSelectedEntityParams({ intensity: val });
    }
  };

  // Component only renders if intensity is supported (common to all effect shaders)
  if (!intensity.isSupported) return null;

  return (
    <>
      {(!show || show === "scale") && scaleParam.isSupported && (
        <div className="sidebar-row scale-row">
          <Slider
            name="scale"
            label={scaleParam.isMixed ? "Scale (Mixed)" : "Scale"}
            min={0.1}
            max={3.0}
            step={0.1}
            value={scaleParam.value ?? undefined}
            onValueChange={handleScaleChange}
            onPointerDown={() => {
              undo.beginTransaction();
            }}
            onValueCommitted={() => {
              undo.commitTransaction();
            }}
            showValue
          />
        </div>
      )}
      {(!show || show === "intensity") && (
        <div className="sidebar-row intensity-row">
          <Slider
            name="intensity"
            label={
              intensity.isMixed
                ? `${isGlass ? "Refraction" : "Effect Strength"} (Mixed)`
                : isGlass
                  ? "Refraction"
                  : "Effect Strength"
            }
            min={0}
            max={5.0}
            step={0.1}
            value={intensity.value ?? undefined}
            onValueChange={handleIntensityChange}
            onPointerDown={() => {
              undo.beginTransaction();
            }}
            onValueCommitted={() => {
              undo.commitTransaction();
            }}
            showValue={!intensity.isMixed}
          />
        </div>
      )}
    </>
  );
}

export function EntityParams() {
  // Use shared canvas actions hook with selectionState for multi-select
  const {
    selectedEntity,
    selectionState,
    handlePaletteChange,
    handlePaletteUpload,
    handleDeletePalette,
    handlePreserveColorsChange,
    handleReversePaletteChange,
    handleSizeChange,
  } = useCanvasActions();
  const { colorSpace } = useCanvas();
  const customPalettes = usePaletteStore();

  // Get control values with mixed awareness
  const preserveColors = useParamValue(
    "preserveColors",
    config.defaults.shaderParams.preserveColors,
  );
  const reversePalette = useParamValue(
    "reversePalette",
    config.defaults.shaderParams.reversePalette,
  );
  const size = useParamValue("size", config.defaults.shaderParams.size);
  const palette = useParamValue("palette", config.defaults.shaderParams.palette);
  // Early return only if no selection at all
  if (selectionState.isEmpty) return null;

  return (
    <>
      {/* Palette UI - only for shaders that support palettes */}
      {palette.isSupported && (
        <div className="sidebar-row palette-row">
          {palette.isMixed ? (
            <span className="palette-mixed">Mixed palettes</span>
          ) : (
            <ColorPalette
              onValueChange={handlePaletteChange}
              palette={palette.value ?? undefined}
              colorSpace={colorSpace}
              reversed={!!reversePalette.value}
              onDelete={
                palette.value?.id && isUserPalette(palette.value.id)
                  ? () => handleDeletePalette(palette.value.id!)
                  : undefined
              }
              canDelete={!!palette.value?.id && isUserPalette(palette.value.id)}
            />
          )}
          <PaletteUpload onUpload={handlePaletteUpload} />
        </div>
      )}
      {palette.isSupported && (
        <div className="sidebar-row">
          <ColorPalettePresets
            selectedPaletteId={palette.value?.id ?? null}
            onSelectPalette={handlePaletteChange}
            originalPalettes={selectedEntity?.originalPalettes}
            customPalettes={customPalettes}
            isMixed={palette.isMixed}
          />
        </div>
      )}
      {preserveColors.isSupported && (
        <div className="sidebar-row preserve-colors-row">
          <Checkbox
            name="preserve_colors"
            checked={!!preserveColors.value}
            indeterminate={preserveColors.isMixed}
            onChange={(e) => {
              // If mixed, clicking sets all to true; otherwise toggle
              const newValue = preserveColors.isMixed ? true : e.target.checked;
              handlePreserveColorsChange(newValue);
            }}
          >
            Preserve colors
          </Checkbox>
        </div>
      )}
      {reversePalette.isSupported && (
        <div className="sidebar-row reverse-palette-row">
          <Checkbox
            name="reverse_palette"
            checked={!!reversePalette.value}
            indeterminate={reversePalette.isMixed}
            onChange={(e) => {
              const newValue = reversePalette.isMixed ? true : e.target.checked;
              handleReversePaletteChange(newValue);
            }}
          >
            Reverse palette
          </Checkbox>
        </div>
      )}
      <div className="sidebar-row size-row">
        <NumberField
          label="Size"
          name="size"
          value={size.value}
          placeholder={size.isMixed ? "Mixed" : undefined}
          onValueChange={handleSizeChange}
          onChangeStart={() => {
            undo.beginTransaction();
          }}
          onValueCommitted={() => {
            undo.commitTransaction();
          }}
          max={100}
          min={1}
          enableScrubArea
          allowWheelScrub
        />
      </div>
      <ShapeKnobs />
    </>
  );
}
