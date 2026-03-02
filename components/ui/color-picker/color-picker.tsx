// oxlint-disable react/only-export-components -- compound component: sub-components are internal, only the namespace object is exported
import { lazy, Suspense, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Drawer } from "../drawer";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { Root, type ColorPickerRootProps } from "./color-picker-context";
import { useColorPicker, PickerCloseContext } from "./use-color-picker";
import { Trigger, Popup } from "./color-picker-popup";
import { DrawerTrigger, DrawerPopup } from "./color-picker-drawer";
import { ContextSwatch, Swatch } from "./swatch";
import { ColorArea } from "./color-area";
import { HueSlider, AlphaSlider } from "./color-slider";
import { ValueInput } from "./color-value-input";
import { EyeDropperButton } from "./eyedropper";
import { Footer } from "./color-picker-footer";
import "./color-picker.css";

const DesktopPreset = lazy(() => import("./color-picker.desktop"));
const MobilePreset = lazy(() => import("./color-picker.mobile"));

// ── Popover-wired Root (desktop) ─────────────────────────────────────

function PopoverRoot({ children, ...props }: React.PropsWithChildren<ColorPickerRootProps>) {
  return (
    <Root {...props}>
      <PopoverRootInner>{children}</PopoverRootInner>
    </Root>
  );
}

function PopoverRootInner({ children }: React.PropsWithChildren) {
  const {
    actions: { startInteraction, endInteraction },
  } = useColorPicker();

  const [open, setOpen] = useState(false);

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) startInteraction();
    else endInteraction();
  };

  const close = () => handleOpenChange(false);

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <PickerCloseContext value={close}>{children}</PickerCloseContext>
    </Popover.Root>
  );
}

// ── Drawer-wired Root (mobile) ───────────────────────────────────────

function DrawerRoot({ children, ...props }: React.PropsWithChildren<ColorPickerRootProps>) {
  return (
    <Root {...props}>
      <DrawerRootInner>{children}</DrawerRootInner>
    </Root>
  );
}

function DrawerRootInner({ children }: React.PropsWithChildren) {
  const {
    actions: { startInteraction, endInteraction },
  } = useColorPicker();

  const [open, setOpen] = useState(false);

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) startInteraction();
    else endInteraction();
  };

  const close = () => handleOpenChange(false);

  return (
    <Drawer.Root open={open} onOpenChange={handleOpenChange}>
      <PickerCloseContext value={close}>{children}</PickerCloseContext>
    </Drawer.Root>
  );
}

// ── Smart Root: picks Popover or Drawer ──────────────────────────────

function SmartRoot({ children, ...props }: React.PropsWithChildren<ColorPickerRootProps>) {
  const isMobile = useIsMobile();
  const RootComponent = isMobile ? DrawerRoot : PopoverRoot;
  return <RootComponent {...props}>{children}</RootComponent>;
}

// ── Compound namespace ───────────────────────────────────────────────

export const ColorPicker = {
  Root: SmartRoot,
  PopoverRoot,
  DrawerRoot,
  Trigger,
  DrawerTrigger,
  Popup,
  DrawerPopup,
  Swatch: ContextSwatch,
  Area: ColorArea,
  HueSlider,
  AlphaSlider,
  ValueInput,
  EyeDropper: EyeDropperButton,
  Footer,
};

// ── Convenience Preset (backward compat) ─────────────────────────────

export interface ColorPickerPresetProps extends Pick<ColorPickerRootProps, "colorSpace"> {
  value: string;
  onChange: (color: string) => void;
  onRemove?: () => void;
  onChangeStart?: () => void;
  onChangeEnd?: () => void;
  label?: string;
  isDisabled?: boolean;
}

export function ColorPickerPreset({
  value,
  onChange,
  onRemove,
  onChangeStart,
  onChangeEnd,
  isDisabled,
  colorSpace,
}: ColorPickerPresetProps) {
  const isMobile = useIsMobile();

  return (
    <ColorPicker.Root
      value={value}
      onChange={onChange}
      onChangeStart={onChangeStart}
      onChangeEnd={onChangeEnd}
      disabled={isDisabled}
      colorSpace={colorSpace}
    >
      <Suspense fallback={<Swatch color="var(--gray-100)" aria-busy={true} />}>
        {isMobile ? <MobilePreset onRemove={onRemove} /> : <DesktopPreset onRemove={onRemove} />}
      </Suspense>
    </ColorPicker.Root>
  );
}
