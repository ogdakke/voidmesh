import { Trash } from "iconoir-react";
import { Button } from "../button";
import { ColorPicker } from "./color-picker";
import { usePickerClose } from "./use-color-picker";
import { Field } from "#ui/field/field.tsx";

interface MobilePresetProps {
  onRemove?: () => void;
}

export default function MobilePreset({ onRemove }: MobilePresetProps) {
  const close = usePickerClose();

  const handleRemove = () => {
    close?.();
    onRemove?.();
  };

  return (
    <>
      <ColorPicker.DrawerTrigger title="Edit color">
        <ColorPicker.Swatch />
      </ColorPicker.DrawerTrigger>
      <ColorPicker.DrawerPopup>
        <ColorPicker.Area />
        <ColorPicker.HueSlider>
          <Field.Label>Hue</Field.Label>
        </ColorPicker.HueSlider>
        <ColorPicker.AlphaSlider>
          <Field.Label>Alpha</Field.Label>
        </ColorPicker.AlphaSlider>
        <ColorPicker.Footer>
          <div className="color-picker-footer-top-row">
            <ColorPicker.ValueInput />
            {onRemove && (
              <Button
                onClick={handleRemove}
                icon
                variant="destructive"
                className="color-picker-remove-button"
              >
                <Trash />
              </Button>
            )}
          </div>
        </ColorPicker.Footer>
      </ColorPicker.DrawerPopup>
    </>
  );
}
