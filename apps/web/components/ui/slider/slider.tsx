import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Field } from "@base-ui/react";
import {
  Slider as BaseSlider,
  type SliderRootChangeEventDetails,
  type SliderRootProps,
} from "@base-ui/react/slider";
import "./slider.css";

export interface SliderProps extends SliderRootProps<number> {
  name: string;
  showValue?: boolean;
  label?: string;
  thumbLabels?: string[];
  onInteractionStart?: () => void;
}

function SliderValueInput({
  value,
  min,
  max,
  step,
  onValueChange,
  onValueCommitted,
  onInteractionStart,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onValueChange: (value: number) => void;
  onValueCommitted: (value: number) => void;
  onInteractionStart?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const precision = step < 1 ? (String(step).split(".")[1]?.length ?? 0) : 0;

  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const commit = (raw: string) => {
    const parsed = parseFloat(raw);
    const committed = !Number.isNaN(parsed) ? clamp(parsed) : value;
    onValueChange(committed);
    onValueCommitted(committed);
    setEditing(false);
  };

  return (
    // oxlint-disable-next-line jsx-a11y/control-has-associated-label
    <input
      ref={inputRef}
      className="slider-value"
      type="text"
      inputMode="decimal"
      value={editing ? editValue : value.toFixed(precision)}
      onChange={(e) => {
        const raw = e.target.value;
        setEditValue(raw);
        const parsed = parseFloat(raw);
        if (!Number.isNaN(parsed) && raw === String(parsed)) {
          onValueChange(clamp(parsed));
        }
      }}
      onFocus={(e) => {
        onInteractionStart?.();
        setEditing(true);
        setEditValue(value.toFixed(precision));
        e.target.select();
      }}
      onBlur={() => commit(editValue)}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          const next = clamp(value + step);
          onValueChange(next);
          setEditValue(next.toFixed(precision));
          setEditing(false);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          const next = clamp(value - step);
          onValueChange(next);
          setEditValue(next.toFixed(precision));
          setEditing(false);
        } else if (e.key === "Enter" || e.key === "Escape") {
          inputRef.current?.blur();
        }
      }}
    />
  );
}

export function Slider({
  name,
  label,
  showValue,
  thumbLabels,
  min = 0,
  max = 1,
  step = 0.01,
  value: controlledValue,
  defaultValue,
  onValueChange: onValueChangeProp,
  onValueCommitted: onValueCommittedProp,
  onInteractionStart,
  onPointerDown: onPointerDownProp,
  ...props
}: SliderProps) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [uncontrolledValue, setUncontrolledValue] = useState<number>(
    (Array.isArray(defaultValue) ? defaultValue[0] : defaultValue) ?? min,
  );

  const isControlled = controlledValue !== undefined;
  const currentValue = isControlled
    ? Array.isArray(controlledValue)
      ? controlledValue[0]
      : controlledValue
    : uncontrolledValue;

  const handleValueChange = (newValue: number, event: SliderRootChangeEventDetails) => {
    if (!isControlled) setUncontrolledValue(newValue);
    onValueChangeProp?.(newValue, event);
  };

  const handleInputValueChange = (newValue: number) => {
    handleValueChange(newValue, new Event("change") as any);
  };

  const handleInputValueCommitted = (newValue: number) => {
    onValueCommittedProp?.(newValue, new Event("change") as any);
  };

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const labelEl = field.querySelector("label");
    const track = field.querySelector(".slider-track");
    const valueEl = field.querySelector(".slider-value");
    if (!labelEl || !track) return;

    const update = () => {
      const trackWidth = (track as HTMLElement).offsetWidth;
      field.style.setProperty("--label-fraction", String(labelEl.offsetWidth / trackWidth));
      if (valueEl) {
        field.style.setProperty(
          "--value-fraction",
          String((valueEl as HTMLElement).offsetWidth / trackWidth),
        );
      }
    };

    const observer = new ResizeObserver(update);
    observer.observe(labelEl);
    observer.observe(track);
    if (valueEl) observer.observe(valueEl);
    return () => observer.disconnect();
  }, []);

  return (
    <Field.Root ref={fieldRef} name={name} className={"slider-field"}>
      <Field.Label className="field-label">{label}</Field.Label>
      <BaseSlider.Root<number>
        {...props}
        ref={rootRef}
        min={min}
        max={max}
        step={step}
        value={currentValue}
        onValueChange={handleValueChange}
        onValueCommitted={onValueCommittedProp}
        onPointerDown={(e) => {
          onInteractionStart?.();
          onPointerDownProp?.(e);
        }}
        className={"slider-root"}
      >
        <BaseSlider.Control className={"slider-control"}>
          <BaseSlider.Track className={"slider-track"}>
            <BaseSlider.Indicator className={"slider-indicator"} />
            {thumbLabels?.length && thumbLabels.length > 1 ? (
              thumbLabels?.map((label, index) => (
                <BaseSlider.Thumb aria-label={label} className={"slider-thumb"} key={index} />
              ))
            ) : (
              <BaseSlider.Thumb
                className={"slider-thumb"}
                style={(state) =>
                  ({
                    "--slider-position":
                      min != null && max != null
                        ? ((state.values[0] ?? min) - min) / (max - min)
                        : 0.5,
                  }) as CSSProperties
                }
              />
            )}
          </BaseSlider.Track>
        </BaseSlider.Control>
      </BaseSlider.Root>
      {showValue && (
        <SliderValueInput
          value={currentValue}
          min={min}
          max={max}
          step={step}
          onValueChange={handleInputValueChange}
          onValueCommitted={handleInputValueCommitted}
          onInteractionStart={onInteractionStart}
        />
      )}
    </Field.Root>
  );
}
