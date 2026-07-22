import { type ChangeEvent } from "react";
import { DropletHalf, Eye, NavArrowRight } from "iconoir-react";
import {
  useCanvasRendererService,
  useHasEntities,
  useHasSelection,
  useHasUniformSelectedShader,
  useCanvasCommands,
  useSelectedEntity,
  useSelectedEntities,
  useSelectedShaderType,
} from "#context/use-canvas.ts";
import {
  SHADER_TYPE_OPTIONS,
  GlassKind,
  GLASS_KIND_OPTIONS,
  GlitchKind,
  GLITCH_KIND_OPTIONS,
  CAUSTICS_KIND_OPTIONS,
  IRIDESCENCE_KIND_OPTIONS,
  TOPOGRAPHIC_KIND_OPTIONS,
} from "#types/canvas.ts";
import { useParamValue } from "#hooks/use-param-value.ts";
import { analytics } from "#lib/analytics.ts";
import { Button } from "./ui/button/index.tsx";
import { Select, SelectItem } from "./ui/select/index.tsx";
import { Toggle } from "./ui/toggle/index.tsx";
import { Slider } from "./ui/slider/index.tsx";
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
import { isUserPalette } from "#application/canvas/palettes.ts";
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
import { WorkspaceActions } from "#components/workspace-actions/workspace-actions.tsx";

interface SidebarRightControlsProps {
  className?: string;
  /** If true, renders minimal UI suitable for mobile */
  compact?: boolean;
}

export const SidebarRightControls = ({ className, compact }: SidebarRightControlsProps) => {
  const hasEntities = useHasEntities();
  const hasSelection = useHasSelection();
  const {
    exportStudioFile,
    importStudioFile,
    clearWorkspace,
    hasActiveWorkspaceFile,
    activeWorkspaceFileName,
    isExporting,
    isImporting,
  } = useStudioFile();

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
          {!hasSelection && <EmptySelectionMessage hasEntities={hasEntities} />}
          {hasSelection && <SelectedSidebarSections />}
          {hasSelection && <SelectionFooterSections />}
        </div>
      </div>

      {hasSelection && <DesktopTimeSlider />}

      {!hasSelection && (
        <WorkspaceActions
          hasEntities={hasEntities}
          exportStudioFile={exportStudioFile}
          importStudioFile={importStudioFile}
          clearWorkspace={clearWorkspace}
          hasActiveWorkspaceFile={hasActiveWorkspaceFile}
          activeWorkspaceFileName={activeWorkspaceFileName}
          isExporting={isExporting}
          isImporting={isImporting}
        />
      )}

      <div className="last-row">
        {/* Export queue panel - shows all queued/active exports */}
        <ExportQueuePanel />
      </div>
    </form>
  );
};

function EmptySelectionMessage({ hasEntities }: { hasEntities: boolean }) {
  return (
    <div className="sidebar-row no-selection-message">
      <p>
        {hasEntities
          ? "Select an image or video on the canvas to edit it"
          : "Drop or paste images, videos and links for editing"}
      </p>
    </div>
  );
}

function SelectedSidebarSections() {
  return (
    <>
      <SelectionHeaderSection />
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
          <GlitchParamsControl />
          <SimpleSubtypeControl
            paramPath="caustics.kind"
            defaultValue={config.defaults.shaderParams.caustics!.kind}
            label="Caustics Type"
            name="caustics-kind"
            options={CAUSTICS_KIND_OPTIONS}
            onChangeCommand="changeCausticsKind"
          />
          <SimpleSubtypeControl
            paramPath="iridescence.kind"
            defaultValue={config.defaults.shaderParams.iridescence!.kind}
            label="Iridescence Type"
            name="iridescence-kind"
            options={IRIDESCENCE_KIND_OPTIONS}
            onChangeCommand="changeIridescenceKind"
          />
          <SimpleSubtypeControl
            paramPath="topographic.kind"
            defaultValue={config.defaults.shaderParams.topographic!.kind}
            label="Topographic Type"
            name="topographic-kind"
            options={TOPOGRAPHIC_KIND_OPTIONS}
            onChangeCommand="changeTopographicKind"
          />
          <DitheringKnobs />
          <AsciiKnobs />
          <EffectParams />
          <EntityParams />
        </CollapsibleContent>
      </Collapsible>
      <hr className="divider" />
      <PostProcessingSection />
    </>
  );
}

function SelectionHeaderSection() {
  const { changeShaderType, setShowOriginal, resetSelectionToDefaults } = useCanvasCommands();
  const selectedShaderType = useSelectedShaderType();
  const hasUniformShader = useHasUniformSelectedShader();
  const showOriginalEnabled = useParamValue(
    "showOriginal",
    config.defaults.shaderParams.showOriginal,
  );

  return (
    <>
      <div className="sidebar-row shader-type-row">
        <ShaderSelect
          shaderType={selectedShaderType}
          handleShaderTypeChange={changeShaderType}
          isShaderMixed={!hasUniformShader}
        />
      </div>
      <div className="sidebar-row show-original-row">
        <Toggle
          pressed={!!showOriginalEnabled.value}
          onPressedChange={(pressed) => {
            const newValue = showOriginalEnabled.isMixed ? true : pressed;
            setShowOriginal(newValue);
          }}
          title="Show original"
        >
          <Eye /> Original
        </Toggle>
        <Button variant="secondary" size="sm" onClick={resetSelectionToDefaults}>
          Reset
        </Button>
      </div>
    </>
  );
}

function PostProcessingSection() {
  const { updateSelectedEntityParams } = useCanvasCommands();
  const postProcessEnabled = useParamValue(
    "postProcess.enabled",
    config.defaults.shaderParams.postProcess.enabled,
  );

  const handlePpEnabledChange = (e: ChangeEvent<HTMLInputElement>) => {
    updateSelectedEntityParams({
      postProcess: { enabled: e.target.checked },
    });
  };

  return (
    <Collapsible key={`pp-${!!postProcessEnabled.value}`} defaultOpen={!!postProcessEnabled.value}>
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
  );
}

function SelectionFooterSections() {
  return (
    <Collapsible>
      <CollapsibleTrigger className="sidebar-collapsible-trigger">
        <NavArrowRight />
        Export
      </CollapsibleTrigger>
      <CollapsibleContent className="exports-content">
        <DesktopExportKnobs />
      </CollapsibleContent>
    </Collapsible>
  );
}

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
  const selectedEntities = useSelectedEntities();
  const handleChange = (value: string | null) => {
    if (!value || value === shaderType) return;
    analytics.track("shader.changed", {
      from: isShaderMixed ? "mixed" : shaderType,
      to: value,
      entity_count: selectedEntities.length,
    });
    handleShaderTypeChange(value);
  };

  return (
    <Select
      label="Style"
      value={shaderType}
      onValueChange={handleChange}
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
  const { updateSelectedEntityParams } = useCanvasCommands();
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
        onInteractionStart={() => {
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

function SimpleSubtypeControl({
  paramPath,
  defaultValue,
  label,
  name,
  options,
  onChangeCommand,
}: {
  paramPath: "caustics.kind" | "iridescence.kind" | "topographic.kind";
  defaultValue: string;
  label: string;
  name: string;
  options: readonly { value: string; label: string }[];
  onChangeCommand: "changeCausticsKind" | "changeIridescenceKind" | "changeTopographicKind";
}) {
  const commands = useCanvasCommands();
  const kind = useParamValue(paramPath, defaultValue as never);
  if (!kind.isSupported) return null;
  return (
    <div className="sidebar-row">
      <Select
        name={name}
        label={label}
        value={kind.isMixed ? "" : (kind.value ?? defaultValue)}
        onValueChange={commands[onChangeCommand]}
        items={options}
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </Select>
    </div>
  );
}

export function GlassParamsControl() {
  const { updateSelectedEntityParams, changeGlassKind } = useCanvasCommands();
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
          onValueChange={changeGlassKind}
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
              onInteractionStart={() => undo.beginTransaction()}
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
              onInteractionStart={() => undo.beginTransaction()}
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
              onInteractionStart={() => undo.beginTransaction()}
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
              onInteractionStart={() => undo.beginTransaction()}
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
            onInteractionStart={() => undo.beginTransaction()}
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
          onInteractionStart={() => undo.beginTransaction()}
          onValueCommitted={() => undo.commitTransaction()}
          showValue={!dispersion.isMixed}
        />
      </div>
    </>
  );
}

export function GlitchParamsControl() {
  const { updateSelectedEntityParams, changeGlitchKind } = useCanvasCommands();
  const glitchKind = useParamValue("glitch.kind", config.defaults.shaderParams.glitch!.kind);
  const angle = useParamValue("glitch.angle", config.defaults.shaderParams.glitch!.angle);

  const handleAngleChange = (value: number) => {
    if (value !== undefined) {
      updateSelectedEntityParams({ glitch: { angle: value } });
    }
  };

  if (!glitchKind.isSupported) return null;

  const showAngle =
    glitchKind.value === GlitchKind.channelShift || glitchKind.value === GlitchKind.pixelSmear;

  return (
    <>
      <div className="sidebar-row">
        <Select
          name="glitch-kind"
          label="Glitch Type"
          value={glitchKind.isMixed ? "Mixed" : (glitchKind.value ?? GlitchKind.channelShift)}
          onValueChange={changeGlitchKind}
          items={GLITCH_KIND_OPTIONS}
        >
          {GLITCH_KIND_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </Select>
      </div>
      {showAngle && (
        <div className="sidebar-row">
          <Slider
            name="glitch-angle"
            label={angle.isMixed ? "Angle (Mixed)" : "Angle"}
            min={0}
            max={360}
            step={1}
            value={angle.value}
            onValueChange={handleAngleChange}
            onInteractionStart={() => undo.beginTransaction()}
            onValueCommitted={() => undo.commitTransaction()}
            showValue={!angle.isMixed}
          />
        </div>
      )}
    </>
  );
}

export function EffectParams({ show }: { show?: "scale" | "intensity" }) {
  const { updateSelectedEntityParams } = useCanvasCommands();
  const selectedShaderType = useSelectedShaderType();
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
            onInteractionStart={() => {
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
            onInteractionStart={() => {
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
  const hasSelection = useHasSelection();
  if (!hasSelection) return null;

  return (
    <>
      <PaletteEditorSection />
      <PalettePresetsSection />
      <PaletteToggleSection />
      <SizeSection />
      <ShapeSection />
    </>
  );
}

function PaletteEditorSection() {
  const { changePalette, renamePalette, uploadPalette, deletePalette } = useCanvasCommands();
  const { colorSpace } = useCanvasRendererService();
  const reversePalette = useParamValue(
    "reversePalette",
    config.defaults.shaderParams.reversePalette,
  );
  const palette = useParamValue("palette", config.defaults.shaderParams.palette);
  if (!palette.isSupported) return null;

  return (
    <div className="sidebar-row palette-row">
      {palette.isMixed ? (
        <span className="palette-mixed">Mixed palettes</span>
      ) : (
        <ColorPalette
          onValueChange={changePalette}
          palette={palette.value ?? undefined}
          colorSpace={colorSpace}
          reversed={!!reversePalette.value}
          onRename={
            palette.value?.id && isUserPalette(palette.value.id)
              ? (name) => renamePalette(palette.value!.id!, name)
              : undefined
          }
          onDelete={
            palette.value?.id && isUserPalette(palette.value.id)
              ? () => deletePalette(palette.value.id!)
              : undefined
          }
          canRename={!!palette.value?.id && isUserPalette(palette.value.id)}
          canDelete={!!palette.value?.id && isUserPalette(palette.value.id)}
        />
      )}
      <PaletteUpload onUpload={uploadPalette} />
    </div>
  );
}

function PalettePresetsSection() {
  const { changePalette } = useCanvasCommands();
  const selectedEntity = useSelectedEntity();
  const customPalettes = usePaletteStore();
  const palette = useParamValue("palette", config.defaults.shaderParams.palette);

  if (!palette.isSupported) return null;

  return (
    <div className="sidebar-row">
      <ColorPalettePresets
        selectedPaletteId={palette.value?.id ?? null}
        onSelectPalette={changePalette}
        originalPalette={selectedEntity?.originalPalette}
        customPalettes={customPalettes}
        isMixed={palette.isMixed}
      />
    </div>
  );
}

function PaletteToggleSection() {
  const { setPreserveColors, setReversePalette } = useCanvasCommands();
  const preserveColors = useParamValue(
    "preserveColors",
    config.defaults.shaderParams.preserveColors,
  );
  const reversePalette = useParamValue(
    "reversePalette",
    config.defaults.shaderParams.reversePalette,
  );

  if (!preserveColors.isSupported && !reversePalette.isSupported) return null;

  return (
    <div className="sidebar-row palette-toggles">
      {preserveColors.isSupported && (
        <Toggle
          pressed={!!preserveColors.value}
          onPressedChange={(pressed) => {
            const newValue = preserveColors.isMixed ? true : pressed;
            setPreserveColors(newValue);
          }}
          title="Preserve colors"
        >
          <span className="palette-icon" data-pressed={!!preserveColors.value || undefined} />{" "}
          Preserve
        </Toggle>
      )}
      {reversePalette.isSupported && (
        <Toggle
          pressed={!!reversePalette.value}
          onPressedChange={(pressed) => {
            const newValue = reversePalette.isMixed ? true : pressed;
            setReversePalette(newValue);
          }}
          title="Reverse palette"
        >
          <DropletHalf /> Reverse
        </Toggle>
      )}
    </div>
  );
}

function SizeSection() {
  const { changeSize } = useCanvasCommands();
  const size = useParamValue("size", config.defaults.shaderParams.size);

  return (
    <div className="sidebar-row size-row">
      <Slider
        label={size.isMixed ? "Size (Mixed)" : "Size"}
        name="size"
        value={size.value}
        onValueChange={changeSize}
        onInteractionStart={() => {
          undo.beginTransaction();
        }}
        onValueCommitted={() => {
          undo.commitTransaction();
        }}
        max={100}
        min={1}
        step={1}
        showValue={!size.isMixed}
      />
    </div>
  );
}

function ShapeSection() {
  return <ShapeKnobs />;
}
