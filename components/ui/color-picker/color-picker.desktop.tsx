import { useRef } from "react";
import { EditPencil, Trash } from "iconoir-react";
import { Menu } from "../menu/menu";
import { useColorPicker } from "./use-color-picker";
import { Swatch } from "./swatch";

export default function ColorPickerDesktop() {
  const inputRef = useRef<HTMLInputElement>(null);
  const { value, onRemove, label, isDisabled, handleInput, startInteraction, endInteraction } =
    useColorPicker();

  const openNativePicker = () => {
    startInteraction();
    inputRef.current?.click();
  };

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
    </div>
  );
}
