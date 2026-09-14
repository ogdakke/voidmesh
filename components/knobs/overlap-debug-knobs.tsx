import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { config } from "#config";
import { overlapLab, overlapEffectOptions, type OverlapEffect } from "#lib/overlap-lab.ts";
import { InfiniteSlider } from "#ui/infinite-slider/index.ts";
import {
  SliderPicker,
  SliderPickerItem,
  SliderPickerOptions,
  SliderPickerWindow,
} from "#ui/slider-picker/index.ts";
import "./knobs.css";

const labels: Record<OverlapEffect, string> = {
  off: "Off",
  yield: "Yield",
  diffusion: "Diffusion",
  prism: "Prism",
  wake: "Wake",
  peel: "Peel",
};
const shortLabels: Record<OverlapEffect, string> = {
  off: "Off",
  yield: "Yld",
  diffusion: "Diff",
  prism: "RGB",
  wake: "Wak",
  peel: "Peel",
};
const settings = [
  { value: "effect", label: "Effect" },
  { value: "transition", label: "Crossing" },
  { value: "duration", label: "Decay" },
  { value: "strength", label: "Strength" },
] as const;
type Setting = (typeof settings)[number]["value"];
const ranges = {
  transition: { min: 120, max: 1400 },
  duration: { min: 100, max: 2400 },
  strength: { min: 0.25, max: 2 },
};
export default function OverlapDebugKnobs() {
  const state = useSyncExternalStore(overlapLab.subscribe, overlapLab.getSnapshot);
  const [setting, setSetting] = useState<Setting>("effect");
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
  const formatValue = (key: Setting, value = key === "effect" ? 0 : state[key]) => {
    if (key === "effect") return `Effect: ${labels[state.effect]}`;
    const name = settings.find((entry) => entry.value === key)!.label;
    return `${name}: ${key === "strength" ? `${value.toFixed(2)}×` : `${value} ms`}`;
  };
  // Match the blur debug picker: compact 0–100 values in the circles,
  // with actual values and units in the floating interaction label.
  const buttonValue = (key: Setting) =>
    key === "effect"
      ? shortLabels[state.effect]
      : Math.round(((state[key] - ranges[key].min) / (ranges[key].max - ranges[key].min)) * 100);
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
      {setting === "effect" ? (
        <SliderPicker
          value={state.effect}
          onInteractionStart={() => showFloatingLabel(formatValue("effect"))}
          onValueCommit={() => showFloatingLabel(formatValue("effect"))}
          onValueChange={(value) => {
            const effect = overlapEffectOptions.find((entry) => entry === value);
            if (effect) {
              overlapLab.configure({ effect });
              showFloatingLabel(`Effect: ${labels[effect]}`);
            }
          }}
          className="mobile-style-knobs"
        >
          <SliderPickerWindow className="mobile-style-knobs__window">
            <SliderPickerOptions
              className="mobile-style-knobs__options"
              aria-label="Crossing effect"
            >
              {overlapEffectOptions.map((effect) => (
                <SliderPickerItem key={effect} value={effect} className="mobile-style-knobs__item">
                  <button type="button" tabIndex={-1} className="ui-button" data-variant="primary">
                    {shortLabels[effect]}
                  </button>
                  <span className="mobile-style-knobs__label">{labels[effect]}</span>
                </SliderPickerItem>
              ))}
            </SliderPickerOptions>
            <div className="mobile-style-knobs__highlight" aria-hidden="true" />
          </SliderPickerWindow>
        </SliderPicker>
      ) : (
        <InfiniteSlider
          key={setting}
          ariaLabel={`Overlap ${setting}`}
          step={setting === "strength" ? 0.025 : 20}
          value={state[setting]}
          min={ranges[setting].min}
          max={ranges[setting].max}
          onInteractionStart={() => showFloatingLabel(formatValue(setting))}
          onValueCommit={() => showFloatingLabel(formatValue(setting))}
          onValueChange={(value) => {
            const nextValue =
              setting === "strength" ? Math.round(value * 100) / 100 : Math.round(value);
            overlapLab.configure({ [setting]: nextValue });
            showFloatingLabel(formatValue(setting, nextValue));
          }}
        />
      )}
    </div>
  );
}
