import { useState, useRef } from "react";
import { cssToOklch } from "#lib/color-utils.ts";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { Select, SelectItem } from "#ui/select/select.tsx";
import { NativeSelect, NativeSelectOption } from "#ui/native-select/native-select.tsx";
import { useColorPicker } from "./use-color-picker";
import { Field } from "#ui/field/field.tsx";
import {
  detectColorValueFormat,
  formatOklchForValueFormat,
  getColorValueFormatDefinition,
  normalizeColorValueForFormat,
  type ColorValueFormat,
} from "./color-value-formats";
import type { FieldRootProps } from "@base-ui/react";

interface ValueInputProps extends FieldRootProps {}
export function ValueInput(props: ValueInputProps) {
  const {
    state: { oklch },
    actions: { setCssValue, setSelectedFormat },
    meta: { supportsP3, selectedFormat, availableFormats },
  } = useColorPicker();

  const isMobile = useIsMobile();
  const [focused, setFocused] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const inputValueRef = useRef("");
  const initialValueRef = useRef("");
  const suppressBlurApplyRef = useRef(false);

  const displayValue = focused ? inputValue : formatOklchForValueFormat(oklch, selectedFormat);
  const formatOptions = { supportsP3 };

  const tryApply = (raw: string) => {
    const detectedFormat = detectColorValueFormat(raw, formatOptions);
    if (!detectedFormat) return null;

    const normalized = normalizeColorValueForFormat(raw, detectedFormat);
    if (!normalized) return null;

    if (detectedFormat !== selectedFormat) {
      setSelectedFormat(detectedFormat);
    }

    setCssValue(normalized);
    return normalized;
  };

  const handleFormatChange = (nextFormat: ColorValueFormat) => {
    const draftValue = inputValueRef.current;
    const draftFormat = detectColorValueFormat(draftValue, formatOptions);
    const sourceColor =
      focused && draftFormat !== null
        ? cssToOklch(normalizeColorValueForFormat(draftValue, draftFormat) ?? draftValue)
        : oklch;
    const converted = formatOklchForValueFormat(sourceColor, nextFormat);

    suppressBlurApplyRef.current = false;
    setSelectedFormat(nextFormat);
    inputValueRef.current = converted;
    setInputValue(converted);
    initialValueRef.current = converted;
    setCssValue(converted, sourceColor);
  };

  return (
    <div className="color-picker__value-row">
      {availableFormats.length > 1 &&
        (isMobile ? (
          <NativeSelect
            aria-label="Color format"
            value={selectedFormat}
            onPointerDownCapture={() => {
              suppressBlurApplyRef.current = true;
            }}
            onChange={(event) => handleFormatChange(event.target.value as ColorValueFormat)}
            variant="quiet"
            className="color-picker__format-native-select"
          >
            {availableFormats.map((format) => (
              <NativeSelectOption key={format} value={format}>
                {getColorValueFormatDefinition(format)?.label ?? format}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : (
          <div
            className="color-picker__format-select"
            onPointerDownCapture={() => {
              suppressBlurApplyRef.current = true;
            }}
          >
            <Select
              aria-label="Color format"
              value={selectedFormat}
              onValueChange={(value) => handleFormatChange(value as ColorValueFormat)}
              formatValue={getColorValueFormatDefinition(selectedFormat)?.label ?? selectedFormat}
            >
              {availableFormats.map((format) => (
                <SelectItem key={format} value={format}>
                  {getColorValueFormatDefinition(format)?.label ?? format}
                </SelectItem>
              ))}
            </Select>
          </div>
        ))}
      <Field.Root
        {...props}
        validate={(v) => (detectColorValueFormat(String(v), formatOptions) ? null : "")}
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
            const css = formatOklchForValueFormat(oklch, selectedFormat);
            setFocused(true);
            inputValueRef.current = css;
            setInputValue(css);
            initialValueRef.current = css;
          }}
          onBlur={() => {
            if (suppressBlurApplyRef.current) {
              suppressBlurApplyRef.current = false;
              setFocused(false);
              return;
            }
            if (inputValueRef.current !== initialValueRef.current) {
              tryApply(inputValueRef.current);
            }
            setFocused(false);
          }}
          onChange={(e) => {
            const nextValue = e.target.value;
            inputValueRef.current = nextValue;
            setInputValue(nextValue);
            tryApply(nextValue);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              tryApply(inputValueRef.current);
              inputRef.current?.blur();
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            const pasted = e.clipboardData.getData("text").trim();
            inputValueRef.current = pasted;
            setInputValue(pasted);
            tryApply(pasted);
          }}
        />
      </Field.Root>
    </div>
  );
}
