// oxlint-disable react/only-export-components -- compound component: sub-components are internal, only the namespace object is exported
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { NavArrowRight, Check, Circle, Minus } from "iconoir-react";
import clsx from "clsx";
import type { ReactNode } from "react";
import "./menu.css";

/* ─── Root ─────────────────────────────────────────── */

const Root = BaseMenu.Root;

/* ─── Trigger ──────────────────────────────────────── */

const Trigger = BaseMenu.Trigger;

/* ─── Popup (Portal + Positioner + Popup) ──────────── */

interface PopupProps {
  sideOffset?: number;
  align?: BaseMenu.Positioner.Props["align"];
  side?: BaseMenu.Positioner.Props["side"];
  className?: string;
  children: ReactNode;
}

function Popup({ sideOffset = 8, align, side, className, children }: PopupProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        className="menu-positioner"
        sideOffset={sideOffset}
        align={align}
        side={side}
      >
        <BaseMenu.Popup className={clsx("menu-popup", className)}>{children}</BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

/* ─── Item ─────────────────────────────────────────── */

interface ItemProps extends BaseMenu.Item.Props {
  variant?: "destructive";
}

function Item({ variant, className, children, ...props }: ItemProps) {
  return (
    <BaseMenu.Item className={clsx("menu-item", className)} data-variant={variant} {...props}>
      {children}
    </BaseMenu.Item>
  );
}

/* ─── Icon slots ───────────────────────────────────── */

function IconLeft({ children }: { children: ReactNode }) {
  return <span className="menu-icon-left">{children}</span>;
}

function IconRight({ children }: { children: ReactNode }) {
  return <span className="menu-icon-right">{children}</span>;
}

/* ─── Separator ────────────────────────────────────── */

function Separator() {
  return <BaseMenu.Separator className="menu-separator" />;
}

/* ─── CheckboxItem ─────────────────────────────────── */

interface CheckboxItemProps extends BaseMenu.CheckboxItem.Props {
  mixed?: boolean;
}

function CheckboxItem({ mixed, className, children, ...props }: CheckboxItemProps) {
  return (
    <BaseMenu.CheckboxItem
      className={clsx("menu-checkbox-item", className)}
      data-mixed={mixed ? "" : undefined}
      {...props}
    >
      <BaseMenu.CheckboxItemIndicator className="menu-checkbox-indicator">
        {mixed ? <Minus /> : <Check />}
      </BaseMenu.CheckboxItemIndicator>
      {children}
    </BaseMenu.CheckboxItem>
  );
}

/* ─── RadioGroup ───────────────────────────────────── */

const RadioGroup = BaseMenu.RadioGroup;

/* ─── RadioItem ────────────────────────────────────── */

interface RadioItemProps extends BaseMenu.RadioItem.Props {}

function RadioItem({ className, children, ...props }: RadioItemProps) {
  return (
    <BaseMenu.RadioItem className={clsx("menu-radio-item", className)} {...props}>
      <BaseMenu.RadioItemIndicator className="menu-radio-indicator">
        <Circle fill="currentColor" />
      </BaseMenu.RadioItemIndicator>
      {children}
    </BaseMenu.RadioItem>
  );
}

/* ─── Submenu ──────────────────────────────────────── */

const Submenu = BaseMenu.SubmenuRoot;

/* ─── SubmenuTrigger ───────────────────────────────── */

interface SubmenuTriggerProps extends BaseMenu.SubmenuTrigger.Props {}

function SubmenuTrigger({ className, children, ...props }: SubmenuTriggerProps) {
  return (
    <BaseMenu.SubmenuTrigger className={clsx("menu-submenu-trigger", className)} {...props}>
      {children}
      <NavArrowRight />
    </BaseMenu.SubmenuTrigger>
  );
}

/* ─── SubmenuPopup (Portal + Positioner + Popup) ──── */

interface SubmenuPopupProps {
  sideOffset?: number;
  className?: string;
  children: ReactNode;
}

function SubmenuPopup({ sideOffset = 4, className, children }: SubmenuPopupProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner className="menu-positioner" sideOffset={sideOffset}>
        <BaseMenu.Popup className={clsx("menu-submenu-popup", className)}>
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

/* ─── Group / GroupLabel ───────────────────────────── */

const Group = BaseMenu.Group;

interface GroupLabelProps extends BaseMenu.GroupLabel.Props {}

function GroupLabel({ className, children, ...props }: GroupLabelProps) {
  return (
    <BaseMenu.GroupLabel className={clsx("menu-group-label", className)} {...props}>
      {children}
    </BaseMenu.GroupLabel>
  );
}

/* ─── Namespace export ─────────────────────────────── */

export const Menu = {
  Root,
  Trigger,
  Popup,
  Item,
  IconLeft,
  IconRight,
  Separator,
  CheckboxItem,
  RadioGroup,
  RadioItem,
  Submenu,
  SubmenuTrigger,
  SubmenuPopup,
  Group,
  GroupLabel,
};
