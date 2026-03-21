/** @jsxImportSource ./jsx */
import type { UIElement, UIColor, UIBackground, StateStyle } from "./elements.ts";
import { edges } from "./elements.ts";
import { easings } from "../../lib/canvas-math.ts";

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

// Icons
const ICON_CHECK = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const ICON_X = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const ICON_STAR = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
const ICON_HEART = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
const ICON_SETTINGS = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
const ICON_DRAG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12L4 4M4 4V8M4 4H8"/><path d="M12 12L20 4M20 4V8M20 4H16"/><path d="M12 12L4 20M4 20V16M4 20H8"/><path d="M12 12L20 20M20 20V16M20 20H16"/></svg>`;

// ---------------------------------------------------------------------------
// Button component — with :active press effect
// ---------------------------------------------------------------------------

function Button(props: Record<string, unknown>): UIElement {
  const { label, background, color, iconSvg, onClick: _onClick, ...rest } = props;
  const bg = (background as UIBackground) ?? BG_BLUE;
  const textColor = (color as UIColor) ?? WHITE;

  const children: UIElement[] = [];
  if (iconSvg) {
    children.push(<icon svg={iconSvg as string} size={14} tint={textColor} />);
  }
  children.push(
    <text fontSize={12} color={textColor}>
      {label as string}
    </text>,
  );

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
      onClick={_onClick as import("./elements.ts").UIEventHandler}
    >
      {children}
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
        <icon svg={ICON_SETTINGS} size={18} tint={BLUE} />
        <text fontSize={16} color={WHITE}>
          UI Engine Stress Test
        </text>
      </box>

      <box background={{ type: "solid", color: { r: 0.3, g: 0.3, b: 0.32, a: 0.6 } }} height={1} />

      <box direction="row" gap={6} align="center">
        <Button
          label="Primary"
          background={BG_BLUE}
          iconSvg={ICON_CHECK}
          onClick={() => console.log("[CanvasUI] Primary clicked")}
        />
        <Button
          label="Success"
          background={BG_GREEN}
          iconSvg={ICON_CHECK}
          onClick={() => console.log("[CanvasUI] Success clicked")}
        />
        <Button
          label="Danger"
          background={BG_RED}
          color={WHITE}
          iconSvg={ICON_X}
          onClick={() => console.log("[CanvasUI] Danger clicked")}
        />
      </box>

      <box direction="row" gap={6} align="center">
        <Button
          label="Purple"
          background={BG_PURPLE}
          iconSvg={ICON_STAR}
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
          <icon svg={ICON_HEART} size={14} tint={RED} />
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
// World-space UI (stays fixed on the canvas, scales with zoom)
// ---------------------------------------------------------------------------

export function buildWorldSpaceUI(): UIElement {
  return (
    <box
      key="world-card"
      direction="col"
      gap={16}
      padding={edges(24)}
      background={{
        type: "gradient",
        top: { r: 0.08, g: 0.12, b: 0.2, a: 0.95 },
        bottom: { r: 0.05, g: 0.08, b: 0.15, a: 0.95 },
      }}
      borderRadius={16}
      borderWidth={2}
      borderColor={{ r: 0.2, g: 0.35, b: 0.6, a: 0.6 }}
      draggable={true}
    >
      <box direction="row" gap={12} align="center">
        <icon svg={ICON_DRAG} size={24} tint={{ r: 0.4, g: 0.6, b: 1, a: 0.7 }} />
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
          iconSvg={ICON_STAR}
          onClick={() => console.log("[CanvasUI] World button clicked")}
        />
        <Button
          label="Another"
          background={BG_GREEN}
          iconSvg={ICON_HEART}
          onClick={() => console.log("[CanvasUI] Another clicked")}
        />
      </box>
    </box>
  );
}
