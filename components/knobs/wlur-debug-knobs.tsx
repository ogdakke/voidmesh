import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { config } from "#config";
import { toastManager } from "#application/notifications.ts";
import { logger } from "#lib/client.logger.ts";
import { useCanvasRendererService } from "#context/use-canvas.ts";
import {
  WLUR_DEBUG_ALGORITHM_OPTIONS,
  WLUR_DEBUG_CURVE_OPTIONS,
  resolveWlurOverlayDebugConfig,
  type WlurOverlayDebugConfig,
} from "#renderer/wlur-debug.ts";
import type { WlurAlgorithm } from "#wlur";
import { createMobileWlurOverlayConfig } from "#renderer/wlur-overlay.ts";
import { useIsCompactLandscape } from "#hooks/use-is-mobile.ts";
import { Button } from "#ui/button/button.tsx";
import { InfiniteSlider } from "#ui/infinite-slider/index.ts";
import {
  SliderPicker,
  SliderPickerItem,
  SliderPickerOptions,
  SliderPickerWindow,
} from "#ui/slider-picker/index.ts";
import useMediaQuery from "#hooks/use-media-query.ts";
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
        | "resolutionScale"
        | "levels"
        | "spread";
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
    }
  | {
      value: "algorithm";
      label: string;
      shortLabel: string;
      kind: "algorithm";
    }
  | {
      value: "tintColor";
      label: string;
      shortLabel: string;
      kind: "color";
    }
  | {
      value: "copy";
      label: string;
      shortLabel: string;
      kind: "copy";
    };

const WLUR_DEBUG_SETTINGS = [
  { value: "enabled", label: "Enabled", shortLabel: "On", kind: "boolean" },
  { value: "cache", label: "Cache", shortLabel: "Cache", kind: "boolean" },
  { value: "algorithm", label: "Algorithm", shortLabel: "Algo", kind: "algorithm" },
  {
    value: "levels",
    label: "Kawase Levels",
    shortLabel: "Lvls",
    kind: "number",
    range: { min: 0, max: 8 },
    precision: 2,
    displayRaw: true,
  },
  {
    value: "spread",
    label: "Kawase Spread",
    shortLabel: "Sprd",
    kind: "number",
    range: { min: 0, max: 4 },
    precision: 2,
    displayRaw: true,
  },
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
  { value: "tintColor", label: "Tint Color", shortLabel: "Color", kind: "color" },
  { value: "copy", label: "Copy values", shortLabel: "Copy", kind: "copy" },
] as const satisfies readonly WlurDebugSetting[];

/** Settings that only affect one algorithm; everything else applies to both. */
const MODE_SPECIFIC_SETTINGS: Partial<Record<WlurDebugSetting["value"], WlurAlgorithm>> = {
  radius: "gaussian",
  kernelSize: "gaussian",
  resolutionScale: "gaussian",
  levels: "kawase",
  spread: "kawase",
};

function getVisibleWlurDebugSettings(algorithm: WlurAlgorithm): readonly WlurDebugSetting[] {
  return WLUR_DEBUG_SETTINGS.filter((setting) => {
    const mode = MODE_SPECIFIC_SETTINGS[setting.value];
    return mode === undefined || mode === algorithm;
  });
}

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
  if (setting.kind === "copy") {
    return "JSON";
  }

  if (setting.kind === "color") {
    return configValue.tintColor.slice(1, 4).toUpperCase();
  }

  if (setting.kind === "boolean") {
    return configValue[setting.value] ? "On" : "Off";
  }

  if (setting.kind === "algorithm") {
    return configValue.algorithm === "kawase" ? "Kaw" : "Gau";
  }

  if (setting.kind === "curve") {
    return (
      WLUR_DEBUG_CURVE_OPTIONS.find((option) => option.value === configValue[setting.value])
        ?.shortLabel ?? "Lin"
    );
  }

  const value = configValue[setting.value];
  if (setting.displayRaw) {
    return setting.precision > 0 ? value.toFixed(1) : `${Math.round(value)}`;
  }

  return `${Math.round(((value - setting.range.min) / (setting.range.max - setting.range.min)) * 100)}`;
}

function formatFloatingValue(
  setting: WlurDebugSetting,
  configValue: WlurOverlayDebugConfig,
): string {
  if (setting.kind === "copy") {
    return setting.label;
  }

  if (setting.kind === "color") {
    return `${setting.label}: ${configValue.tintColor}`;
  }

  if (setting.kind === "boolean") {
    return `${setting.label}: ${configValue[setting.value] ? "On" : "Off"}`;
  }

  if (setting.kind === "algorithm") {
    const option = WLUR_DEBUG_ALGORITHM_OPTIONS.find(
      (entry) => entry.value === configValue.algorithm,
    );
    return `${setting.label}: ${option?.label ?? configValue.algorithm}`;
  }

  if (setting.kind === "curve") {
    const option = WLUR_DEBUG_CURVE_OPTIONS.find(
      (entry) => entry.value === configValue[setting.value],
    );
    return `${setting.label}: ${option?.label ?? "Linear"}`;
  }

  const value = configValue[setting.value];
  const formatted =
    setting.displayRaw && setting.precision === 0
      ? `${Math.round(value)}`
      : value.toFixed(setting.precision);
  return `${setting.label}: ${formatted}`;
}

async function copyWlurDebugConfig(configValue: WlurOverlayDebugConfig) {
  try {
    await navigator.clipboard.writeText(JSON.stringify(configValue, null, 2));
    toastManager.add({ type: "primary", title: "Blur values copied" });
  } catch (error) {
    logger.error("Failed to copy blur values:", error);
    toastManager.add({ type: "destructive", title: "Could not copy blur values" });
  }
}

const TOGGLE_OPTIONS = [
  { value: "off", label: "Off", shortLabel: "Off" },
  { value: "on", label: "On", shortLabel: "On" },
] as const;

export default function WlurDebugKnobs() {
  const { wlurDebugOverrides, setWlurDebugConfig, resetWlurDebugConfig } =
    useCanvasRendererService();
  const isDarkTheme = useMediaQuery("(prefers-color-scheme: dark)");
  const isCompactLandscape = useIsCompactLandscape();
  // Same base the renderer uses, so untouched values are exactly what production renders.
  const wlurDebugConfig = resolveWlurOverlayDebugConfig(
    createMobileWlurOverlayConfig({
      darkTheme: isDarkTheme,
      edge: isCompactLandscape ? "right" : "bottom",
    }),
    wlurDebugOverrides,
  );
  const hasOverrides = Object.keys(wlurDebugOverrides).length > 0;
  const visibleSettings = getVisibleWlurDebugSettings(wlurDebugConfig.algorithm);
  const [pickedSetting, setSelectedSetting] = useState<WlurDebugSetting>(
    WLUR_DEBUG_SETTINGS.find((setting) => setting.value === "radius")!,
  );
  // A setting hidden by an algorithm switch falls back to the algorithm picker itself.
  const selectedSetting = visibleSettings.includes(pickedSetting)
    ? pickedSetting
    : WLUR_DEBUG_SETTINGS.find((setting) => setting.value === "algorithm")!;
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
      `${selectedSetting.label}: ${selectedSetting.displayRaw && selectedSetting.precision === 0 ? Math.round(nextValue) : nextValue.toFixed(selectedSetting.precision)}`,
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
        : selectedSetting.kind === "algorithm"
          ? wlurDebugConfig.algorithm
          : null;

  const enumOptions =
    selectedSetting.kind === "boolean"
      ? TOGGLE_OPTIONS
      : selectedSetting.kind === "algorithm"
        ? WLUR_DEBUG_ALGORITHM_OPTIONS
        : WLUR_DEBUG_CURVE_OPTIONS;

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
          const nextSetting = visibleSettings.find((entry) => entry.value === value);
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
            {visibleSettings.map((setting) => (
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

      {selectedSetting.kind === "color" ? (
        <div className="wlur-debug-row">
          <input
            type="color"
            className="wlur-debug-color"
            aria-label="Blur tint color"
            value={wlurDebugConfig.tintColor}
            onChange={(e) => {
              setWlurDebugConfig({ tintColor: e.target.value });
              showFloatingLabel(`Tint Color: ${e.target.value}`);
            }}
          />
          <Button
            variant="secondary"
            disabled={wlurDebugOverrides.tintColor === undefined}
            onClick={() => setWlurDebugConfig({ tintColor: undefined })}
          >
            Theme
          </Button>
        </div>
      ) : selectedSetting.kind === "copy" ? (
        <div className="wlur-debug-row">
          <Button onClick={() => void copyWlurDebugConfig(wlurDebugConfig)}>Copy values</Button>
          <Button variant="secondary" disabled={!hasOverrides} onClick={resetWlurDebugConfig}>
            Reset
          </Button>
        </div>
      ) : selectedSetting.kind === "number" ? (
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

            if (selectedSetting.kind === "algorithm") {
              const algorithm = WLUR_DEBUG_ALGORITHM_OPTIONS.find((entry) => entry.value === value);
              if (!algorithm) return;
              setWlurDebugConfig({ algorithm: algorithm.value });
              showFloatingLabel(`${selectedSetting.label}: ${algorithm.label}`);
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
