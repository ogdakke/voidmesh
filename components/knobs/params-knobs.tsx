import { useParamValue, type ParamResult } from "#hooks/use-param-value.ts";
import { useCanvasCommands, useSelectedShaderType } from "#context/use-canvas.ts";
import { type ParamPaths, type ShaderParams, type ShaderType } from "#types/canvas.ts";
import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  SliderPicker,
  SliderPickerItem,
  SliderPickerOptions,
  SliderPickerWindow,
} from "../ui/slider-picker/index.ts";
import "./knobs.css";
import { undo } from "#lib/undo.ts";
import { InfiniteSlider } from "../ui/infinite-slider/index.ts";
import { TimeSlider } from "../ui/time-slider/time-slider.tsx";
import { getEffectiveDefault } from "#lib/get-effective-default.ts";
import { config } from "#config";
import { PauseSolid, PlaySolid } from "iconoir-react";
import type { PartialDeep } from "type-fest";
import { useTimeControl } from "#hooks/use-time-control.ts";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

type ParamValuesRecord = Partial<Record<ParamPaths, ParamResult<number | null | undefined>>>;

/** Map actual value to UI range (0-100) */
function toUiValue(actual: number, min: number, max: number): number {
  return Math.round(((actual - min) / (max - min)) * 100);
}

/** Map UI value (0-100) to actual range, with precision to avoid floating point noise */
function fromUiValue(ui: number, min: number, max: number, precision = 2): number {
  const value = min + (ui / 100) * (max - min);
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

/** Build a nested update object from a dot-path and value.
 *  e.g. "glass.angle" + 45 → { glass: { angle: 45 } } */
function buildParamUpdate(path: string, value: number): PartialDeep<ShaderParams> {
  const parts = path.split(".");
  if (parts.length === 1) return { [parts[0]!]: value } as PartialDeep<ShaderParams>;

  const result: Record<string, unknown> = {};
  let current = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const nested: Record<string, unknown> = {};
    current[parts[i]!] = nested;
    current = nested;
  }
  current[parts.at(-1)!] = value;
  return result as PartialDeep<ShaderParams>;
}

/** Format value for display in button (percentage of range, 0-100, or raw value) */
function formatParamValue(value: number, min: number, max: number, displayRaw = false): string {
  if (displayRaw) return `${Math.round(value)}`;
  if (min === max) return `${Math.round(value)}`;
  return `${Math.round(((value - min) / (max - min)) * 100)}`;
}

/** Resolve a param label — supports both static strings and dynamic functions */
function resolveLabel(
  label: string | ((shaderType: ShaderType) => string),
  shaderType: ShaderType,
): string {
  return typeof label === "function" ? label(shaderType) : label;
}

// ---------------------------------------------------------------------------
// Param metadata
// ---------------------------------------------------------------------------

const AllSlideyParamsInOrder = [
  {
    value: "time",
    label: "Time",
    range: config.shaderParams.time,
    precision: 2,
    isTime: true as const,
  },
  { value: "size", label: "Size", range: config.shaderParams.size, precision: 0, displayRaw: true },
  {
    value: "intensity",
    label: ((s: ShaderType) => (s === "glass" ? "Refraction" : "Intensity")) as (
      s: ShaderType,
    ) => string,
    range: config.shaderParams.intensity,
    precision: 2,
  },
  { value: "scale", label: "Scale", range: config.shaderParams.scale, precision: 2 },
  {
    value: "blobs.eagerness",
    label: "Eagerness",
    range: config.shaderParams.eagerness,
    precision: 2,
  },
  { value: "glass.angle", label: "Angle", range: config.shaderParams.angle, precision: 0 },
  { value: "glitch.angle", label: "Angle", range: config.shaderParams.angle, precision: 0 },
  { value: "glass.caustic", label: "Caustic", range: config.shaderParams.caustic, precision: 2 },
  {
    value: "glass.frostiness",
    label: "Frostiness",
    range: config.shaderParams.frostiness,
    precision: 2,
  },
  {
    value: "glass.highlight",
    label: "Highlight",
    range: config.shaderParams.highlight,
    precision: 2,
  },
  {
    value: "glass.dispersion",
    label: "Dispersion",
    range: config.shaderParams.dispersion,
    precision: 2,
  },
  { value: "glass.flow", label: "Flow", range: config.shaderParams.flow, precision: 2 },
  {
    value: "adjustments.brightness",
    label: "Brightness",
    range: config.adjustments.brightness,
    precision: 2,
  },
  {
    value: "adjustments.contrast",
    label: "Contrast",
    range: config.adjustments.contrast,
    precision: 2,
  },
  {
    value: "adjustments.saturation",
    label: "Saturation",
    range: config.adjustments.saturation,
    precision: 2,
  },
  { value: "adjustments.blur", label: "Blur", range: config.adjustments.blur, precision: 2 },
] as const satisfies {
  value: ParamPaths;
  label: string | ((shaderType: ShaderType) => string);
  range: { min: number; max: number };
  precision: number;
  isTime?: true;
  displayRaw?: true;
}[];

type SlideyParam = (typeof AllSlideyParamsInOrder)[number];

// ---------------------------------------------------------------------------
// ActiveParamSlider — single memoized instance for all non-time params
// ---------------------------------------------------------------------------

interface ActiveParamSliderProps {
  param: SlideyParam;
  paramResult: ParamResult<number | null | undefined>;
  shaderType: ShaderType;
  onParamChange: (param: SlideyParam, uiValue: number) => void;
}

const ActiveParamSlider = memo(function ActiveParamSlider({
  param,
  paramResult,
  shaderType,
  onParamChange,
}: ActiveParamSliderProps) {
  const effectiveDefault = getEffectiveDefault(shaderType, param.value);
  const currentValue = paramResult.value ?? effectiveDefault ?? param.range.min;

  const handleChange = (ui: number) => onParamChange(param, ui);

  return (
    <InfiniteSlider
      value={toUiValue(currentValue, param.range.min, param.range.max)}
      min={0}
      max={100}
      onInteractionStart={() => undo.beginTransaction()}
      onValueChange={handleChange}
      onValueCommit={() => undo.commitTransaction()}
    />
  );
});

// ---------------------------------------------------------------------------
// ParamsKnobs (main component)
// ---------------------------------------------------------------------------

export function ParamsKnobs() {
  const [selectedKnob, setSelectedKnob] = useState<SlideyParam>(AllSlideyParamsInOrder.at(0)!);
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { updateSelectedEntityParams } = useCanvasCommands();
  const selectedShaderType = useSelectedShaderType();
  const timeControl = useTimeControl();

  // All param values keyed by path — same hook count/order every render
  const paramValues: ParamValuesRecord = {
    size: useParamValue("size", null),
    intensity: useParamValue("intensity", null),
    scale: useParamValue("scale", null),
    "blobs.eagerness": useParamValue("blobs.eagerness", null),
    time: useParamValue("time", null),
    "glass.angle": useParamValue("glass.angle", null),
    "glitch.angle": useParamValue("glitch.angle", null),
    "glass.caustic": useParamValue("glass.caustic", null),
    "glass.frostiness": useParamValue("glass.frostiness", null),
    "glass.highlight": useParamValue("glass.highlight", null),
    "glass.dispersion": useParamValue("glass.dispersion", null),
    "glass.flow": useParamValue("glass.flow", null),
    "adjustments.brightness": useParamValue("adjustments.brightness", null),
    "adjustments.contrast": useParamValue("adjustments.contrast", null),
    "adjustments.saturation": useParamValue("adjustments.saturation", null),
    "adjustments.blur": useParamValue("adjustments.blur", null),
  };

  // Generic param change handler — replaces 13 individual callbacks
  const handleParamChange = (param: SlideyParam, uiValue: number) => {
    const actual = fromUiValue(uiValue, param.range.min, param.range.max, param.precision);
    updateSelectedEntityParams(buildParamUpdate(param.value, actual));
  };

  // Floating label helpers
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

  const handleSliderInteractionStart = () => {
    const isMixed =
      selectedKnob.value === "time"
        ? timeControl.isMixed
        : (paramValues[selectedKnob.value]?.isMixed ?? false);
    showFloatingLabel(selectedKnob.label + (isMixed ? " (Mixed)" : ""));
  };

  const handleSliderValueCommit = () => {
    floatingLabelTimeoutRef.current = setTimeout(() => {
      setFloatingLabel(null);
    }, config.ui.floatingParamLabelHideTimeoutMs);
  };

  return (
    <div className="params-knobs">
      {/* Floating label - rendered via portal to appear above media controls */}
      {floatingLabel &&
        createPortal(
          <div className="mobile-style-knobs__floating-label" data-visible>
            {floatingLabel}
          </div>,
          document.body,
        )}

      {/* Slider picker - selects which param we're tweaking */}
      <ShaderMobileSelect
        paramValues={paramValues}
        selectedKnob={selectedKnob}
        shaderType={selectedShaderType}
        isTimeAutoPlaying={timeControl.isAutoPlaying}
        onTimeToggle={timeControl.handleToggle}
        onValueChange={(value) => {
          const param = AllSlideyParamsInOrder.find((p) => p.value === value)!;
          setSelectedKnob(param);
          const label = resolveLabel(param.label, selectedShaderType);
          showFloatingLabel(value === "time" && timeControl.isMixed ? `${label} (Mixed)` : label);
        }}
        onInteractionStart={handleSliderInteractionStart}
        onValueCommit={handleSliderValueCommit}
      />

      {/* Time slider — driven imperatively at 60fps during autoplay */}
      {selectedKnob.value === "time" && (
        <TimeSlider
          entity={timeControl.entity}
          isAutoPlaying={timeControl.isAutoPlaying}
          entityTime={timeControl.entityTime}
          onInteractionStart={timeControl.handleTimeInteractionStart}
          onValueChange={timeControl.handleTimeChange}
        />
      )}

      {/* Single InfiniteSlider for all non-time params — no mount/unmount when switching */}
      {selectedKnob.value !== "time" && paramValues[selectedKnob.value] && (
        <ActiveParamSlider
          param={selectedKnob}
          paramResult={paramValues[selectedKnob.value]!}
          shaderType={selectedShaderType}
          onParamChange={handleParamChange}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ShaderMobileSelect — picker strip for choosing active parameter
// ---------------------------------------------------------------------------

interface ShaderMobileSelectProps {
  paramValues: ParamValuesRecord;
  selectedKnob: SlideyParam;
  shaderType: ShaderType;
  isTimeAutoPlaying: boolean;
  onTimeToggle: (playing: boolean) => void;
  onValueChange: (value: string) => void;
  onInteractionStart: () => void;
  onValueCommit: () => void;
}

function ShaderMobileSelect({
  paramValues,
  selectedKnob,
  shaderType,
  isTimeAutoPlaying,
  onTimeToggle,
  onValueChange,
  onInteractionStart,
  onValueCommit,
}: ShaderMobileSelectProps) {
  return (
    <SliderPicker
      value={selectedKnob.value}
      onValueChange={onValueChange}
      onInteractionStart={onInteractionStart}
      onValueCommit={onValueCommit}
      className="mobile-style-knobs"
    >
      <SliderPickerWindow className="mobile-style-knobs__window">
        <SliderPickerOptions className="mobile-style-knobs__options" aria-label="Filter selection">
          {AllSlideyParamsInOrder.map((param) => {
            const result = paramValues[param.value];
            if (!result?.isSupported) return null;

            // glass.time: play/pause toggle button with icon
            if (param.value === "time") {
              return (
                <SliderPickerItem
                  key={param.value}
                  value={param.value}
                  className="mobile-style-knobs__item"
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    className="ui-button mobile-style-knobs__time-toggle icon-crossfade"
                    data-variant="primary"
                    aria-label={isTimeAutoPlaying ? "Pause" : "Play"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTimeToggle(!isTimeAutoPlaying);
                    }}
                  >
                    <PauseSolid className={isTimeAutoPlaying ? "icon-visible" : "icon-hidden"} />
                    <PlaySolid className={isTimeAutoPlaying ? "icon-hidden" : "icon-visible"} />
                  </button>
                  <span className="mobile-style-knobs__label">
                    {resolveLabel(param.label, shaderType)}
                  </span>
                </SliderPickerItem>
              );
            }

            const currentValue = result.value;
            const isMixed = result.isMixed;
            const effectiveDefault = getEffectiveDefault(shaderType, param.value);
            const hasChanged = currentValue != null && currentValue !== effectiveDefault;
            const label = resolveLabel(param.label, shaderType);

            return (
              <SliderPickerItem
                key={param.value}
                value={param.value}
                className="mobile-style-knobs__item"
              >
                <button type="button" tabIndex={-1} className="ui-button" data-variant="primary">
                  {isMixed
                    ? "M"
                    : hasChanged && currentValue != null
                      ? formatParamValue(
                          currentValue,
                          param.range.min,
                          param.range.max,
                          "displayRaw" in param,
                        )
                      : label.at(0)?.toUpperCase()}
                </button>
                <span className="mobile-style-knobs__label">{label}</span>
              </SliderPickerItem>
            );
          })}
        </SliderPickerOptions>
        <div className="mobile-style-knobs__highlight" aria-hidden="true" />
      </SliderPickerWindow>
    </SliderPicker>
  );
}
