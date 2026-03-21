/** @jsxImportSource ./jsx */
import type {
  UIElement,
  UIColorValue,
  UIBackground,
  UIEventHandler,
  StateStyle,
  ReactIconComponent,
} from "./elements.ts";
import { edges, gradient, lightDark, solid, spring } from "./elements.ts";
import { Check, Xmark, Star, Heart, Settings, Drag } from "iconoir-react";

type ButtonProps = Record<string, unknown> & {
  label?: string;
  background?: UIBackground;
  color?: UIColorValue;
  icon?: ReactIconComponent;
  onClick?: UIEventHandler;
};

type BadgeProps = Record<string, unknown> & {
  label: string;
  background?: UIBackground;
  color?: UIColorValue;
};

type StatRowProps = Record<string, unknown> & {
  label: string;
  value: string;
};

type SpecimenCardProps = Record<string, unknown> & {
  title: string;
  background: UIBackground;
  color: UIColorValue;
};

type ZoomProps = Record<string, unknown> & {
  zoom: number;
};

const WHITE: UIColorValue = "#ffffff";
const BLACK: UIColorValue = "#101218";
const MUTED: UIColorValue = lightDark("#5f6777", "#9aa4b5");
const PANEL_TEXT: UIColorValue = lightDark("#151924", "#f5f7fb");
const PANEL_BORDER: UIColorValue = lightDark("rgba(20, 26, 38, 0.12)", "rgba(255, 255, 255, 0.12)");
const DIVIDER: UIColorValue = lightDark("rgba(16, 22, 34, 0.12)", "rgba(255, 255, 255, 0.08)");
const PANEL_BG = solid(lightDark("rgba(248, 249, 252, 0.94)", "rgba(16, 18, 24, 0.94)"));
const CARD_BG = solid(lightDark("rgba(255, 255, 255, 0.78)", "rgba(29, 33, 43, 0.82)"));
const PRIMARY_BG = gradient("var(--tint-900)", "var(--tint-1100)");
const SUCCESS_BG = gradient("#66cf9a", "#2fa46d");
const DANGER_BG = solid("#e7565f");
const ACCENT_BG = gradient("#a26dff", "#7747e8");
const OUTLINE_BG = solid("rgba(0, 0, 0, 0)");
const WORLD_PANEL_BG = lightDark(gradient("#dfeaff", "#c4d7ff"), gradient("#13233f", "#0b1326"));
const WORLD_PANEL_BORDER = lightDark("rgba(72, 103, 168, 0.28)", "rgba(97, 136, 224, 0.45)");
const HOVER_STYLE: StateStyle = { opacity: 0.96, scale: 1.02 };
const ACTIVE_STYLE: StateStyle = { scale: 0.96 };
const SPRING_SCALE = { scale: spring(0.24) };

const TARGET_GLYPHS = "W A V Z / v w";
const STRESS_GLYPHS = "WWW AAA VVV ZZZ /// vvv www";
const SPECIMEN_ROWS = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
];

function Button(props: ButtonProps): UIElement {
  const { label, background, color, icon: iconProp, onClick } = props;
  const bg = background ?? PRIMARY_BG;
  const textColor = color ?? WHITE;
  const content: UIElement[] = [];

  if (iconProp) {
    content.push(<icon icon={iconProp} size={14} tint={textColor} />);
  }
  if (label) {
    content.push(
      <text fontSize={12} color={textColor}>
        {label}
      </text>,
    );
  }

  return (
    <box
      direction="row"
      gap={6}
      padding={edges(6, 12)}
      background={bg}
      borderRadius={6}
      align="center"
      hover={HOVER_STYLE}
      active={ACTIVE_STYLE}
      transition={SPRING_SCALE}
      onClick={onClick}
    >
      {content}
    </box>
  );
}

function Badge({ label, background, color }: BadgeProps): UIElement {
  return (
    <box
      padding={edges(3, 8)}
      background={background ?? ACCENT_BG}
      borderRadius={10}
      hover={HOVER_STYLE}
      active={ACTIVE_STYLE}
      transition={SPRING_SCALE}
    >
      <text fontSize={10} color={color ?? WHITE}>
        {label}
      </text>
    </box>
  );
}

function StatRow({ label, value }: StatRowProps): UIElement {
  return (
    <box direction="row" gap={8} align="center" justifyContent="space-between" minWidth={160}>
      <text fontSize={11} color={MUTED}>
        {label}
      </text>
      <text fontSize={11} color={PANEL_TEXT}>
        {value}
      </text>
    </box>
  );
}

function SpecimenCard({ title, background, color }: SpecimenCardProps): UIElement {
  const content: UIElement[] = [
    <text key="title" fontSize={15} color={color}>
      {title}
    </text>,
    <text key="targets" fontSize={28} color={color}>
      {TARGET_GLYPHS}
    </text>,
    <text key="stress" fontSize={20} color={color}>
      {STRESS_GLYPHS}
    </text>,
  ];

  for (const [index, row] of SPECIMEN_ROWS.entries()) {
    content.push(
      <text key={`specimen-row-${index}`} fontSize={18} color={color}>
        {row}
      </text>,
    );
  }

  return (
    <box
      direction="col"
      gap={8}
      padding={edges(14)}
      background={background}
      borderRadius={4}
      borderWidth={2}
      borderColor={PANEL_BORDER}
      minWidth={540}
    >
      {content}
    </box>
  );
}

function DebugPanel({ zoom }: ZoomProps): UIElement {
  return (
    <box
      direction="col"
      gap={12}
      padding={edges(16)}
      background={PANEL_BG}
      borderRadius={12}
      minWidth={240}
      borderWidth={1}
      borderColor={PANEL_BORDER}
    >
      <box direction="row" gap={8} align="center">
        <icon icon={Settings} size={18} tint="var(--tint-1000)" />
        <text fontSize={16} color={PANEL_TEXT}>
          UI Engine Stress Test
        </text>
      </box>

      <box background={solid(DIVIDER)} height={1} />

      <box direction="row" gap={6} align="center">
        <Button
          label="Primary"
          background={PRIMARY_BG}
          icon={Check}
          onClick={() => console.log("[CanvasUI] Primary clicked")}
        />
        <Button
          label="Success"
          background={SUCCESS_BG}
          icon={Check}
          onClick={() => console.log("[CanvasUI] Success clicked")}
        />
        <Button
          label="Danger"
          background={DANGER_BG}
          color={WHITE}
          icon={Xmark}
          onClick={() => console.log("[CanvasUI] Danger clicked")}
        />
      </box>

      <box direction="row" gap={6} align="center">
        <Button
          label="Purple"
          background={ACCENT_BG}
          icon={Star}
          onClick={() => console.log("[CanvasUI] Purple clicked")}
        />
        <Button
          label="Outlined"
          background={OUTLINE_BG}
          color="var(--tint-1000)"
          onClick={() => console.log("[CanvasUI] Outlined clicked")}
        />
      </box>

      <box direction="col" gap={6} padding={edges(10)} background={CARD_BG} borderRadius={8}>
        <box direction="row" gap={6} align="center">
          <icon icon={Heart} size={14} tint="#e7565f" />
          <text fontSize={13} color={PANEL_TEXT}>
            Statistics
          </text>
        </box>
        <StatRow label="Zoom" value={`${Math.round(zoom * 100)}%`} />
        <StatRow label="Size Mode" value="Screen-space" />
        <StatRow label="Events" value="hover + active" />
      </box>

      <box direction="row" gap={4} align="center">
        <Badge label="Retained" background={PRIMARY_BG} />
        <Badge label="TSX" background={SUCCESS_BG} />
        <Badge label="WebGPU" background={ACCENT_BG} />
        <Badge label="SDF" background={solid("#f0bf47")} color={BLACK} />
      </box>

      <box direction="row" gap={4} align="center" justifyContent="center">
        <text fontSize={9} color={MUTED}>
          Screen-space · Hover · Active · Click · Drag
        </text>
      </box>
    </box>
  );
}

function WorldSpacePanel(): UIElement {
  return (
    <box
      direction="col"
      gap={16}
      padding={edges(24)}
      background={WORLD_PANEL_BG}
      borderRadius={4}
      borderWidth={2}
      borderColor={WORLD_PANEL_BORDER}
      draggable
    >
      <box direction="row" gap={12} align="center">
        <icon icon={Drag} size={24} tint={lightDark("#4d72d4", "#79a2ff")} />
        <text fontSize={20} color={PANEL_TEXT}>
          World-Space UI
        </text>
      </box>

      <text fontSize={14} color={MUTED}>
        This element lives in world space.
      </text>
      <text fontSize={14} color={MUTED}>
        Zoom in/out to see it scale. Drag to move.
      </text>

      <box direction="row" gap={10} align="center">
        <Button
          label="World Button"
          background={PRIMARY_BG}
          icon={Star}
          onClick={() => console.log("[CanvasUI] World button clicked")}
        />
        <Button
          label="Another"
          background={SUCCESS_BG}
          icon={Heart}
          onClick={() => console.log("[CanvasUI] Another clicked")}
        />
      </box>
    </box>
  );
}

function DebugOverlay({ zoom }: ZoomProps): UIElement {
  return (
    <box key="debug-root">
      <box direction="row" gap={16} align="start">
        <WorldSpacePanel />

        <box direction="col" gap={12}>
          <SpecimenCard
            title="Font Specimen · White on Black"
            background={solid("#0a0b0e")}
            color={WHITE}
          />
          <SpecimenCard
            title="Font Specimen · Black on White"
            background={solid("#f6f4f1")}
            color={BLACK}
          />
        </box>
      </box>

      <box position="fixed" left={40} bottom={40} zIndex={100}>
        <DebugPanel zoom={zoom} />
      </box>
    </box>
  );
}

export function buildDebugUI(zoom: number): UIElement {
  return <DebugPanel zoom={zoom} />;
}

export function buildDebugOverlay(zoom: number): UIElement {
  return <DebugOverlay zoom={zoom} />;
}
