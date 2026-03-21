/** @jsxImportSource ./jsx */
import type {
  UIElement,
  UIColor,
  UIBackground,
  UIEventHandler,
  StateStyle,
  ReactIconComponent,
} from "./elements.ts";
import { edges } from "./elements.ts";
import { easings } from "../../lib/canvas-math.ts";
import { Check, Xmark, Star, Heart, Settings, Drag } from "iconoir-react";

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const WHITE: UIColor = { r: 1, g: 1, b: 1, a: 1 };
const BLACK: UIColor = { r: 0, g: 0, b: 0, a: 1 };
const GRAY: UIColor = { r: 0.5, g: 0.5, b: 0.5, a: 1 };
const BLUE: UIColor = { r: 0.27, g: 0.53, b: 0.96, a: 1 };
const RED: UIColor = { r: 0.9, g: 0.25, b: 0.3, a: 1 };
const AMBER: UIColor = { r: 0.95, g: 0.75, b: 0.28, a: 1 };

const BG_DARK: UIBackground = { type: "solid", color: { r: 0.14, g: 0.14, b: 0.17, a: 0.96 } };
const BG_CARD: UIBackground = { type: "solid", color: { r: 0.18, g: 0.18, b: 0.2, a: 0.92 } };
const BG_BLUE: UIBackground = {
  type: "gradient",
  top: { r: 0.27, g: 0.53, b: 0.96, a: 1 },
  bottom: { r: 0.2, g: 0.44, b: 0.9, a: 1 },
};
const BG_GREEN: UIBackground = {
  type: "gradient",
  top: { r: 0.2, g: 0.8, b: 0.4, a: 1 },
  bottom: { r: 0.15, g: 0.65, b: 0.35, a: 1 },
};
const BG_RED: UIBackground = { type: "solid", color: RED };
const BG_PURPLE: UIBackground = {
  type: "gradient",
  top: { r: 0.6, g: 0.3, b: 0.9, a: 1 },
  bottom: { r: 0.45, g: 0.2, b: 0.75, a: 1 },
};

// State styles
const HOVER_BRIGHTEN: StateStyle = { opacity: 0.85 };
const ACTIVE_PRESS: StateStyle = { scale: 0.94 };
const _HOVER_BLUE_BORDER: StateStyle = { borderColor: BLUE, borderWidth: 1 };
const SCALE_TRANSITION = { scale: { duration: 120, easing: easings.easeOutCubic } };

// ---------------------------------------------------------------------------
// Button component — with :active press effect
// ---------------------------------------------------------------------------

function Button(props: Record<string, unknown>): UIElement {
  const {
    label,
    background,
    color,
    icon: iconProp,
    onClick: _onClick,
    children: _children,
    ...rest
  } = props;
  const bg = (background as UIBackground) ?? BG_BLUE;
  const textColor = (color as UIColor) ?? WHITE;

  const content: UIElement[] = [];
  if (iconProp) {
    content.push(<icon icon={iconProp as ReactIconComponent} size={14} tint={textColor} />);
  }
  if (label) {
    content.push(
      <text fontSize={12} color={textColor}>
        {label as string}
      </text>,
    );
  }

  return (
    <box
      {...rest}
      direction="row"
      gap={6}
      padding={edges(6, 12)}
      background={bg}
      borderRadius={6}
      align="center"
      hover={HOVER_BRIGHTEN}
      active={ACTIVE_PRESS}
      transition={SCALE_TRANSITION}
      onClick={_onClick as UIEventHandler}
    >
      {content}
    </box>
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

function Badge(props: Record<string, unknown>): UIElement {
  const { label, background, color } = props;
  return (
    <box
      padding={edges(3, 8)}
      background={(background as UIBackground) ?? BG_PURPLE}
      borderRadius={10}
      hover={HOVER_BRIGHTEN}
      active={ACTIVE_PRESS}
      transition={SCALE_TRANSITION}
    >
      <text fontSize={10} color={(color as UIColor) ?? WHITE}>
        {label as string}
      </text>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Stat row
// ---------------------------------------------------------------------------

function StatRow(props: Record<string, unknown>): UIElement {
  const { label, value } = props;
  return (
    <box direction="row" gap={8} align="center" justifyContent="space-between" minWidth={160}>
      <text fontSize={11} color={GRAY}>
        {label as string}
      </text>
      <text fontSize={11} color={WHITE}>
        {value as string}
      </text>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Screen-space debug panel (fixed size regardless of zoom)
// ---------------------------------------------------------------------------

export function buildDebugUI(zoom: number): UIElement {
  return (
    <box
      direction="col"
      gap={12}
      padding={edges(16)}
      background={BG_DARK}
      borderRadius={12}
      minWidth={240}
      borderWidth={1}
      borderColor={{ r: 0.25, g: 0.25, b: 0.3, a: 0.5 }}
    >
      <box direction="row" gap={8} align="center">
        <icon icon={Settings} size={18} tint={BLUE} />
        <text fontSize={16} color={WHITE}>
          UI Engine Stress Test
        </text>
      </box>

      <box background={{ type: "solid", color: { r: 0.3, g: 0.3, b: 0.32, a: 0.6 } }} height={1} />

      <box direction="row" gap={6} align="center">
        <Button
          label="Primary"
          background={BG_BLUE}
          icon={Check}
          onClick={() => console.log("[CanvasUI] Primary clicked")}
        />
        <Button
          label="Success"
          background={BG_GREEN}
          icon={Check}
          onClick={() => console.log("[CanvasUI] Success clicked")}
        />
        <Button
          label="Danger"
          background={BG_RED}
          color={WHITE}
          icon={Xmark}
          onClick={() => console.log("[CanvasUI] Danger clicked")}
        />
      </box>

      <box direction="row" gap={6} align="center">
        <Button
          label="Purple"
          background={BG_PURPLE}
          icon={Star}
          onClick={() => console.log("[CanvasUI] Purple clicked")}
        />
        <Button
          label="Outlined"
          background={{ type: "solid", color: { r: 0, g: 0, b: 0, a: 0 } }}
          color={BLUE}
          onClick={() => console.log("[CanvasUI] Outlined clicked")}
        />
      </box>

      <box direction="col" gap={6} padding={edges(10)} background={BG_CARD} borderRadius={8}>
        <box direction="row" gap={6} align="center">
          <icon icon={Heart} size={14} tint={RED} />
          <text fontSize={13} color={WHITE}>
            Statistics
          </text>
        </box>
        <StatRow label="Zoom" value={`${Math.round(zoom * 100)}%`} />
        <StatRow label="Size Mode" value="Screen-space" />
        <StatRow label="Events" value="hover + active" />
      </box>

      <box direction="row" gap={4} align="center">
        <Badge label="Retained" background={BG_BLUE} />
        <Badge label="TSX" background={BG_GREEN} />
        <Badge label="WebGPU" background={BG_PURPLE} />
        <Badge label="SDF" background={{ type: "solid", color: AMBER }} color={BLACK} />
      </box>

      <box direction="row" gap={4} align="center" justifyContent="center">
        <text fontSize={9} color={{ r: 0.4, g: 0.4, b: 0.45, a: 1 }}>
          Screen-space · Hover · Active · Click · Drag
        </text>
      </box>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Unified debug UI — world-space panel + screen-space overlay in one tree
// ---------------------------------------------------------------------------

export function buildDebugOverlay(zoom: number): UIElement {
  return (
    <box key="debug-root" draggable>
      {/* World-space content (scales with zoom, draggable via root) */}
      <box
        direction="col"
        gap={16}
        padding={edges(24)}
        background={{
          type: "gradient",
          top: { r: 0.08, g: 0.12, b: 0.2, a: 0.95 },
          bottom: { r: 0.05, g: 0.08, b: 0.15, a: 0.95 },
        }}
        borderRadius={4}
        borderWidth={2}
        borderColor={{ r: 0.2, g: 0.35, b: 0.6, a: 0.6 }}
      >
        <box direction="row" gap={12} align="center">
          <icon icon={Drag} size={24} tint={{ r: 0.4, g: 0.6, b: 1, a: 0.7 }} />
          <text fontSize={20} color={WHITE}>
            World-Space UI
          </text>
        </box>

        <text fontSize={14} color={GRAY}>
          This element lives in world space.
        </text>
        <text fontSize={14} color={GRAY}>
          Zoom in/out to see it scale. Drag to move.
        </text>

        <box direction="row" gap={10} align="center">
          <Button
            label="World Button"
            background={BG_BLUE}
            icon={Star}
            onClick={() => console.log("[CanvasUI] World button clicked")}
          />
          <Button
            label="Another"
            background={BG_GREEN}
            icon={Heart}
            onClick={() => console.log("[CanvasUI] Another clicked")}
          />
        </box>
      </box>

      {/* Screen-space debug panel (fixed to viewport, always on top) */}
      <box position="fixed" left={80} bottom={40} zIndex={100}>
        {buildDebugUI(zoom)}
      </box>
    </box>
  );
}
