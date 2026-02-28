import { lazy, Suspense } from "react";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { ColorPickerProvider } from "./color-picker-context";
import "./color-picker.css";

const ColorPickerDesktop = lazy(() => import("./color-picker.desktop"));
const ColorPickerMobile = lazy(() => import("./color-picker.mobile"));

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

export function ColorPicker(props: ColorPickerProps) {
  const isMobile = useIsMobile();
  return (
    <ColorPickerProvider {...props}>
      <Suspense>{isMobile ? <ColorPickerMobile /> : <ColorPickerDesktop />}</Suspense>
    </ColorPickerProvider>
  );
}
