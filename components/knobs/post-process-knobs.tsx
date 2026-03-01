import { useCanvas } from "#context/use-canvas.ts";
import { useParamValue } from "#hooks/use-param-value.ts";
import { config } from "#config";
import { undo } from "#lib/undo.ts";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  SliderPicker,
  SliderPickerItem,
  SliderPickerOptions,
  SliderPickerWindow,
} from "../ui/slider-picker";
import "./knobs.css";
import type { ParamPaths } from "#types/canvas.ts";
import { InfiniteSlider } from "../ui/infinite-slider";

const ppDefaults = config.defaults.shaderParams.postProcess!;

/** Map actual value to UI range (0-100) */
function toUiValue(actual: number, min: number, max: number): number {
  return Math.round(((actual - min) / (max - min)) * 100);
}

/** Map UI value (0-100) to actual range, with precision to avoid floating point noise */
function fromUiValue(ui: number, min: number, max: number, precision = 3): number {
  const value = min + (ui / 100) * (max - min);
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

/** Format value for display in button (percentage of range, 0-100) */
function formatParamValue(value: number, min: number, max: number): string {
  return `${Math.round(((value - min) / (max - min)) * 100)}`;
}

// Flattened post-process parameters - each becomes its own selectable item
const PostProcessParamsInOrder = [
  {
    value: "postProcess.grain.size",
    label: "Grain Size",
    effect: "grain" as const,
    param: "size",
    min: config.postProcessing.grain.size.min,
    max: config.postProcessing.grain.size.max,
    defaultValue: ppDefaults.grain.size,
  },
  {
    value: "postProcess.grain.intensity",
    label: "Grain Intensity",
    effect: "grain" as const,
    param: "intensity",
    min: config.postProcessing.grain.intensity.min,
    max: config.postProcessing.grain.intensity.max,
    defaultValue: ppDefaults.grain.intensity,
  },
  {
    value: "postProcess.bloom.threshold",
    label: "Bloom Threshold",
    effect: "bloom" as const,
    param: "threshold",
    min: config.postProcessing.bloom.threshold.min,
    max: config.postProcessing.bloom.threshold.max,
    defaultValue: ppDefaults.bloom.threshold,
  },
  {
    value: "postProcess.bloom.intensity",
    label: "Bloom Intensity",
    effect: "bloom" as const,
    param: "intensity",
    min: config.postProcessing.bloom.intensity.min,
    max: config.postProcessing.bloom.intensity.max,
    defaultValue: ppDefaults.bloom.intensity,
  },
  {
    value: "postProcess.bloom.filterRadius",
    label: "Bloom Spread",
    effect: "bloom" as const,
    param: "filterRadius",
    min: config.postProcessing.bloom.filterRadius.min,
    max: config.postProcessing.bloom.filterRadius.max,
    defaultValue: ppDefaults.bloom.filterRadius,
  },
  {
    value: "postProcess.bloom.softness",
    label: "Bloom Softness",
    effect: "bloom" as const,
    param: "softness",
    min: config.postProcessing.bloom.softness.min,
    max: config.postProcessing.bloom.softness.max,
    defaultValue: ppDefaults.bloom.softness,
  },
  {
    value: "postProcess.chromaticAberration.offset",
    label: "Chromatic",
    effect: "chromaticAberration" as const,
    param: "offset",
    min: config.postProcessing.chromaticAberration.offset.min,
    max: config.postProcessing.chromaticAberration.offset.max,
    defaultValue: ppDefaults.chromaticAberration.offset,
  },
] as const satisfies {
  value: ParamPaths;
  label: string;
  effect: string;
  param: string;
  min: number;
  max: number;
  defaultValue: number;
}[];

type PostProcessParam = (typeof PostProcessParamsInOrder)[number];

export function PostProcessMobileKnobs() {
  const [selectedParam, setSelectedParam] = useState<PostProcessParam>(PostProcessParamsInOrder[0]);
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { updateSelectedEntityParams } = useCanvas();

  // Read enabled states for all effects
  const grainEnabled = useParamValue("postProcess.grain.enabled", ppDefaults.grain.enabled);
  const bloomEnabled = useParamValue("postProcess.bloom.enabled", ppDefaults.bloom.enabled);
  const chromaticEnabled = useParamValue(
    "postProcess.chromaticAberration.enabled",
    ppDefaults.chromaticAberration.enabled,
  );

  // Read current values for all parameters
  const grainSize = useParamValue("postProcess.grain.size", ppDefaults.grain.size);
  const grainIntensity = useParamValue("postProcess.grain.intensity", ppDefaults.grain.intensity);
  const bloomThreshold = useParamValue("postProcess.bloom.threshold", ppDefaults.bloom.threshold);
  const bloomIntensity = useParamValue("postProcess.bloom.intensity", ppDefaults.bloom.intensity);
  const bloomFilterRadius = useParamValue(
    "postProcess.bloom.filterRadius",
    ppDefaults.bloom.filterRadius,
  );
  const bloomSoftness = useParamValue("postProcess.bloom.softness", ppDefaults.bloom.softness);
  const chromaticOffset = useParamValue(
    "postProcess.chromaticAberration.offset",
    ppDefaults.chromaticAberration.offset,
  );

  // Map effect to enabled state
  const getEnabledState = (effect: PostProcessParam["effect"]): boolean => {
    switch (effect) {
      case "grain":
        return grainEnabled.value ?? false;
      case "bloom":
        return bloomEnabled.value ?? false;
      case "chromaticAberration":
        return chromaticEnabled.value ?? false;
    }
  };

  // Check if effect enabled state is mixed across selected entities
  const getEnabledIsMixed = (effect: PostProcessParam["effect"]): boolean => {
    switch (effect) {
      case "grain":
        return grainEnabled.isMixed;
      case "bloom":
        return bloomEnabled.isMixed;
      case "chromaticAberration":
        return chromaticEnabled.isMixed;
      default:
        effect satisfies never;
        return false;
    }
  };

  // Toggle handler for effect enabled state (mixed-aware: clicking when mixed sets all to true)
  const handleToggle = (effect: PostProcessParam["effect"], newChecked: boolean) => {
    const isMixed = getEnabledIsMixed(effect);
    const value = isMixed ? true : newChecked;
    switch (effect) {
      case "grain":
        updateSelectedEntityParams({ postProcess: { grain: { enabled: value } } });
        break;
      case "bloom":
        updateSelectedEntityParams({ postProcess: { bloom: { enabled: value } } });
        break;
      case "chromaticAberration":
        updateSelectedEntityParams({
          postProcess: { chromaticAberration: { enabled: value } },
        });
        break;
      default:
        effect satisfies never;
    }
  };

  // Get current value for a parameter
  const getParamValue = (param: PostProcessParam): number => {
    switch (param.value) {
      case "postProcess.grain.size":
        return grainSize.value ?? param.defaultValue;
      case "postProcess.grain.intensity":
        return grainIntensity.value ?? param.defaultValue;
      case "postProcess.bloom.threshold":
        return bloomThreshold.value ?? param.defaultValue;
      case "postProcess.bloom.intensity":
        return bloomIntensity.value ?? param.defaultValue;
      case "postProcess.bloom.filterRadius":
        return bloomFilterRadius.value ?? param.defaultValue;
      case "postProcess.bloom.softness":
        return bloomSoftness.value ?? param.defaultValue;
      case "postProcess.chromaticAberration.offset":
        return chromaticOffset.value ?? param.defaultValue;
      default:
        param satisfies never;
        return 0;
    }
  };

  // Check if a parameter has mixed values across selected entities
  const getParamIsMixed = (param: PostProcessParam): boolean => {
    switch (param.value) {
      case "postProcess.grain.size":
        return grainSize.isMixed;
      case "postProcess.grain.intensity":
        return grainIntensity.isMixed;
      case "postProcess.bloom.threshold":
        return bloomThreshold.isMixed;
      case "postProcess.bloom.intensity":
        return bloomIntensity.isMixed;
      case "postProcess.bloom.filterRadius":
        return bloomFilterRadius.isMixed;
      case "postProcess.bloom.softness":
        return bloomSoftness.isMixed;
      case "postProcess.chromaticAberration.offset":
        return chromaticOffset.isMixed;
      default:
        param satisfies never;
        return false;
    }
  };

  // Update handler for parameter value
  const handleParamChange = (param: PostProcessParam, uiValue: number) => {
    const actualValue = fromUiValue(uiValue, param.min, param.max);

    switch (param.value) {
      case "postProcess.grain.size":
        updateSelectedEntityParams({ postProcess: { grain: { size: actualValue } } });
        break;
      case "postProcess.grain.intensity":
        updateSelectedEntityParams({ postProcess: { grain: { intensity: actualValue } } });
        break;
      case "postProcess.bloom.threshold":
        updateSelectedEntityParams({ postProcess: { bloom: { threshold: actualValue } } });
        break;
      case "postProcess.bloom.intensity":
        updateSelectedEntityParams({ postProcess: { bloom: { intensity: actualValue } } });
        break;
      case "postProcess.bloom.filterRadius":
        updateSelectedEntityParams({ postProcess: { bloom: { filterRadius: actualValue } } });
        break;
      case "postProcess.bloom.softness":
        updateSelectedEntityParams({ postProcess: { bloom: { softness: actualValue } } });
        break;
      case "postProcess.chromaticAberration.offset":
        updateSelectedEntityParams({
          postProcess: { chromaticAberration: { offset: actualValue } },
        });
        break;
      default:
        param satisfies never;
    }
  };

  const showFloatingLabel = (text: string) => {
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    setFloatingLabel(text);
    floatingLabelTimeoutRef.current = setTimeout(
      () => setFloatingLabel(null),
      config.ui.floatingParamLabelHideTimeoutMs,
    );
  };

  useEffect(
    () => () => {
      if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    },
    [],
  );

  // Show floating label on interaction start
  const handleSliderInteractionStart = () => {
    const isMixed = getParamIsMixed(selectedParam);
    showFloatingLabel(selectedParam.label + (isMixed ? " (Mixed)" : ""));
  };

  // Hide floating label after timeout when scrolling stops
  const handleSliderValueCommit = () => {
    floatingLabelTimeoutRef.current = setTimeout(() => {
      setFloatingLabel(null);
    }, config.ui.floatingParamLabelHideTimeoutMs);
  };

  return (
    <div className="post-process-knobs">
      {/* Floating label - rendered via portal to appear above media controls */}
      {floatingLabel &&
        createPortal(
          <div className="mobile-style-knobs__floating-label" data-visible>
            {floatingLabel}
          </div>,
          document.body,
        )}

      {/* Parameter selector with toggle */}
      <SliderPicker
        value={selectedParam.value}
        onValueChange={(value) => {
          const param = PostProcessParamsInOrder.find((p) => p.value === value)!;
          setSelectedParam(param);
          showFloatingLabel(param.label);
        }}
        onInteractionStart={handleSliderInteractionStart}
        onValueCommit={handleSliderValueCommit}
        className="mobile-style-knobs"
      >
        <SliderPickerWindow className="mobile-style-knobs__window">
          <SliderPickerOptions
            className="mobile-style-knobs__options"
            aria-label="Post-process parameter selection"
          >
            {PostProcessParamsInOrder.map((param) => {
              const isEnabled = getEnabledState(param.effect);
              const currentValue = getParamValue(param);
              const isMixed = getParamIsMixed(param);
              const hasChanged = currentValue !== param.defaultValue;

              return (
                <SliderPickerItem
                  key={param.value}
                  value={param.value}
                  checked={isEnabled}
                  onCheckedChange={(checked) => handleToggle(param.effect, checked)}
                  className="mobile-style-knobs__item"
                >
                  <button type="button" tabIndex={-1} className="ui-button" data-variant="primary">
                    {isMixed
                      ? "M"
                      : hasChanged
                        ? formatParamValue(currentValue, param.min, param.max)
                        : param.label.at(0)?.toUpperCase()}
                  </button>
                  <span className="mobile-style-knobs__label">{param.label}</span>
                </SliderPickerItem>
              );
            })}
          </SliderPickerOptions>
          <div className="mobile-style-knobs__highlight" aria-hidden="true" />
        </SliderPickerWindow>
      </SliderPicker>

      {/* TickSlider for the selected parameter */}
      <InfiniteSlider
        key={selectedParam.value}
        value={toUiValue(getParamValue(selectedParam), selectedParam.min, selectedParam.max)}
        min={0}
        max={100}
        onInteractionStart={() => undo.beginTransaction()}
        onValueChange={(ui) => handleParamChange(selectedParam, ui)}
        onValueCommit={() => undo.commitTransaction()}
      />
    </div>
  );
}
