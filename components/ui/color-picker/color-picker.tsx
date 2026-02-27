import { useRef, useState, useEffect } from "react";
import { EditPencil, Trash, ColorPicker as ColorPickerIcon } from "iconoir-react";
import { Menu } from "../menu/menu";
import { Drawer } from "../drawer";
import { Button } from "../button";
import { useIsMobile } from "#hooks/use-is-mobile.ts";

import "./color-picker.css";
import { Field } from "#ui/field/field.tsx";

export interface ColorPickerProps {
  /** Hex color value like "#ff0000" */
  value: string;
  /** Called with new hex string when user picks a color */
  onChange: (hex: string) => void;
  /** If provided, shows a delete/remove option */
  onRemove?: () => void;
  /** Called when a continuous color-change interaction begins (e.g. picker opens) */
  onChangeStart?: () => void;
  /** Called when the interaction ends (e.g. picker closes) */
  onChangeEnd?: () => void;
  label?: string;
  isDisabled?: boolean;
}

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

function Swatch({ color, className }: { color: string; className?: string }) {
  return (
    <span className={`color-picker__swatch ${className ?? ""}`} style={{ background: color }} />
  );
}

export function ColorPicker({
  value,
  onChange,
  onRemove,
  onChangeStart,
  onChangeEnd,
  label,
  isDisabled = false,
}: ColorPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  const isInteractingRef = useRef(false);
  // Used to imperatively trigger Field validation after a programmatic value change (paste).
  const fieldActionsRef = useRef<{ validate: () => void }>(null);
  const onChangeEndRef = useRef(onChangeEnd);
  // oxlint-disable-next-line react-hooks-js/refs -- callback ref pattern: only read in event handlers, not during render
  onChangeEndRef.current = onChangeEnd;
  // While focused, display the user's local edits. Otherwise derive from the value prop.
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

  // Cleanup: end interaction if component unmounts mid-interaction
  useEffect(() => {
    return () => {
      if (isInteractingRef.current) {
        onChangeEndRef.current?.();
      }
    };
  }, []);

  const openNativePicker = () => {
    startInteraction();
    inputRef.current?.click();
  };

  // For the native type="color" input — always returns "#rrggbb"
  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  // For the text input — strips leading "#" from display, parses hex/hexA
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

  const hiddenInput = (
    <input
      ref={inputRef}
      type="color"
      className="color-picker__native-input"
      value={value}
      onChange={handleInput}
      onBlur={endInteraction}
      tabIndex={-1}
      aria-hidden
    />
  );

  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleDrawerOpenChange = (open: boolean) => {
    setDrawerOpen(open);
    if (open) {
      startInteraction();
    } else {
      endInteraction();
    }
  };

  const handleRemove = () => {
    setDrawerOpen(false);
    endInteraction();
    onRemove?.();
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

  if (isMobile) {
    return (
      <Drawer.Root open={drawerOpen} onOpenChange={handleDrawerOpenChange}>
        <Drawer.Trigger
          className="color-picker"
          disabled={isDisabled}
          data-disabled={isDisabled || undefined}
        >
          <Swatch color={value} />
          {!!label && <span>{label}</span>}
        </Drawer.Trigger>
        <Drawer.Popup className="color-picker__drawer">
          <Drawer.Content className="color-picker__drawer-body">
            <input
              id="color-picker-mobile"
              type="color"
              className="color-picker__drawer-input"
              value={value}
              onChange={handleInput}
            />
            <div className="color-picker__drawer-actions">
              <label
                htmlFor="color-picker-mobile"
                className="ui-button"
                data-variant="primary"
                data-size="md"
              >
                <ColorPickerIcon />
                <span>Edit color</span>
              </label>
              <Field.Root actionsRef={fieldActionsRef} validationMode="onChange">
                <Field.Control
                  required
                  aria-label="Color"
                  className="color-picker__input"
                  type="text"
                  value={displayValue}
                  pattern="[0-9a-fA-F]{3}([0-9a-fA-F]{3})?"
                  onChange={handleTextChange}
                  onFocus={() => {
                    setTextFocused(true);
                    setInputValue(value.replace(/^#/, ""));
                  }}
                  onBlur={() => {
                    setTextFocused(false);
                  }}
                  placeholder="000"
                  onPaste={handlePaste}
                />
              </Field.Root>
              {onRemove && (
                <Button onClick={handleRemove} variant="destructive">
                  <Trash />
                  <span>Remove</span>
                </Button>
              )}
            </div>
          </Drawer.Content>
        </Drawer.Popup>
      </Drawer.Root>
    );
  }

  return (
    <div className="color-picker__wrapper">
      <Menu.Root>
        <Menu.Trigger
          className="color-picker"
          disabled={isDisabled}
          data-disabled={isDisabled || undefined}
        >
          <Swatch color={value} />
          {!!label && <span>{label}</span>}
        </Menu.Trigger>
        <Menu.Popup side="bottom" align="start">
          <Menu.Item onClick={openNativePicker}>
            <Menu.IconLeft>
              <EditPencil />
            </Menu.IconLeft>
            Edit
          </Menu.Item>
          {onRemove && (
            <Menu.Item variant="destructive" onClick={onRemove}>
              <Menu.IconLeft>
                <Trash />
              </Menu.IconLeft>
              Remove
            </Menu.Item>
          )}
        </Menu.Popup>
      </Menu.Root>
      {hiddenInput}
    </div>
  );
}
