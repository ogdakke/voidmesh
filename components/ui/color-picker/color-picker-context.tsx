import { useRef, useState, useEffect, type PropsWithChildren } from "react";
import type { ColorPickerProps } from "./color-picker";
import { ColorPickerContext } from "./use-color-picker";

/** Strips optional "#", expands 3-digit shorthand, validates 6/8-digit hex. Returns "#rrggbb[aa]" or null. */
function resolveHex(input: string): string | null {
  const stripped = input.trim().replace(/^#/, "");
  const expanded = /^[0-9a-fA-F]{3}$/.test(stripped)
    ? `${stripped[0]}${stripped[0]}${stripped[1]}${stripped[1]}${stripped[2]}${stripped[2]}`
    : stripped;
  return /^[0-9a-fA-F]{6}$/.test(expanded) || /^[0-9a-fA-F]{8}$/.test(expanded)
    ? `#${expanded}`
    : null;
}

export interface ColorPickerContextValue {
  value: string;
  onChange: (hex: string) => void;
  onRemove?: () => void;
  label?: string;
  isDisabled: boolean;
  inputValue: string;
  setInputValue: (v: string) => void;
  textFocused: boolean;
  setTextFocused: (v: boolean) => void;
  displayValue: string;
  fieldActionsRef: React.RefObject<{ validate: () => void } | null>;
  startInteraction: () => void;
  endInteraction: () => void;
  handleInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleTextChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handlePaste: (e: React.ClipboardEvent<HTMLInputElement>) => void;
}

export function ColorPickerProvider({
  value,
  onChange,
  onRemove,
  onChangeStart,
  onChangeEnd,
  label,
  isDisabled = false,
  children,
}: PropsWithChildren<ColorPickerProps>) {
  const isInteractingRef = useRef(false);
  const fieldActionsRef = useRef<{ validate: () => void } | null>(null);
  const onChangeEndRef = useRef(onChangeEnd);
  // oxlint-disable-next-line react-hooks-js/refs -- callback ref pattern: only read in event handlers, not during render
  onChangeEndRef.current = onChangeEnd;

  const [inputValue, setInputValue] = useState<string>(() => value.replace(/^#/, ""));
  const [textFocused, setTextFocused] = useState(false);
  const displayValue = textFocused ? inputValue : value.replace(/^#/, "");

  const startInteraction = () => {
    if (!isInteractingRef.current) {
      isInteractingRef.current = true;
      onChangeStart?.();
    }
  };

  const endInteraction = () => {
    if (isInteractingRef.current) {
      isInteractingRef.current = false;
      onChangeEndRef.current?.();
    }
  };

  useEffect(() => {
    return () => {
      if (isInteractingRef.current) {
        onChangeEndRef.current?.();
      }
    };
  }, []);

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let raw = e.target.value;
    if (raw.startsWith("#")) {
      raw = raw.slice(1);
      e.target.value = raw; // immediate DOM fix, before controlled re-render
    }
    setInputValue(raw);
    const resolved = resolveHex(raw);
    if (resolved) onChange(resolved);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const resolved = resolveHex(event.clipboardData.getData("text"));
    if (resolved) {
      const stripped = resolved.slice(1);
      event.currentTarget.value = stripped; // sync DOM before validate() reads element.validity
      fieldActionsRef.current?.validate();
      setInputValue(stripped);
      onChange(resolved);
    }
  };

  return (
    <ColorPickerContext
      value={{
        value,
        onChange,
        onRemove,
        label,
        isDisabled,
        inputValue,
        setInputValue,
        textFocused,
        setTextFocused,
        displayValue,
        fieldActionsRef,
        startInteraction,
        endInteraction,
        handleInput,
        handleTextChange,
        handlePaste,
      }}
    >
      {children}
    </ColorPickerContext>
  );
}
