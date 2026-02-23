import {
  NumberField as BaseNumberField,
  type NumberFieldRootProps,
} from "@base-ui/react/number-field";
import { Plus, Minus } from "iconoir-react";
import { uniqueId } from "../ui-util";

import "./number-field.css";
import { useRef } from "react";

export interface NumberFieldProps extends NumberFieldRootProps {
  label?: string;
  placeholder?: string;
  // Optional enhancement
  enableScrubArea?: boolean;
  onChangeStart?: () => void;
}

export function NumberField({
  label,
  placeholder,
  value,
  defaultValue,
  onValueChange,
  min,
  max,
  name,
  disabled,
  required,
  readOnly,
  step,
  enableScrubArea = false,
  onValueCommitted,
  onChangeStart,
  ...props
}: NumberFieldProps) {
  const id = uniqueId();
  const startedRef = useRef(false);

  return (
    <div className="number-field-field">
      {/* Label outside when scrubbing is disabled */}
      {label && !enableScrubArea && (
        <label className="number-field-label" htmlFor={id}>
          {label}
        </label>
      )}

      <BaseNumberField.Root
        {...props}
        id={id}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(value, e) => {
          if (!startedRef.current) {
            startedRef.current = true;
            onChangeStart?.();
          }
          onValueChange?.(value, e);
        }}
        onValueCommitted={(value, e) => {
          startedRef.current = false;
          onValueCommitted?.(value, e);
        }}
        min={min}
        max={max}
        step={step}
        name={name}
        disabled={disabled}
        required={required}
        readOnly={readOnly}
      >
        {/* ScrubArea with label inside when enabled */}
        {label && enableScrubArea && (
          <BaseNumberField.ScrubArea className="number-field-scrub_area">
            <label className="number-field-label" htmlFor={id}>
              {label}
            </label>
            <BaseNumberField.ScrubAreaCursor className="number-field-scrub_area_cursor" />
          </BaseNumberField.ScrubArea>
        )}

        <BaseNumberField.Group className="number-field-group">
          <BaseNumberField.Decrement className="number-field-decrement">
            <Minus />
          </BaseNumberField.Decrement>

          <BaseNumberField.Input className="number-field-input" placeholder={placeholder} />

          <BaseNumberField.Increment className="number-field-increment">
            <Plus />
          </BaseNumberField.Increment>
        </BaseNumberField.Group>
      </BaseNumberField.Root>
    </div>
  );
}
