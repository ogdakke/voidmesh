import { useState, useRef } from "react";
import { isValidColorCss, oklchToCss } from "#lib/color-utils.ts";
import { useColorPicker } from "./use-color-picker";
import { Field } from "#ui/field/field.tsx";
import type { FieldRootProps } from "@base-ui/react";

interface ValueInputProps extends FieldRootProps {}
export function ValueInput(props: ValueInputProps) {
  const {
    state: { oklch },
    actions: { setCssValue },
    meta: { colorSpace },
  } = useColorPicker();

  const [focused, setFocused] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const initialValueRef = useRef("");

  const displayValue = focused ? inputValue : oklchToCss(oklch, colorSpace);

  const tryApply = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // Normalize bare hex digits (e.g. "ff0000") to "#ff0000"
    const normalized =
      trimmed.startsWith("#") || trimmed.startsWith("color(") ? trimmed : `#${trimmed}`;
    if (!isValidColorCss(normalized)) return;
    setCssValue(normalized);
  };

  return (
    <Field.Root
      {...props}
      validate={(v) => (isValidColorCss(String(v).trim()) ? null : "")}
      validationMode="onChange"
    >
      {props.children}
      <Field.Control
        ref={inputRef}
        className="color-picker__value-input"
        type="text"
        value={displayValue}
        aria-label="Color value"
        spellCheck={false}
        autoComplete="off"
        onFocus={() => {
          const css = oklchToCss(oklch, colorSpace);
          setFocused(true);
          setInputValue(css);
          initialValueRef.current = css;
        }}
        onBlur={() => {
          if (inputValue !== initialValueRef.current) {
            tryApply(inputValue);
          }
          setFocused(false);
        }}
        onChange={(e) => {
          setInputValue(e.target.value);
          tryApply(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            tryApply(inputValue);
            inputRef.current?.blur();
          }
        }}
        onPaste={(e) => {
          e.preventDefault();
          const pasted = e.clipboardData.getData("text").trim();
          setInputValue(pasted);
          tryApply(pasted);
        }}
      />
    </Field.Root>
  );
}
