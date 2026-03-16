import type { ChangeEvent } from "react";
import { useCanvas } from "../context/use-canvas.ts";
import { useCanvasActions, useParamValue } from "../hooks/use-canvas-actions.ts";
import { Slider } from "./ui/slider/index.tsx";
import { undo } from "#lib/undo.ts";
import { config } from "#config";
import "../styles/sidebar.css";
import {
  Collapsible,
  CollapsibleCheckbox,
  CollapsibleContent,
  CollapsibleGroup,
  CollapsibleTrigger,
} from "./ui/collapsible/collapsible.tsx";
import { NavArrowRight } from "iconoir-react";

const ppDefaults = config.defaults.shaderParams.postProcess!;

export function PostProcessingKnobs() {
  const { selectionState } = useCanvasActions();
  // Feature enabled states (read from the enabled property)

  // Early return if no selection
  if (selectionState.isEmpty) return null;

  return (
    <>
      {/* Grain Section */}
      <GrainKnobs />

      {/* Bloom Section */}
      <BloomKnobs />

      {/* Chromatic Aberration Section */}
      <ChromaticAberrationKnobs />

      {/* Depth of Field Section */}
      <DepthOfFieldKnobs />
    </>
  );
}

function GrainKnobs() {
  const { updateSelectedEntityParams } = useCanvas();

  const grainEnabled = useParamValue("postProcess.grain.enabled", ppDefaults.grain.enabled);

  // Individual effect values
  const grainSize = useParamValue("postProcess.grain.size", ppDefaults.grain.size);
  const grainIntensity = useParamValue("postProcess.grain.intensity", ppDefaults.grain.intensity);

  function handleGrainEnabledChange(e: ChangeEvent<HTMLInputElement>) {
    updateSelectedEntityParams({ postProcess: { grain: { enabled: e.target.checked } } });
  }

  function handleGrainSizeChange(value: number | number[]) {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined) updateSelectedEntityParams({ postProcess: { grain: { size: val } } });
  }

  function handleGrainIntensityChange(value: number | number[]) {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined)
      updateSelectedEntityParams({ postProcess: { grain: { intensity: val } } });
  }

  return (
    <Collapsible
      className="collapsible-depth-1"
      key={`grain-${!!grainEnabled.value}`}
      defaultOpen={!!grainEnabled.value}
    >
      <CollapsibleGroup>
        <CollapsibleTrigger>
          <NavArrowRight />
          Grain{grainEnabled.isMixed ? " (Mixed)" : ""}
        </CollapsibleTrigger>
        <CollapsibleCheckbox
          checked={grainEnabled.value}
          onChange={handleGrainEnabledChange}
          indeterminate={grainEnabled.isMixed}
          aria-label="Enable grain effect"
        />
      </CollapsibleGroup>
      <CollapsibleContent>
        <div className="sidebar-row">
          <Slider
            name="grain-size"
            label={grainSize.isMixed ? "Grain Size (Mixed)" : "Grain Size"}
            min={config.postProcessing.grain.size.min}
            max={config.postProcessing.grain.size.max}
            step={config.postProcessing.grain.size.step}
            value={grainSize.value}
            onValueChange={handleGrainSizeChange}
            onInteractionStart={() => undo.beginTransaction()}
            onValueCommitted={() => undo.commitTransaction()}
            showValue={!grainSize.isMixed}
          />
        </div>
        <div className="sidebar-row">
          <Slider
            name="grain-intensity"
            label={grainIntensity.isMixed ? "Grain Intensity (Mixed)" : "Grain Intensity"}
            min={config.postProcessing.grain.intensity.min}
            max={config.postProcessing.grain.intensity.max}
            step={config.postProcessing.grain.intensity.step}
            value={grainIntensity.value}
            onValueChange={handleGrainIntensityChange}
            onInteractionStart={() => undo.beginTransaction()}
            onValueCommitted={() => undo.commitTransaction()}
            showValue={!grainIntensity.isMixed}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ChromaticAberrationKnobs() {
  const { updateSelectedEntityParams } = useCanvas();
  const chromaticEnabled = useParamValue(
    "postProcess.chromaticAberration.enabled",
    ppDefaults.chromaticAberration.enabled,
  );

  // Individual effect values
  const chromaticOffset = useParamValue(
    "postProcess.chromaticAberration.offset",
    ppDefaults.chromaticAberration.offset,
  );

  function handleChromaticEnabledChange(e: ChangeEvent<HTMLInputElement>) {
    updateSelectedEntityParams({
      postProcess: { chromaticAberration: { enabled: e.target.checked } },
    });
  }

  function handleChromaticOffsetChange(value: number | number[]) {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined)
      updateSelectedEntityParams({ postProcess: { chromaticAberration: { offset: val } } });
  }
  return (
    <Collapsible
      className="collapsible-depth-1"
      key={`chromatic-${!!chromaticEnabled.value}`}
      defaultOpen={!!chromaticEnabled.value}
    >
      <CollapsibleGroup>
        <CollapsibleTrigger>
          <NavArrowRight />
          Chromatic Aberration{chromaticEnabled.isMixed ? " (Mixed)" : ""}
        </CollapsibleTrigger>
        <CollapsibleCheckbox
          checked={chromaticEnabled.value}
          indeterminate={chromaticEnabled.isMixed}
          onChange={handleChromaticEnabledChange}
          aria-label="Enable chromatic aberration effect"
        />
      </CollapsibleGroup>
      <CollapsibleContent>
        <div className="sidebar-row">
          <Slider
            name="chromatic-offset"
            label={chromaticOffset.isMixed ? "Offset (Mixed)" : "Offset"}
            min={config.postProcessing.chromaticAberration.offset.min}
            max={config.postProcessing.chromaticAberration.offset.max}
            step={config.postProcessing.chromaticAberration.offset.step}
            value={chromaticOffset.value}
            onValueChange={handleChromaticOffsetChange}
            onInteractionStart={() => undo.beginTransaction()}
            onValueCommitted={() => undo.commitTransaction()}
            showValue={!chromaticOffset.isMixed}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DepthOfFieldKnobs() {
  const { updateSelectedEntityParams } = useCanvas();
  const dofEnabled = useParamValue(
    "postProcess.depthOfField.enabled",
    ppDefaults.depthOfField.enabled,
  );
  const focalDepth = useParamValue(
    "postProcess.depthOfField.focalDepth",
    ppDefaults.depthOfField.focalDepth,
  );
  const focalRange = useParamValue(
    "postProcess.depthOfField.focalRange",
    ppDefaults.depthOfField.focalRange,
  );
  const blurStrength = useParamValue(
    "postProcess.depthOfField.blurStrength",
    ppDefaults.depthOfField.blurStrength,
  );

  function handleDofEnabledChange(e: ChangeEvent<HTMLInputElement>) {
    updateSelectedEntityParams({
      postProcess: { depthOfField: { enabled: e.target.checked } },
    });
  }

  function handleFocalDepthChange(value: number | number[]) {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined)
      updateSelectedEntityParams({ postProcess: { depthOfField: { focalDepth: val } } });
  }

  function handleFocalRangeChange(value: number | number[]) {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined)
      updateSelectedEntityParams({ postProcess: { depthOfField: { focalRange: val } } });
  }

  function handleBlurStrengthChange(value: number | number[]) {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined)
      updateSelectedEntityParams({ postProcess: { depthOfField: { blurStrength: val } } });
  }

  return (
    <Collapsible
      className="collapsible-depth-1"
      key={`dof-${!!dofEnabled.value}`}
      defaultOpen={!!dofEnabled.value}
    >
      <CollapsibleGroup>
        <CollapsibleTrigger>
          <NavArrowRight />
          Depth of Field{dofEnabled.isMixed ? " (Mixed)" : ""}
        </CollapsibleTrigger>
        <CollapsibleCheckbox
          checked={dofEnabled.value}
          indeterminate={dofEnabled.isMixed}
          onChange={handleDofEnabledChange}
          aria-label="Enable depth of field effect"
        />
      </CollapsibleGroup>
      <CollapsibleContent>
        <div className="sidebar-row">
          <Slider
            name="dof-focal-depth"
            label={focalDepth.isMixed ? "Focus (Mixed)" : "Focus"}
            min={config.postProcessing.depthOfField.focalDepth.min}
            max={config.postProcessing.depthOfField.focalDepth.max}
            step={config.postProcessing.depthOfField.focalDepth.step}
            value={focalDepth.value}
            onValueChange={handleFocalDepthChange}
            onInteractionStart={() => undo.beginTransaction()}
            onValueCommitted={() => undo.commitTransaction()}
            showValue={!focalDepth.isMixed}
          />
        </div>
        <div className="sidebar-row">
          <Slider
            name="dof-focal-range"
            label={focalRange.isMixed ? "Range (Mixed)" : "Range"}
            min={config.postProcessing.depthOfField.focalRange.min}
            max={config.postProcessing.depthOfField.focalRange.max}
            step={config.postProcessing.depthOfField.focalRange.step}
            value={focalRange.value}
            onValueChange={handleFocalRangeChange}
            onInteractionStart={() => undo.beginTransaction()}
            onValueCommitted={() => undo.commitTransaction()}
            showValue={!focalRange.isMixed}
          />
        </div>
        <div className="sidebar-row">
          <Slider
            name="dof-blur-strength"
            label={blurStrength.isMixed ? "Strength (Mixed)" : "Strength"}
            min={config.postProcessing.depthOfField.blurStrength.min}
            max={config.postProcessing.depthOfField.blurStrength.max}
            step={config.postProcessing.depthOfField.blurStrength.step}
            value={blurStrength.value}
            onValueChange={handleBlurStrengthChange}
            onInteractionStart={() => undo.beginTransaction()}
            onValueCommitted={() => undo.commitTransaction()}
            showValue={!blurStrength.isMixed}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function BloomKnobs() {
  const { updateSelectedEntityParams } = useCanvas();
  // Feature enabled states (read from the enabled property)
  const bloomEnabled = useParamValue("postProcess.bloom.enabled", ppDefaults.bloom.enabled);

  // Individual effect values
  const bloomThreshold = useParamValue("postProcess.bloom.threshold", ppDefaults.bloom.threshold);
  const bloomIntensity = useParamValue("postProcess.bloom.intensity", ppDefaults.bloom.intensity);
  const bloomFilterRadius = useParamValue(
    "postProcess.bloom.filterRadius",
    ppDefaults.bloom.filterRadius,
  );
  const bloomSoftness = useParamValue("postProcess.bloom.softness", ppDefaults.bloom.softness);

  function handleBloomEnabledChange(e: ChangeEvent<HTMLInputElement>) {
    updateSelectedEntityParams({ postProcess: { bloom: { enabled: e.target.checked } } });
  }

  function handleBloomThresholdChange(value: number | number[]) {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined)
      updateSelectedEntityParams({ postProcess: { bloom: { threshold: val } } });
  }

  function handleBloomIntensityChange(value: number | number[]) {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined)
      updateSelectedEntityParams({ postProcess: { bloom: { intensity: val } } });
  }

  function handleBloomFilterRadiusChange(value: number | number[]) {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined)
      updateSelectedEntityParams({ postProcess: { bloom: { filterRadius: val } } });
  }

  function handleBloomSoftnessChange(value: number | number[]) {
    const val = Array.isArray(value) ? value[0] : value;
    if (val !== undefined)
      updateSelectedEntityParams({ postProcess: { bloom: { softness: val } } });
  }

  return (
    <Collapsible
      className="collapsible-depth-1"
      key={`bloom-${!!bloomEnabled.value}`}
      defaultOpen={!!bloomEnabled.value}
    >
      <CollapsibleGroup>
        <CollapsibleTrigger>
          <NavArrowRight />
          Bloom{bloomEnabled.isMixed ? " (Mixed)" : ""}
        </CollapsibleTrigger>
        <CollapsibleCheckbox
          checked={bloomEnabled.value}
          indeterminate={bloomEnabled.isMixed}
          onChange={handleBloomEnabledChange}
          aria-label="Enable bloom effect"
        />
      </CollapsibleGroup>
      <CollapsibleContent>
        <div className="sidebar-row">
          <Slider
            name="bloom-threshold"
            label={bloomThreshold.isMixed ? "Threshold (Mixed)" : "Threshold"}
            min={config.postProcessing.bloom.threshold.min}
            max={config.postProcessing.bloom.threshold.max}
            step={config.postProcessing.bloom.threshold.step}
            value={bloomThreshold.value}
            onValueChange={handleBloomThresholdChange}
            onInteractionStart={() => undo.beginTransaction()}
            onValueCommitted={() => undo.commitTransaction()}
            showValue={!bloomThreshold.isMixed}
          />
        </div>
        <div className="sidebar-row">
          <Slider
            name="bloom-intensity"
            label={bloomIntensity.isMixed ? "Intensity (Mixed)" : "Intensity"}
            min={config.postProcessing.bloom.intensity.min}
            max={config.postProcessing.bloom.intensity.max}
            step={config.postProcessing.bloom.intensity.step}
            value={bloomIntensity.value}
            onValueChange={handleBloomIntensityChange}
            onInteractionStart={() => undo.beginTransaction()}
            onValueCommitted={() => undo.commitTransaction()}
            showValue={!bloomIntensity.isMixed}
          />
        </div>
        <div className="sidebar-row">
          <Slider
            name="bloom-filter-radius"
            label={bloomFilterRadius.isMixed ? "Spread (Mixed)" : "Spread"}
            min={config.postProcessing.bloom.filterRadius.min}
            max={config.postProcessing.bloom.filterRadius.max}
            step={config.postProcessing.bloom.filterRadius.step}
            value={bloomFilterRadius.value}
            onValueChange={handleBloomFilterRadiusChange}
            onInteractionStart={() => undo.beginTransaction()}
            onValueCommitted={() => undo.commitTransaction()}
            showValue={!bloomFilterRadius.isMixed}
          />
        </div>
        <div className="sidebar-row">
          <Slider
            name="bloom-softness"
            label={bloomSoftness.isMixed ? "Softness (Mixed)" : "Softness"}
            min={config.postProcessing.bloom.softness.min}
            max={config.postProcessing.bloom.softness.max}
            step={config.postProcessing.bloom.softness.step}
            value={bloomSoftness.value}
            onValueChange={handleBloomSoftnessChange}
            onInteractionStart={() => undo.beginTransaction()}
            onValueCommitted={() => undo.commitTransaction()}
            showValue={!bloomSoftness.isMixed}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
