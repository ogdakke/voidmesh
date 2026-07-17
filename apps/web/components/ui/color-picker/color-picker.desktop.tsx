import { Button } from "../button";
import { ColorPicker } from "./color-picker";
import { usePickerClose } from "./use-color-picker";
import { Field } from "#ui/field/field.tsx";

interface DesktopPresetProps {
  onRemove?: () => void;
}

export default function DesktopPreset({ onRemove }: DesktopPresetProps) {
  const close = usePickerClose();

  const handleRemove = () => {
    close?.();
    onRemove?.();
  };

  return (
    <>
      <ColorPicker.Trigger title="Edit color">
        <ColorPicker.Swatch />
      </ColorPicker.Trigger>
      <ColorPicker.Popup>
        <ColorPicker.Area />
        <ColorPicker.HueSlider>
          <Field.Label>Hue</Field.Label>
        </ColorPicker.HueSlider>
        <ColorPicker.AlphaSlider>
          <Field.Label>Alpha</Field.Label>
        </ColorPicker.AlphaSlider>
        <ColorPicker.Footer>
          <ColorPicker.ValueInput />
          <div className="color-picker-desktop-actions">
            <ColorPicker.EyeDropper />
            {onRemove && (
              <Button
                onClick={handleRemove}
                variant="destructive"
                aria-label="Remove color"
                size="md"
              >
                <span>Remove</span>
              </Button>
            )}
          </div>
        </ColorPicker.Footer>
      </ColorPicker.Popup>
    </>
  );
}
