import { ColorPicker as EyedropperIcon } from "iconoir-react";
import { Button } from "../button";
import { useColorPicker } from "./use-color-picker";

const hasEyeDropper = typeof window !== "undefined" && "EyeDropper" in window;

export function EyeDropperButton() {
  const {
    actions: { setCssValue },
  } = useColorPicker();

  const handleClick = async () => {
    if (!window.EyeDropper) return;
    try {
      const dropper = new window.EyeDropper();
      const result = await dropper.open();
      setCssValue(result.sRGBHex);
    } catch {
      // User cancelled
    }
  };

  if (!hasEyeDropper) return null;

  return (
    <Button
      variant="primary"
      icon
      onClick={handleClick}
      aria-label="Pick color from screen"
      className="color-picker__eyedropper"
    >
      <EyedropperIcon />
    </Button>
  );
}
