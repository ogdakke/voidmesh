// ---------------------------------------------------------------------------
// Canvas UI Menu Primitives
// ---------------------------------------------------------------------------
//
// Reusable menu component primitives rendered via the WebGPU canvas UI system.
// Styling matches the DOM menu.css for visual consistency.
//

import type { ReactNode } from "react";
import type { UIEventHandler, UIColorValue, StateStyle } from "../elements.ts";
import { edges, lightDark, solid, spring } from "../elements.ts";
import { Box, Text, Icon } from "../primitives.tsx";
import { Check, Minus, NavArrowRight } from "iconoir-react";

// ---------------------------------------------------------------------------
// Shared colors and styles (matching menu.css / debug-ui.tsx conventions)
// ---------------------------------------------------------------------------

const PANEL_TEXT: UIColorValue = lightDark("#151924", "#f5f7fb");
const PANEL_BG = solid(lightDark("rgba(248, 249, 252, 0.94)", "rgba(16, 18, 24, 0.94)"));
const PANEL_BORDER: UIColorValue = lightDark("rgba(20, 26, 38, 0.12)", "rgba(255, 255, 255, 0.12)");
const MUTED: UIColorValue = lightDark("#5f6777", "#9aa4b5");
const DIVIDER: UIColorValue = lightDark("rgba(16, 22, 34, 0.12)", "rgba(255, 255, 255, 0.08)");
const DESTRUCTIVE_TEXT: UIColorValue = lightDark("#d93036", "#ff9a9f");
const DESTRUCTIVE_HOVER = solid(lightDark("rgba(217, 48, 54, 0.1)", "rgba(255, 154, 159, 0.12)"));
const HIGHLIGHT_BG = solid(lightDark("rgba(0, 0, 0, 0.06)", "rgba(255, 255, 255, 0.08)"));
const ITEM_HOVER: StateStyle = {
  background: HIGHLIGHT_BG,
};
const ITEM_ACTIVE: StateStyle = { scale: 0.98 };
const ITEM_TRANSITION = { scale: spring(0.24) };

// Indicator icon size (0.875rem = 14px)
const INDICATOR_SIZE = 14;
// Radio dot: 0.5rem indicator container, visually smaller
const RADIO_DOT_SIZE = 8;

// ---------------------------------------------------------------------------
// MenuPanel
// ---------------------------------------------------------------------------

export interface MenuPanelProps {
  children: ReactNode;
  width?: number;
}

export function MenuPanel({ children, width }: MenuPanelProps) {
  return (
    <Box
      direction="col"
      align="stretch"
      padding={edges(4, 4)}
      background={PANEL_BG}
      borderRadius={8}
      borderWidth={1}
      borderColor={PANEL_BORDER}
      width={width}
    >
      {children}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// MenuItem
// ---------------------------------------------------------------------------

export interface MenuItemProps {
  label: string;
  icon?: React.ComponentType<Record<string, unknown>>;
  hint?: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick?: UIEventHandler;
}

export function MenuItem({
  label,
  icon: iconProp,
  hint,
  destructive = false,
  disabled = false,
  onClick,
}: MenuItemProps) {
  const hasIconRight = hint != null || iconProp != null;
  const textColor = destructive ? DESTRUCTIVE_TEXT : PANEL_TEXT;
  const hoverStyle = destructive ? { background: DESTRUCTIVE_HOVER } : ITEM_HOVER;

  return (
    <Box
      direction="row"
      justifyContent="space-between"
      align="center"
      padding={hasIconRight ? edges(8, 8, 8, 16) : edges(8, 32, 8, 16)}
      gap={hasIconRight ? 56 : undefined}
      borderRadius={4}
      opacity={disabled ? 0.5 : 1}
      hover={disabled ? undefined : hoverStyle}
      active={disabled ? undefined : ITEM_ACTIVE}
      transition={ITEM_TRANSITION}
      onClick={disabled ? undefined : onClick}
    >
      <Text fontSize={14} color={textColor}>
        {label}
      </Text>

      {hint ? (
        <Text fontSize={12} color={MUTED}>
          {hint}
        </Text>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// MenuSeparator
// ---------------------------------------------------------------------------

export function MenuSeparator() {
  return (
    <Box padding={edges(6, 0)}>
      <Box height={1} background={solid(DIVIDER)} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// MenuGroupLabel
// ---------------------------------------------------------------------------

export interface MenuGroupLabelProps {
  label: string;
}

export function MenuGroupLabel({ label }: MenuGroupLabelProps) {
  return (
    <Box padding={edges(8, 32, 8, 14)}>
      <Text fontSize={12} color={MUTED}>
        {label}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// MenuCheckboxItem
// ---------------------------------------------------------------------------

export interface MenuCheckboxItemProps {
  label: string;
  checked: boolean;
  mixed?: boolean;
  hint?: string;
  disabled?: boolean;
  onClick?: UIEventHandler;
}

export function MenuCheckboxItem({
  label,
  checked,
  mixed = false,
  hint,
  disabled = false,
  onClick,
}: MenuCheckboxItemProps) {
  const hasIconRight = hint != null;

  return (
    <Box
      direction="row"
      justifyContent="space-between"
      align="center"
      padding={hasIconRight ? edges(8, 8, 8, 32) : edges(8, 32, 8, 32)}
      gap={hasIconRight ? 56 : undefined}
      borderRadius={4}
      opacity={disabled ? 0.5 : 1}
      hover={disabled ? undefined : ITEM_HOVER}
      active={disabled ? undefined : ITEM_ACTIVE}
      transition={ITEM_TRANSITION}
      onClick={disabled ? undefined : onClick}
    >
      {/* Indicator positioned at left: 0.5rem (8px) */}
      {checked || mixed ? (
        <Box position="absolute" left={8} top={0} bottom={0} align="center" justifyContent="center">
          <Icon icon={mixed ? Minus : Check} size={INDICATOR_SIZE} tint={PANEL_TEXT} />
        </Box>
      ) : null}

      <Text fontSize={14} color={PANEL_TEXT}>
        {label}
      </Text>

      {hint ? (
        <Text fontSize={12} color={MUTED}>
          {hint}
        </Text>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// MenuRadioItem
// ---------------------------------------------------------------------------

export interface MenuRadioItemProps {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onClick?: UIEventHandler;
}

export function MenuRadioItem({ label, selected, disabled = false, onClick }: MenuRadioItemProps) {
  return (
    <Box
      direction="row"
      align="center"
      padding={edges(8, 32, 8, 32)}
      borderRadius={4}
      opacity={disabled ? 0.5 : 1}
      hover={disabled ? undefined : ITEM_HOVER}
      active={disabled ? undefined : ITEM_ACTIVE}
      transition={ITEM_TRANSITION}
      onClick={disabled ? undefined : onClick}
    >
      {/* Radio indicator at left: 0.75rem (12px) */}
      {selected ? (
        <Box
          position="absolute"
          left={12}
          top={0}
          bottom={0}
          align="center"
          justifyContent="center"
        >
          <Box
            width={RADIO_DOT_SIZE}
            height={RADIO_DOT_SIZE}
            borderRadius={999}
            background={solid(PANEL_TEXT)}
          />
        </Box>
      ) : null}

      <Text fontSize={14} color={PANEL_TEXT}>
        {label}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// MenuSubmenuTrigger
// ---------------------------------------------------------------------------
//
// Renders the visual trigger item (label + arrow icon). Does NOT handle
// submenu show/hide logic — that is managed by the context menu component
// using SubmenuController.
//

export interface MenuSubmenuTriggerProps {
  label: string;
  children?: ReactNode;
  onHoverEnter?: (node: import("../scene-node.ts").SceneNode) => void;
  onHoverLeave?: (node: import("../scene-node.ts").SceneNode) => void;
}

export function MenuSubmenuTrigger({
  label,
  children,
  onHoverEnter,
  onHoverLeave,
}: MenuSubmenuTriggerProps) {
  return (
    <Box
      direction="row"
      justifyContent="space-between"
      align="center"
      padding={edges(8, 16, 8, 16)}
      gap={16}
      borderRadius={4}
      hover={ITEM_HOVER}
      active={ITEM_ACTIVE}
      transition={ITEM_TRANSITION}
      onHoverEnter={onHoverEnter}
      onHoverLeave={onHoverLeave}
    >
      <Text fontSize={14} color={PANEL_TEXT}>
        {label}
      </Text>
      <Icon icon={NavArrowRight} size={INDICATOR_SIZE} tint={MUTED} />
      {children}
    </Box>
  );
}
