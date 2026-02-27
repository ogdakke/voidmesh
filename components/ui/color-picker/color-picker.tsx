import { useRef, useState, useEffect } from "react";
import { EditPencil, Trash } from "iconoir-react";
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
  const onChangeEndRef = useRef(onChangeEnd);
  // oxlint-disable-next-line react-hooks-js/refs -- callback ref pattern: only read in event handlers, not during render
  onChangeEndRef.current = onChangeEnd;

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

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.trim();
    const hex = /^#[0-9a-fA-F]{3}$/.test(raw)
      ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
      : raw;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      onChange(hex);
    }
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

  const [defaultValue] = useState<string>(value);

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
                <EditPencil />
                <span>Edit</span>
              </label>
              <Field.Root validationMode="onChange">
                <Field.Label className="color-picker__label">Color</Field.Label>
                <Field.Control
                  className="color-picker__input"
                  type="text"
                  defaultValue={defaultValue}
                  pattern="#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?"
                  onChange={handleInput}
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
