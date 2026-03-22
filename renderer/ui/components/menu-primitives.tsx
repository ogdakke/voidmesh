// ---------------------------------------------------------------------------
// Canvas UI Menu Primitives
// ---------------------------------------------------------------------------
//
// Reusable menu component primitives rendered via the WebGPU canvas UI system.
// Styling matches the DOM menu.css for visual consistency.
//

import {
  Children,
  isValidElement,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { getKeybindSymbolsById, keybindStore } from "#context/keybind-context.ts";
import type { SceneNode } from "../scene-node.ts";
import type { UIEventHandler, UIColorValue, StateStyle } from "../elements.ts";
import { blur, edges, solid, spring } from "../elements.ts";
import { Box, Text, Icon } from "../primitives.tsx";
import { Check, Minus, NavArrowRight } from "iconoir-react";

const SUBTLE_BACKDROP_BLUR = 4;
const PANEL_TEXT: UIColorValue = "var(--gray-900)";
const PANEL_BG = solid("var(--floating-background)");
const PANEL_BORDER: UIColorValue = "var(--border)";
const MUTED: UIColorValue = "var(--gray-700)";
const DIVIDER: UIColorValue = "var(--border-75)";
const DESTRUCTIVE_TEXT: UIColorValue = "var(--destructive)";
const DESTRUCTIVE_HOVER = solid("var(--destructive-25)");
const HIGHLIGHT_BG = solid("var(--gray-100)");
const SHORTCUT_TEXT: UIColorValue = "rgba(0, 0, 0, 0.86)";
const ITEM_HOVER: StateStyle = {
  background: HIGHLIGHT_BG,
  backdropFilter: [blur(SUBTLE_BACKDROP_BLUR)],
};
const ITEM_ACTIVE: StateStyle = { scale: 0.98 };
const ITEM_TRANSITION = { scale: spring(0.24) };

const ITEM_PADDING_X = 12;
const ITEM_CONTENT_GAP = 6;
const LEFT_SLOT_WIDTH = 12;
const RIGHT_SLOT_WIDTH = 12;
const RIGHT_CLUSTER_GAP = 10;
const SHORTCUT_KEY_GAP = 4;
const SHORTCUT_TEXT_SIZE = 11;
const SHORTCUT_KEY_MIN_WIDTH = 18;
const SHORTCUT_KEY_HEIGHT = 18;
const TEXT_START_INSET = ITEM_PADDING_X + LEFT_SLOT_WIDTH + ITEM_CONTENT_GAP;
const SUBMENU_GUTTER_DEFAULT = 4;

const INDICATOR_SIZE = 14;
const RADIO_DOT_SIZE = 8;

export interface MenuPanelProps {
  children: ReactNode;
  width?: number;
  onLayout?: (node: SceneNode) => void;
}

export function MenuPanel({ children, width, onLayout }: MenuPanelProps) {
  return (
    <Box
      direction="col"
      align="stretch"
      padding={edges(4, 4)}
      background={PANEL_BG}
      backdropFilter={[blur(SUBTLE_BACKDROP_BLUR)]}
      borderRadius={6}
      borderWidth={1}
      borderColor={PANEL_BORDER}
      width={width}
      onLayout={onLayout}
    >
      {children}
    </Box>
  );
}

export function MenuSeparator() {
  return (
    <Box padding={edges(6, 0)}>
      <Box height={1} background={solid(DIVIDER)} />
    </Box>
  );
}

export interface MenuGroupLabelProps {
  label: string;
}

export function MenuGroupLabel({ label }: MenuGroupLabelProps) {
  return (
    <Box padding={edges(8, ITEM_PADDING_X, 8, TEXT_START_INSET)}>
      <Text fontSize={12} color={MUTED}>
        {label}
      </Text>
    </Box>
  );
}

interface MenuSlots {
  icon: ComponentType<Record<string, unknown>> | null;
  label: string;
  shortcutId: string | undefined;
}

interface MenuLabelSlotProps {
  children: string;
}

function MenuLabelSlot(_props: MenuLabelSlotProps) {
  return null;
}

interface MenuIconSlotProps {
  children: ReactElement;
}

function MenuIconSlot(_props: MenuIconSlotProps) {
  return null;
}

interface MenuShortcutSlotProps {
  id: string;
}

function MenuShortcutSlot(_props: MenuShortcutSlotProps) {
  return null;
}

function resolveMenuSlots(children: ReactNode): MenuSlots {
  let icon: ComponentType<Record<string, unknown>> | null = null;
  let label = "";
  let shortcutId: string | undefined;

  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) {
      if (typeof child === "string") {
        label += child;
      }
      continue;
    }

    if (child.type === MenuLabelSlot) {
      const slotChildren = (child as ReactElement<MenuLabelSlotProps, typeof MenuLabelSlot>).props
        .children;
      if (typeof slotChildren === "string") {
        label += slotChildren;
      }
      continue;
    }

    if (child.type === MenuIconSlot) {
      const iconChild = (child as ReactElement<MenuIconSlotProps, typeof MenuIconSlot>).props
        .children;
      if (isValidElement(iconChild) && typeof iconChild.type !== "string") {
        icon = iconChild.type as ComponentType<Record<string, unknown>>;
      }
      continue;
    }

    if (child.type === MenuShortcutSlot) {
      shortcutId = (child as ReactElement<MenuShortcutSlotProps, typeof MenuShortcutSlot>).props.id;
      continue;
    }

    const childProps = child.props as { children?: unknown };
    if (typeof childProps.children === "string") {
      label += childProps.children;
    }
  }

  return { icon, label, shortcutId };
}

function renderLeadingSlot(
  icon: ComponentType<Record<string, unknown>> | null,
  color: UIColorValue,
) {
  return (
    <Box width={LEFT_SLOT_WIDTH} height={LEFT_SLOT_WIDTH} align="center" justifyContent="center">
      {icon ? <Icon icon={icon} size={INDICATOR_SIZE} tint={color} /> : null}
    </Box>
  );
}

function renderShortcutSlot(shortcutId: string | undefined) {
  if (!shortcutId) return null;

  const shortcutSymbols = getKeybindSymbolsById(keybindStore, shortcutId);
  if (!shortcutSymbols?.length) return null;

  return (
    <Box direction="row" align="center" gap={SHORTCUT_KEY_GAP}>
      {shortcutSymbols.map((symbol, index) => (
        <Box
          key={`${shortcutId}-${symbol}-${index}`}
          minWidth={SHORTCUT_KEY_MIN_WIDTH}
          height={SHORTCUT_KEY_HEIGHT}
          padding={edges(0, 5)}
          align="center"
          justifyContent="center"
          background={solid("rgba(255, 255, 255, 0.48)")}
          borderRadius={4}
          borderWidth={1}
          borderColor="rgba(17, 24, 39, 0.08)"
        >
          <Text fontSize={SHORTCUT_TEXT_SIZE} color={SHORTCUT_TEXT}>
            {symbol}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

interface MenuRowProps {
  leading: ReactNode;
  label: string;
  trailing?: ReactNode;
  children?: ReactNode;
  color?: UIColorValue;
  destructive?: boolean;
  disabled?: boolean;
  open?: boolean;
  onClick?: UIEventHandler;
  onHoverEnter?: (node: SceneNode) => void;
  onHoverLeave?: (node: SceneNode) => void;
}

function MenuRow({
  leading,
  label,
  trailing,
  children,
  color = PANEL_TEXT,
  destructive = false,
  disabled = false,
  open = false,
  onClick,
  onHoverEnter,
  onHoverLeave,
}: MenuRowProps) {
  const hoverStyle = destructive ? { background: DESTRUCTIVE_HOVER } : ITEM_HOVER;

  return (
    <Box
      position="relative"
      direction="row"
      justifyContent="space-between"
      align="center"
      padding={edges(8, ITEM_PADDING_X)}
      gap={RIGHT_CLUSTER_GAP}
      borderRadius={4}
      opacity={disabled ? 0.5 : 1}
      background={open ? HIGHLIGHT_BG : undefined}
      backdropFilter={open ? [blur(SUBTLE_BACKDROP_BLUR)] : undefined}
      hover={disabled ? undefined : hoverStyle}
      active={disabled || open ? undefined : ITEM_ACTIVE}
      transition={ITEM_TRANSITION}
      onClick={disabled ? undefined : onClick}
      onHoverEnter={onHoverEnter}
      onHoverLeave={onHoverLeave}
    >
      <Box direction="row" align="center" gap={ITEM_CONTENT_GAP} flexGrow={1}>
        {leading}
        <Text fontSize={14} color={color}>
          {label}
        </Text>
      </Box>
      {trailing}
      {children}
    </Box>
  );
}

export interface MenuItemProps {
  children: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onClick?: UIEventHandler;
}

function MenuItemRoot({ children, destructive = false, disabled = false, onClick }: MenuItemProps) {
  const slots = resolveMenuSlots(children);
  const textColor = destructive ? DESTRUCTIVE_TEXT : PANEL_TEXT;

  return (
    <MenuRow
      leading={renderLeadingSlot(slots.icon, textColor)}
      label={slots.label}
      trailing={renderShortcutSlot(slots.shortcutId)}
      color={textColor}
      destructive={destructive}
      disabled={disabled}
      onClick={onClick}
    />
  );
}

export const MenuItem = Object.assign(MenuItemRoot, {
  Icon: MenuIconSlot,
  Label: MenuLabelSlot,
  Shortcut: MenuShortcutSlot,
});

export interface MenuCheckboxItemProps {
  children: ReactNode;
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
  onClick?: UIEventHandler;
}

function MenuCheckboxItemRoot({
  children,
  checked,
  mixed = false,
  disabled = false,
  onClick,
}: MenuCheckboxItemProps) {
  const slots = resolveMenuSlots(children);

  return (
    <MenuRow
      leading={
        <Box
          width={LEFT_SLOT_WIDTH}
          height={LEFT_SLOT_WIDTH}
          align="center"
          justifyContent="center"
        >
          {checked || mixed ? (
            <Icon icon={mixed ? Minus : Check} size={INDICATOR_SIZE} tint={PANEL_TEXT} />
          ) : null}
        </Box>
      }
      label={slots.label}
      trailing={renderShortcutSlot(slots.shortcutId)}
      disabled={disabled}
      onClick={onClick}
    />
  );
}

export const MenuCheckboxItem = Object.assign(MenuCheckboxItemRoot, {
  Label: MenuLabelSlot,
  Shortcut: MenuShortcutSlot,
});

export interface MenuRadioItemProps {
  children: ReactNode;
  selected: boolean;
  disabled?: boolean;
  onClick?: UIEventHandler;
}

function MenuRadioItemRoot({ children, selected, disabled = false, onClick }: MenuRadioItemProps) {
  const slots = resolveMenuSlots(children);

  return (
    <MenuRow
      leading={
        <Box
          width={LEFT_SLOT_WIDTH}
          height={LEFT_SLOT_WIDTH}
          align="center"
          justifyContent="center"
        >
          {selected ? (
            <Box
              width={RADIO_DOT_SIZE}
              height={RADIO_DOT_SIZE}
              borderRadius={999}
              background={solid(PANEL_TEXT)}
            />
          ) : null}
        </Box>
      }
      label={slots.label}
      trailing={<Box width={RIGHT_SLOT_WIDTH} height={RIGHT_SLOT_WIDTH} />}
      disabled={disabled}
      onClick={onClick}
    />
  );
}

export const MenuRadioItem = Object.assign(MenuRadioItemRoot, {
  Label: MenuLabelSlot,
});

export interface MenuSubmenuTriggerProps {
  children: ReactNode;
  open?: boolean;
  onHoverEnter?: (node: SceneNode) => void;
  onHoverLeave?: (node: SceneNode) => void;
}

function MenuSubmenuTriggerRoot({
  children,
  open = false,
  onHoverEnter,
  onHoverLeave,
}: MenuSubmenuTriggerProps) {
  const slots = resolveMenuSlots(children);

  return (
    <MenuRow
      leading={<Box width={LEFT_SLOT_WIDTH} height={LEFT_SLOT_WIDTH} />}
      label={slots.label}
      trailing={
        <Box
          width={RIGHT_SLOT_WIDTH}
          height={RIGHT_SLOT_WIDTH}
          align="center"
          justifyContent="center"
        >
          <Icon icon={NavArrowRight} size={INDICATOR_SIZE} tint={MUTED} />
        </Box>
      }
      open={open}
      onHoverEnter={onHoverEnter}
      onHoverLeave={onHoverLeave}
    >
      {children}
    </MenuRow>
  );
}

export const MenuSubmenuTrigger = Object.assign(MenuSubmenuTriggerRoot, {
  Label: MenuLabelSlot,
});

export function getSubmenuOffset(gutter = SUBMENU_GUTTER_DEFAULT) {
  return { x: gutter, y: 0 };
}
