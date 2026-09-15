import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { config } from "#config";
import { overlapLab } from "#lib/overlap-lab.ts";
import { InfiniteSlider } from "#ui/infinite-slider/index.ts";
import {
  SliderPicker,
  SliderPickerItem,
  SliderPickerOptions,
  SliderPickerWindow,
} from "#ui/slider-picker/index.ts";
import "./knobs.css";

const settings = [
  { value: "transition", label: "Crossing" },
  { value: "rgbStrength", label: "RGB amt" },
  { value: "rgbDecay", label: "RGB decay" },
  { value: "rgbSplit", label: "RGB split" },
  { value: "wakeStrength", label: "Wake amt" },
  { value: "wakeDecay", label: "Wake decay" },
  { value: "wakeWidth", label: "Wake width" },
] as const;
type Setting = (typeof settings)[number]["value"];
const ranges = {
  transition: { min: 120, max: 1400, step: 20, unit: "ms" },
  rgbStrength: { min: 0, max: 2, step: 0.025, unit: "×" },
  rgbDecay: { min: 100, max: 2400, step: 20, unit: "ms" },
  rgbSplit: { min: 0, max: 20, step: 0.5, unit: "px" },
  wakeStrength: { min: 0, max: 2, step: 0.025, unit: "×" },
  wakeDecay: { min: 100, max: 2400, step: 20, unit: "ms" },
  wakeWidth: { min: 4, max: 40, step: 1, unit: "px" },
};
export default function OverlapDebugKnobs() {
  const state = useSyncExternalStore(overlapLab.subscribe, overlapLab.getSnapshot);
  const [setting, setSetting] = useState<Setting>("rgbStrength");
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const formatValue = (key: Setting, value = state[key]) => {
    const name = settings.find((entry) => entry.value === key)!.label;
    const unit = ranges[key].unit;
    return `${name}: ${unit === "×" ? value.toFixed(2) : value} ${unit}`;
  };
  // Keep compact values in the picker and show units in its floating label.
  const buttonValue = (key: Setting) =>
    Math.round(((state[key] - ranges[key].min) / (ranges[key].max - ranges[key].min)) * 100);
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
        value={setting}
        onInteractionStart={() => showFloatingLabel(formatValue(setting))}
        onValueCommit={() => showFloatingLabel(formatValue(setting))}
        onValueChange={(value) => {
          const next = settings.find((entry) => entry.value === value);
          if (next) {
            setSetting(next.value);
            showFloatingLabel(formatValue(next.value));
          }
        }}
        className="mobile-style-knobs"
      >
        <SliderPickerWindow className="mobile-style-knobs__window">
          <SliderPickerOptions
            className="mobile-style-knobs__options"
            aria-label="Overlap lab control"
          >
            {settings.map((entry) => (
              <SliderPickerItem
                key={entry.value}
                value={entry.value}
                className="mobile-style-knobs__item"
              >
                <button type="button" tabIndex={-1} className="ui-button" data-variant="primary">
                  {buttonValue(entry.value)}
                </button>
                <span className="mobile-style-knobs__label">{entry.label}</span>
              </SliderPickerItem>
            ))}
          </SliderPickerOptions>
          <div className="mobile-style-knobs__highlight" aria-hidden="true" />
        </SliderPickerWindow>
      </SliderPicker>
      <InfiniteSlider
        key={setting}
        ariaLabel={`Overlap ${setting}`}
        step={ranges[setting].step}
        value={state[setting]}
        min={ranges[setting].min}
        max={ranges[setting].max}
        onInteractionStart={() => showFloatingLabel(formatValue(setting))}
        onValueCommit={() => showFloatingLabel(formatValue(setting))}
        onValueChange={(value) => {
          const nextValue = Math.round(value * 100) / 100;
          overlapLab.configure({ [setting]: nextValue });
          showFloatingLabel(formatValue(setting, nextValue));
        }}
      />
    </div>
  );
}
