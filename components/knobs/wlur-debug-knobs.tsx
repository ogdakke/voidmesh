import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { config } from "#config";
import { useCanvasRendererService } from "#context/use-canvas.ts";
import { WLUR_DEBUG_CURVE_OPTIONS, type WlurOverlayDebugConfig } from "#renderer/wlur-debug.ts";
import { InfiniteSlider } from "#ui/infinite-slider/index.ts";
import {
  SliderPicker,
  SliderPickerItem,
  SliderPickerOptions,
  SliderPickerWindow,
} from "#ui/slider-picker/index.ts";
import "./knobs.css";

type WlurDebugSetting =
  | {
      value: "enabled" | "cache";
      label: string;
      shortLabel: string;
      kind: "boolean";
    }
  | {
      value:
        | "radius"
        | "offset"
        | "interpolation"
        | "noise"
        | "tintAmount"
        | "kernelSize"
        | "resolutionScale";
      label: string;
      shortLabel: string;
      kind: "number";
      range: { min: number; max: number };
      precision: number;
      displayRaw?: boolean;
    }
  | {
      value: "blurCurve" | "mixCurve" | "tintCurve";
      label: string;
      shortLabel: string;
      kind: "curve";
    };

const WLUR_DEBUG_SETTINGS = [
  { value: "enabled", label: "Enabled", shortLabel: "On", kind: "boolean" },
  { value: "cache", label: "Cache", shortLabel: "Cache", kind: "boolean" },
  {
    value: "radius",
    label: "Radius",
    shortLabel: "Rad",
    kind: "number",
    range: { min: 0, max: 160 },
    precision: 0,
    displayRaw: true,
  },
  {
    value: "offset",
    label: "Offset",
    shortLabel: "Off",
    kind: "number",
    range: { min: 0, max: 1 },
    precision: 2,
  },
  {
    value: "interpolation",
    label: "Interpolation",
    shortLabel: "Ramp",
    kind: "number",
    range: { min: 0, max: 1 },
    precision: 2,
  },
  {
    value: "noise",
    label: "Noise",
    shortLabel: "Noise",
    kind: "number",
    range: { min: 0, max: 1 },
    precision: 2,
  },
  {
    value: "tintAmount",
    label: "Tint",
    shortLabel: "Tint",
    kind: "number",
    range: { min: 0, max: 1.5 },
    precision: 2,
  },
  {
    value: "kernelSize",
    label: "Kernel",
    shortLabel: "Kernel",
    kind: "number",
    range: { min: 3, max: 127 },
    precision: 0,
    displayRaw: true,
  },
  {
    value: "resolutionScale",
    label: "Scale",
    shortLabel: "Scale",
    kind: "number",
    range: { min: 0.1, max: 1 },
    precision: 2,
  },
  { value: "blurCurve", label: "Blur Ease", shortLabel: "Blur", kind: "curve" },
  { value: "mixCurve", label: "Mix Ease", shortLabel: "Mix", kind: "curve" },
  { value: "tintCurve", label: "Tint Ease", shortLabel: "Tint", kind: "curve" },
] as const satisfies readonly WlurDebugSetting[];

function toUiValue(actual: number, min: number, max: number): number {
  return Math.round(((actual - min) / (max - min)) * 100);
}

function fromUiValue(ui: number, min: number, max: number, precision = 2): number {
  const value = min + (ui / 100) * (max - min);
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

function formatSettingButtonValue(
  setting: WlurDebugSetting,
  configValue: WlurOverlayDebugConfig,
): string {
  if (setting.kind === "boolean") {
    return configValue[setting.value] ? "On" : "Off";
  }

  if (setting.kind === "curve") {
    return (
      WLUR_DEBUG_CURVE_OPTIONS.find((option) => option.value === configValue[setting.value])
        ?.shortLabel ?? "Lin"
    );
  }

  const value = configValue[setting.value];
  if (setting.displayRaw) {
    return `${Math.round(value)}`;
  }

  return `${Math.round(((value - setting.range.min) / (setting.range.max - setting.range.min)) * 100)}`;
}

function formatFloatingValue(
  setting: WlurDebugSetting,
  configValue: WlurOverlayDebugConfig,
): string {
  if (setting.kind === "boolean") {
    return `${setting.label}: ${configValue[setting.value] ? "On" : "Off"}`;
  }

  if (setting.kind === "curve") {
    const option = WLUR_DEBUG_CURVE_OPTIONS.find(
      (entry) => entry.value === configValue[setting.value],
    );
    return `${setting.label}: ${option?.label ?? "Linear"}`;
  }

  const value = configValue[setting.value];
  const formatted = setting.displayRaw ? `${Math.round(value)}` : value.toFixed(setting.precision);
  return `${setting.label}: ${formatted}`;
}

const TOGGLE_OPTIONS = [
  { value: "off", label: "Off", shortLabel: "Off" },
  { value: "on", label: "On", shortLabel: "On" },
] as const;

export default function WlurDebugKnobs() {
  const { wlurDebugConfig, setWlurDebugConfig } = useCanvasRendererService();
  const [selectedSetting, setSelectedSetting] = useState<WlurDebugSetting>(
    WLUR_DEBUG_SETTINGS.find((setting) => setting.value === "radius")!,
  );
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFloatingLabel = (text: string) => {
    if (floatingLabelTimeoutRef.current) {
      clearTimeout(floatingLabelTimeoutRef.current);
    }
    setFloatingLabel(text);
    floatingLabelTimeoutRef.current = setTimeout(
      () => setFloatingLabel(null),
      config.ui.floatingParamLabelHideTimeoutMs,
    );
  };

  useEffect(
    () => () => {
      if (floatingLabelTimeoutRef.current) {
        clearTimeout(floatingLabelTimeoutRef.current);
      }
    },
    [],
  );

  const handleNumericValueChange = (uiValue: number) => {
    if (selectedSetting.kind !== "number") return;

    let nextValue = fromUiValue(
      uiValue,
      selectedSetting.range.min,
      selectedSetting.range.max,
      selectedSetting.precision,
    );
    if (selectedSetting.value === "kernelSize") {
      nextValue = Math.max(3, Math.round(nextValue));
      if (nextValue % 2 === 0) {
        nextValue += 1;
      }
    }
    setWlurDebugConfig({ [selectedSetting.value]: nextValue });
    showFloatingLabel(
      `${selectedSetting.label}: ${selectedSetting.displayRaw ? Math.round(nextValue) : nextValue.toFixed(selectedSetting.precision)}`,
    );
  };
  const currentNumericValue =
    selectedSetting.kind === "number"
      ? toUiValue(
          wlurDebugConfig[selectedSetting.value],
          selectedSetting.range.min,
          selectedSetting.range.max,
        )
      : 0;

  const selectedEnumValue =
    selectedSetting.kind === "boolean"
      ? wlurDebugConfig[selectedSetting.value]
        ? "on"
        : "off"
      : selectedSetting.kind === "curve"
        ? wlurDebugConfig[selectedSetting.value]
        : null;

  const enumOptions =
    selectedSetting.kind === "boolean" ? TOGGLE_OPTIONS : WLUR_DEBUG_CURVE_OPTIONS;

  return (
    <div className="params-knobs">
      {floatingLabel &&
        createPortal(
          <div className="mobile-style-knobs__floating-label" data-visible>
            {floatingLabel}
          </div>,
          document.body,
        )}

      <SliderPicker
        value={selectedSetting.value}
        onValueChange={(value) => {
          const nextSetting = WLUR_DEBUG_SETTINGS.find((entry) => entry.value === value);
          if (!nextSetting) return;
          setSelectedSetting(nextSetting);
          showFloatingLabel(formatFloatingValue(nextSetting, wlurDebugConfig));
        }}
        onInteractionStart={() =>
          showFloatingLabel(formatFloatingValue(selectedSetting, wlurDebugConfig))
        }
        onValueCommit={() => {
          floatingLabelTimeoutRef.current = setTimeout(
            () => setFloatingLabel(null),
            config.ui.floatingParamLabelHideTimeoutMs,
          );
        }}
        className="mobile-style-knobs"
      >
        <SliderPickerWindow className="mobile-style-knobs__window">
          <SliderPickerOptions
            className="mobile-style-knobs__options"
            aria-label="Canvas blur debug control"
          >
            {WLUR_DEBUG_SETTINGS.map((setting) => (
              <SliderPickerItem
                key={setting.value}
                value={setting.value}
                className="mobile-style-knobs__item"
              >
                <button type="button" tabIndex={-1} className="ui-button" data-variant="primary">
                  {formatSettingButtonValue(setting, wlurDebugConfig)}
                </button>
                <span className="mobile-style-knobs__label">{setting.shortLabel}</span>
              </SliderPickerItem>
            ))}
          </SliderPickerOptions>
          <div className="mobile-style-knobs__highlight" aria-hidden="true" />
        </SliderPickerWindow>
      </SliderPicker>

      {selectedSetting.kind === "number" ? (
        <InfiniteSlider
          value={currentNumericValue}
          min={0}
          max={100}
          onInteractionStart={() =>
            showFloatingLabel(formatFloatingValue(selectedSetting, wlurDebugConfig))
          }
          onValueChange={handleNumericValueChange}
        />
      ) : (
        <SliderPicker
          value={selectedEnumValue ?? "off"}
          onValueChange={(value) => {
            if (selectedSetting.kind === "boolean") {
              const enabled = value === "on";
              setWlurDebugConfig({ [selectedSetting.value]: enabled });
              showFloatingLabel(`${selectedSetting.label}: ${enabled ? "On" : "Off"}`);
              return;
            }

            const option = WLUR_DEBUG_CURVE_OPTIONS.find((entry) => entry.value === value);
            if (!option) return;
            setWlurDebugConfig({ [selectedSetting.value]: option.value });
            showFloatingLabel(`${selectedSetting.label}: ${option.label}`);
          }}
          onInteractionStart={() =>
            showFloatingLabel(formatFloatingValue(selectedSetting, wlurDebugConfig))
          }
          onValueCommit={() => {
            floatingLabelTimeoutRef.current = setTimeout(
              () => setFloatingLabel(null),
              config.ui.floatingParamLabelHideTimeoutMs,
            );
          }}
          className="mobile-style-knobs"
        >
          <SliderPickerWindow className="mobile-style-knobs__window">
            <SliderPickerOptions
              className="mobile-style-knobs__options"
              aria-label={`${selectedSetting.label} options`}
            >
              {enumOptions.map((option) => (
                <SliderPickerItem
                  key={option.value}
                  value={option.value}
                  className="mobile-style-knobs__item"
                >
                  <button type="button" tabIndex={-1} className="ui-button" data-variant="primary">
                    {option.shortLabel}
                  </button>
                  <span className="mobile-style-knobs__label">{option.label}</span>
                </SliderPickerItem>
              ))}
            </SliderPickerOptions>
            <div className="mobile-style-knobs__highlight" aria-hidden="true" />
          </SliderPickerWindow>
        </SliderPicker>
      )}
    </div>
  );
}
