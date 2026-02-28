import { useState } from "react";
import { Trash, ColorPicker as ColorPickerIcon } from "iconoir-react";
import { Drawer } from "../drawer";
import { Field } from "#ui/field/field.tsx";
import { Button } from "../button";
import { useColorPicker } from "./use-color-picker";
import { Swatch } from "./swatch";

export default function ColorPickerMobile() {
  const {
    value,
    onRemove,
    isDisabled,
    displayValue,
    fieldActionsRef,
    setTextFocused,
    setInputValue,
    handleInput,
    handleTextChange,
    handlePaste,
    startInteraction,
    endInteraction,
  } = useColorPicker();

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

  return (
    <Drawer.Root open={drawerOpen} onOpenChange={handleDrawerOpenChange}>
      <Drawer.Trigger
        className="color-picker"
        disabled={isDisabled}
        data-disabled={isDisabled || undefined}
      >
        <Swatch color={value} />
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
