/** @jsxImportSource ./jsx */
import type {
  UIElement,
  UIColorValue,
  UIBackground,
  UIEventHandler,
  StateStyle,
  ReactIconComponent,
} from "./elements.ts";
import { edges, gradient, lightDark, memo, solid, spring } from "./elements.ts";
import {
  Check,
  Xmark,
  Star,
  Heart,
  Settings,
  Drag,
  Palette,
  MoreVert,
  Copy,
  Download,
  InfoCircle,
  WarningCircle,
  NavArrowRight,
  Eye,
  DropletHalf,
  Undo,
  Redo,
  FloppyDiskArrowIn,
  Import,
  QuestionMark,
  MediaImagePlus,
  Trash,
} from "iconoir-react";

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
  stacked?: boolean;
  valueMaxWidth?: number;
};

type SpecimenCardProps = Record<string, unknown> & {
  title: string;
  background: UIBackground;
  color: UIColorValue;
};

export interface DebugOverlayStats {
  fps: number;
  renderMedianMs: number;
  renderP95Ms: number;
  entityCount: number;
  renderedCount: number;
  sampleCount: number;
}

type DebugOverlayProps = Record<string, unknown> & {
  zoom: number;
  perf: DebugOverlayStats;
};

type ButtonSpec = {
  label: string;
  icon?: ReactIconComponent;
  background?: UIBackground;
  color?: UIColorValue;
};

type MenuItemSpec = {
  label: string;
  hint: string;
  icon: ReactIconComponent;
  destructive?: boolean;
  selected?: boolean;
  hasChild?: boolean;
};

const WHITE: UIColorValue = "#ffffff";
const BLACK: UIColorValue = "#101218";
const MUTED: UIColorValue = lightDark("#5f6777", "#9aa4b5");
const PANEL_TEXT: UIColorValue = lightDark("#151924", "#f5f7fb");
const PANEL_BORDER: UIColorValue = lightDark("rgba(20, 26, 38, 0.12)", "rgba(255, 255, 255, 0.12)");
const DIVIDER: UIColorValue = lightDark("rgba(16, 22, 34, 0.12)", "rgba(255, 255, 255, 0.08)");
const PANEL_BG = solid(lightDark("rgba(248, 249, 252, 0.94)", "rgba(16, 18, 24, 0.94)"));
const CARD_BG = solid(lightDark("rgba(255, 255, 255, 0.78)", "rgba(29, 33, 43, 0.82)"));
const WINDOW_BG = solid(lightDark("rgba(247, 248, 252, 0.96)", "rgba(20, 22, 30, 0.96)"));
const WINDOW_ALT_BG = solid(lightDark("rgba(255, 255, 255, 0.9)", "rgba(24, 27, 37, 0.9)"));
const PRIMARY_BG = gradient("var(--tint-900)", "var(--tint-1100)");
const SUCCESS_BG = gradient("#66cf9a", "#2fa46d");
const DANGER_BG = solid("#e7565f");
const ACCENT_BG = gradient("#a26dff", "#7747e8");
const SUNSET_BG = gradient("#ffb36b", "#ff6f61");
const SKY_BG = gradient("#7ec8ff", "#4b7bff");
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
const SWATCH_SETS = [
  ["#101218", "#30406e", "#4b7bff", "#83c6ff", "#f5f7fb"],
  ["#120c18", "#473063", "#8e56ff", "#d58fff", "#fff1ff"],
  ["#17110d", "#7f4f24", "#d89b5c", "#ffd6a5", "#fff5e6"],
];
const ACTION_ROWS: ButtonSpec[][] = [
  [
    { label: "Import", icon: Import, background: PRIMARY_BG },
    { label: "Snapshot", icon: Download, background: SKY_BG },
    { label: "Save", icon: FloppyDiskArrowIn, background: SUCCESS_BG },
  ],
  [
    { label: "Duplicate", icon: Copy, background: ACCENT_BG },
    { label: "Inject", icon: MediaImagePlus, background: SUNSET_BG },
    { label: "Inspect", icon: InfoCircle, background: OUTLINE_BG, color: "var(--tint-1000)" },
  ],
  [
    { label: "Undo", icon: Undo, background: CARD_BG, color: PANEL_TEXT },
    { label: "Redo", icon: Redo, background: CARD_BG, color: PANEL_TEXT },
    { label: "Delete", icon: Trash, background: DANGER_BG },
  ],
];
const MENU_ITEMS: MenuItemSpec[] = [
  { label: "Pin metrics window", hint: "P", icon: Check, selected: true },
  { label: "Duplicate render deck", hint: "D", icon: Copy },
  { label: "Open submenu", hint: "", icon: NavArrowRight, hasChild: true },
  { label: "Capture frame atlas", hint: "S", icon: Download },
  { label: "Discard stack", hint: "Del", icon: Trash, destructive: true },
];
const STATUS_BADGES = [
  { label: "Retained", background: PRIMARY_BG },
  { label: "TSX", background: SUCCESS_BG },
  { label: "WebGPU", background: ACCENT_BG },
  { label: "World", background: SKY_BG },
  { label: "Drag", background: solid("#f0bf47"), color: BLACK },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatMs(value: number): string {
  return value > 0 ? `${value.toFixed(1)} ms` : "warming";
}

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

function SectionEyebrow({ label }: { label: string }): UIElement {
  return (
    <text fontSize={10} color={MUTED}>
      {label}
    </text>
  );
}

function StatRow({ label, value, stacked = false, valueMaxWidth }: StatRowProps): UIElement {
  if (stacked) {
    return (
      <box direction="col" gap={2}>
        <text fontSize={10} color={MUTED}>
          {label}
        </text>
        <text fontSize={11} color={PANEL_TEXT} maxWidth={valueMaxWidth}>
          {value}
        </text>
      </box>
    );
  }

  return (
    <box direction="row" gap={8} align="center" justifyContent="space-between">
      <text fontSize={11} color={MUTED}>
        {label}
      </text>
      <text fontSize={11} color={PANEL_TEXT} maxWidth={valueMaxWidth}>
        {value}
      </text>
    </box>
  );
}

function MiniStat({
  label,
  value,
  background = CARD_BG,
}: {
  label: string;
  value: string;
  background?: UIBackground;
}): UIElement {
  return (
    <box
      direction="col"
      gap={4}
      padding={edges(10)}
      minWidth={104}
      background={background}
      borderRadius={8}
      borderWidth={1}
      borderColor={PANEL_BORDER}
      flexGrow={1}
    >
      <text fontSize={10} color={MUTED}>
        {label}
      </text>
      <text fontSize={16} color={PANEL_TEXT}>
        {value}
      </text>
    </box>
  );
}

function MeterRow({
  label,
  value,
  max,
  formatted,
  fill,
}: {
  label: string;
  value: number;
  max: number;
  formatted: string;
  fill: UIBackground;
}): UIElement {
  const fillWidth = clamp((value / max) * 180, 12, 180);

  return (
    <box direction="col" gap={6}>
      <box direction="row" justifyContent="space-between" align="center">
        <text fontSize={10} color={MUTED}>
          {label}
        </text>
        <text fontSize={10} color={PANEL_TEXT}>
          {formatted}
        </text>
      </box>
      <box
        width={180}
        height={10}
        padding={2}
        background={solid(lightDark("rgba(18, 22, 32, 0.08)", "rgba(255, 255, 255, 0.08)"))}
        borderRadius={999}
      >
        <box width={fillWidth} height={6} background={fill} borderRadius={999} />
      </box>
    </box>
  );
}

function SwatchStrip({ title, colors }: { title: string; colors: string[] }): UIElement {
  return (
    <box direction="col" gap={6}>
      <text fontSize={10} color={MUTED}>
        {title}
      </text>
      <box direction="row" gap={6}>
        {colors.map((color, index) => (
          <box
            key={`${title}-${index}`}
            width={24}
            height={24}
            background={solid(color)}
            borderRadius={6}
            borderWidth={1}
            borderColor={PANEL_BORDER}
          />
        ))}
      </box>
    </box>
  );
}

function PanelChrome({
  title,
  subtitle,
  icon,
  width,
  minWidth,
  background = WINDOW_BG,
  borderColor = PANEL_BORDER,
  draggable = true,
  children,
}: Record<string, unknown> & {
  title: string;
  subtitle?: string;
  icon: ReactIconComponent;
  width?: number;
  minWidth?: number;
  background?: UIBackground;
  borderColor?: UIColorValue;
  draggable?: boolean;
  children: UIElement;
}): UIElement {
  const titleContent: UIElement[] = [
    <text key="title" fontSize={14} color={PANEL_TEXT}>
      {title}
    </text>,
  ];
  if (subtitle) {
    titleContent.push(
      <text key="subtitle" fontSize={10} color={MUTED}>
        {subtitle}
      </text>,
    );
  }

  return (
    <box
      direction="col"
      gap={12}
      padding={edges(14)}
      width={width}
      minWidth={minWidth}
      background={background}
      borderRadius={14}
      borderWidth={1}
      borderColor={borderColor}
      draggable={draggable}
    >
      <box direction="row" justifyContent="space-between" align="center">
        <box direction="row" gap={10} align="center">
          <icon icon={icon} size={16} tint="var(--tint-1000)" />
          <box direction="col" gap={2}>
            {titleContent}
          </box>
        </box>
      </box>
      {children}
    </box>
  );
}

const ActionMatrix = memo(function ActionMatrix(): UIElement {
  return (
    <PanelChrome
      title="Action Matrix"
      subtitle="Dense control surface"
      icon={Palette}
      width={352}
      background={WINDOW_ALT_BG}
    >
      <box direction="col" gap={8}>
        <box direction="col" gap={8}>
          {ACTION_ROWS.map((row, rowIndex) => (
            <box key={`action-row-${rowIndex}`} direction="row" gap={8} align="center">
              {row.map((item) => (
                <Button
                  key={item.label}
                  label={item.label}
                  icon={item.icon}
                  background={item.background}
                  color={item.color}
                  onClick={() => console.log(`[CanvasUI] ${item.label} clicked`)}
                />
              ))}
            </box>
          ))}
        </box>

        <box direction="row" gap={8}>
          <box direction="col" gap={8} flexGrow={1}>
            <SwatchStrip title="Diffusion strip" colors={SWATCH_SETS[0]!} />
            <SwatchStrip title="Neon strip" colors={SWATCH_SETS[1]!} />
          </box>
          <box direction="col" gap={8} flexGrow={1}>
            <SwatchStrip title="Warm strip" colors={SWATCH_SETS[2]!} />
            <box
              direction="col"
              gap={6}
              padding={edges(10)}
              background={CARD_BG}
              borderRadius={10}
              borderWidth={1}
              borderColor={PANEL_BORDER}
            >
              <SectionEyebrow label="Engine flags" />
              <StatRow label="Event routing" value="UI first" />
              <StatRow label="Drag mode" value="retained node" />
              <StatRow label="Layout" value="row + col + abs" />
            </box>
          </box>
        </box>
      </box>
    </PanelChrome>
  );
});

function MenuItem({ item }: { item: MenuItemSpec }): UIElement {
  const textColor = item.destructive ? "#ff9a9f" : PANEL_TEXT;
  const trailingContent: UIElement[] = [];

  if (item.hint) {
    trailingContent.push(
      <text key="hint" fontSize={10} color={item.selected ? "rgba(255,255,255,0.72)" : MUTED}>
        {item.hint}
      </text>,
    );
  }
  if (item.hasChild) {
    trailingContent.push(<icon key="child" icon={NavArrowRight} size={12} tint={MUTED} />);
  }

  return (
    <box
      direction="row"
      justifyContent="space-between"
      align="center"
      padding={edges(8, 10)}
      minWidth={208}
      background={item.selected ? PRIMARY_BG : OUTLINE_BG}
      borderRadius={10}
      hover={{ background: CARD_BG, scale: 1.01 }}
      active={ACTIVE_STYLE}
      transition={SPRING_SCALE}
      onClick={() => console.log(`[CanvasUI] Menu item clicked: ${item.label}`)}
    >
      <box direction="row" gap={8} align="center">
        <icon
          icon={item.icon}
          size={14}
          tint={item.selected ? WHITE : item.destructive ? "#ff9a9f" : "var(--tint-1000)"}
        />
        <text fontSize={11} color={item.selected ? WHITE : textColor}>
          {item.label}
        </text>
      </box>

      <box direction="row" gap={8} align="center">
        {trailingContent}
      </box>
    </box>
  );
}

const FloatingContextMenu = memo(function FloatingContextMenu(): UIElement {
  return (
    <PanelChrome
      title="Context Stack"
      subtitle="Menu-like overlay in world space"
      icon={QuestionMark}
      width={244}
      background={solid(lightDark("rgba(255,255,255,0.95)", "rgba(18, 20, 26, 0.95)"))}
      borderColor={lightDark("rgba(41, 65, 115, 0.18)", "rgba(139, 170, 255, 0.28)")}
    >
      <box direction="col" gap={4}>
        {MENU_ITEMS.map((item) => (
          <box key={item.label}>
            <MenuItem item={item} />
          </box>
        ))}
      </box>
    </PanelChrome>
  );
});

const WindowStack = memo(function WindowStack(): UIElement {
  return (
    <box width={420} height={540}>
      <box position="absolute" left={0} top={28} zIndex={10}>
        <PanelChrome
          title="Signal Deck"
          subtitle="Overlapping windows"
          icon={InfoCircle}
          width={246}
          background={WINDOW_ALT_BG}
        >
          <box direction="col" gap={8}>
            <StatRow label="Textures" value="pooled" />
            <StatRow label="Icons" value="cached" />
            <StatRow label="Glyphs" value="SDF atlas" />
            <box direction="row" gap={6}>
              <Badge label="hover" background={SKY_BG} />
              <Badge label="active" background={SUCCESS_BG} />
              <Badge label="drag" background={SUNSET_BG} />
            </box>
          </box>
        </PanelChrome>
      </box>

      <box position="absolute" left={124} top={0} zIndex={20}>
        <PanelChrome
          title="Prompt Rail"
          subtitle="Panel chrome + nested stacks"
          icon={Settings}
          width={286}
          background={WORLD_PANEL_BG}
          borderColor={WORLD_PANEL_BORDER}
        >
          <box direction="col" gap={8}>
            <box
              direction="row"
              gap={8}
              padding={edges(10)}
              background={solid(lightDark("rgba(255,255,255,0.76)", "rgba(7, 12, 24, 0.42)"))}
              borderRadius={10}
            >
              <icon icon={WarningCircle} size={16} tint="#ff9f5a" />
              <text fontSize={11} color={PANEL_TEXT} maxWidth={228}>
                Push layout until it stops being polite.
              </text>
            </box>
            <box direction="row" gap={8}>
              <MiniStat label="Mode" value="world" background={CARD_BG} />
              <MiniStat label="Chrome" value="stacked" background={CARD_BG} />
            </box>
            <box direction="row" gap={8}>
              <Button
                label="Open"
                icon={Check}
                background={PRIMARY_BG}
                onClick={() => console.log("[CanvasUI] Prompt rail open")}
              />
              <Button
                label="Queue"
                icon={Download}
                background={SKY_BG}
                onClick={() => console.log("[CanvasUI] Prompt rail queue")}
              />
            </box>
          </box>
        </PanelChrome>
      </box>

      <box position="absolute" left={36} top={250} zIndex={30}>
        <FloatingContextMenu />
      </box>
    </box>
  );
});

const SpecimenCard = memo(function SpecimenCard({
  title,
  background,
  color,
}: SpecimenCardProps): UIElement {
  const content: UIElement[] = [
    <box key="floating-tag" position="absolute" right={12} top={12} zIndex={10}>
      <Badge label="Specimen" background={ACCENT_BG} />
    </box>,
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

  content.push(
    <box key="specimen-footer" direction="row" gap={6} align="center">
      <Badge
        label="Grid-fit"
        background={solid(lightDark("rgba(17, 24, 39, 0.84)", "rgba(255, 255, 255, 0.16)"))}
        color={lightDark("#ffffff", "#101218")}
      />
      <Badge label="No DOM" background={SKY_BG} />
      <Badge label="Zoom-linked" background={SUCCESS_BG} />
    </box>,
  );

  return (
    <box
      direction="col"
      gap={8}
      padding={edges(14)}
      background={background}
      borderRadius={4}
      borderWidth={2}
      borderColor={PANEL_BORDER}
      minWidth={468}
      draggable
    >
      {content}
    </box>
  );
});

function DebugPanel({ zoom, perf }: DebugOverlayProps): UIElement {
  const zoomLabel = `${Math.round(zoom * 100)}%`;
  const frameCountLabel = perf.sampleCount > 0 ? `${perf.sampleCount}/300` : "warming";
  const fpsValue = perf.fps > 0 ? `${perf.fps}` : "warming";
  const entityLabel = perf.entityCount > 0 ? `${perf.renderedCount}/${perf.entityCount}` : "0/0";

  return (
    <PanelChrome
      title="UI Engine Stress Test"
      subtitle="Live perf and layout pressure in world space"
      icon={Settings}
      width={352}
      background={PANEL_BG}
    >
      <box direction="col" gap={12}>
        <box direction="row" gap={8}>
          <MiniStat label="FPS" value={fpsValue} background={PRIMARY_BG} />
          <MiniStat label="Median" value={formatMs(perf.renderMedianMs)} />
          <MiniStat label="P95" value={formatMs(perf.renderP95Ms)} background={SUNSET_BG} />
        </box>

        <box direction="row" gap={8}>
          <MiniStat label="Zoom" value={zoomLabel} />
          <MiniStat label="Entities" value={entityLabel} />
          <MiniStat label="Ring" value={frameCountLabel} />
        </box>

        <box background={solid(DIVIDER)} height={1} />

        <box direction="col" gap={10}>
          <SectionEyebrow label="Frame metrics" />
          <MeterRow
            label="Frame cadence"
            value={perf.fps}
            max={120}
            formatted={perf.fps > 0 ? `${perf.fps} fps` : "warming"}
            fill={PRIMARY_BG}
          />
          <MeterRow
            label="Median submit"
            value={perf.renderMedianMs}
            max={24}
            formatted={formatMs(perf.renderMedianMs)}
            fill={SUCCESS_BG}
          />
          <MeterRow
            label="Tail latency"
            value={perf.renderP95Ms}
            max={32}
            formatted={formatMs(perf.renderP95Ms)}
            fill={SUNSET_BG}
          />
        </box>

        <box direction="row" gap={8}>
          <box
            direction="col"
            gap={6}
            padding={edges(10)}
            background={CARD_BG}
            borderRadius={10}
            borderWidth={1}
            borderColor={PANEL_BORDER}
            flexGrow={1}
            flexShrink={1}
          >
            <box direction="row" gap={6} align="center">
              <icon icon={Heart} size={14} tint="#e7565f" />
              <text fontSize={13} color={PANEL_TEXT}>
                Frame HUD
              </text>
            </box>
            <StatRow label="Placement" value="inside panel" stacked valueMaxWidth={140} />
            <StatRow label="Anchor" value="world-space" stacked valueMaxWidth={140} />
            <StatRow label="Events" value="hover + active + drag" stacked valueMaxWidth={140} />
          </box>

          <box
            direction="col"
            gap={6}
            padding={edges(10)}
            background={CARD_BG}
            borderRadius={10}
            borderWidth={1}
            borderColor={PANEL_BORDER}
            flexGrow={1}
            flexShrink={1}
          >
            <box direction="row" gap={6} align="center">
              <icon icon={Eye} size={14} tint="var(--tint-1000)" />
              <text fontSize={13} color={PANEL_TEXT}>
                Layout probes
              </text>
            </box>
            <StatRow label="Stacking" value="z-index" stacked valueMaxWidth={140} />
            <StatRow label="Windows" value="overlap" stacked valueMaxWidth={140} />
            <StatRow label="Menu" value="mocked" stacked valueMaxWidth={140} />
          </box>
        </box>

        <box direction="row" gap={4} align="center">
          {STATUS_BADGES.map((badge) => (
            <Badge
              key={badge.label}
              label={badge.label}
              background={badge.background}
              color={badge.color}
            />
          ))}
        </box>

        <box direction="row" gap={6} align="center">
          <Button
            label="Primary"
            background={PRIMARY_BG}
            icon={Check}
            onClick={() => console.log("[CanvasUI] Primary clicked")}
          />
          <Button
            label="Danger"
            background={DANGER_BG}
            color={WHITE}
            icon={Xmark}
            onClick={() => console.log("[CanvasUI] Danger clicked")}
          />
          <Button
            label="Questions"
            background={OUTLINE_BG}
            color="var(--tint-1000)"
            icon={QuestionMark}
            onClick={() => console.log("[CanvasUI] Questions clicked")}
          />
        </box>

        <box direction="row" gap={4} align="center" justifyContent="center">
          <text fontSize={9} color={MUTED}>
            No fixed DOM overlay · live perf snapshot · retained scene graph
          </text>
        </box>
      </box>
    </PanelChrome>
  );
}

const WorldSpacePanel = memo(function WorldSpacePanel(): UIElement {
  return (
    <PanelChrome
      title="World-Space District"
      subtitle="Canvas-native windows, cards, and controls"
      icon={Drag}
      width={468}
      background={WORLD_PANEL_BG}
      borderColor={WORLD_PANEL_BORDER}
    >
      <box direction="col" gap={12}>
        <box position="absolute" right={14} top={14} zIndex={40}>
          <Badge label="Drag me" background={SKY_BG} />
        </box>

        <box
          direction="col"
          gap={8}
          padding={edges(12)}
          background={solid(lightDark("rgba(255,255,255,0.78)", "rgba(7, 12, 24, 0.42)"))}
          borderRadius={12}
          borderWidth={1}
          borderColor={WORLD_PANEL_BORDER}
        >
          <SectionEyebrow label="Canvas behavior" />
          <text fontSize={18} color={PANEL_TEXT} maxWidth={408}>
            Zoom to scale the whole district. Drag any card to see retained positions stick.
          </text>
        </box>

        <box
          direction="col"
          gap={8}
          padding={edges(12)}
          background={CARD_BG}
          borderRadius={12}
          borderWidth={1}
          borderColor={WORLD_PANEL_BORDER}
        >
          <SectionEyebrow label="Signals" />
          <box direction="row" gap={6}>
            <Badge label="layout" background={PRIMARY_BG} />
            <Badge label="paint" background={SUCCESS_BG} />
          </box>
          <box direction="row" gap={6}>
            <Badge label="hit-test" background={ACCENT_BG} />
            <Badge label="stack" background={SUNSET_BG} />
          </box>
        </box>

        <box direction="row" gap={8}>
          <MiniStat label="Docks" value="3" background={CARD_BG} />
          <MiniStat label="Windows" value="5" background={CARD_BG} />
          <MiniStat label="Menus" value="1 mock" background={CARD_BG} />
        </box>

        <box direction="row" gap={8} align="center">
          <Button
            label="Spawn"
            background={PRIMARY_BG}
            icon={Star}
            onClick={() => console.log("[CanvasUI] Spawn clicked")}
          />
          <Button
            label="Palette"
            background={SUCCESS_BG}
            icon={Palette}
            onClick={() => console.log("[CanvasUI] Palette clicked")}
          />
          <Button
            label="Shades"
            background={SKY_BG}
            icon={DropletHalf}
            onClick={() => console.log("[CanvasUI] Shades clicked")}
          />
          <Button
            label="Inspect"
            background={OUTLINE_BG}
            color="var(--tint-1000)"
            icon={InfoCircle}
            onClick={() => console.log("[CanvasUI] Inspect clicked")}
          />
        </box>
      </box>
    </PanelChrome>
  );
});

function DebugOverlay({ zoom, perf }: DebugOverlayProps): UIElement {
  return (
    <box key="debug-root" direction="row" gap={18} align="start">
      <box direction="col" gap={14}>
        <DebugPanel zoom={zoom} perf={perf} />
        <ActionMatrix />
      </box>

      <box direction="col" gap={12}>
        <WorldSpacePanel />
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
        <SpecimenCard
          title="Font Specimen · Electric Accent"
          background={gradient("#120a20", "#27113f")}
          color="#f6f1ff"
        />
      </box>

      <WindowStack />

      <box position="absolute" left={412} top={-52} zIndex={60}>
        <Badge label="Canvas-native overlay city" background={SUNSET_BG} />
      </box>

      <box position="absolute" left={1108} top={116} zIndex={80}>
        <FloatingContextMenu />
      </box>
      <box position="absolute" left={1132} top={152} zIndex={79}>
        <box
          direction="row"
          gap={8}
          padding={edges(10)}
          background={solid(lightDark("rgba(255,255,255,0.94)", "rgba(10, 14, 20, 0.94)"))}
          borderRadius={12}
          borderWidth={1}
          borderColor={PANEL_BORDER}
          draggable
        >
          <icon icon={WarningCircle} size={14} tint="#ff9f5a" />
          <text fontSize={11} color={PANEL_TEXT}>
            Faux nested submenu
          </text>
        </box>
      </box>
    </box>
  );
}

export function buildDebugUI({ zoom, perf }: DebugOverlayProps): UIElement {
  return <DebugPanel zoom={zoom} perf={perf} />;
}

export function buildDebugOverlay(props: DebugOverlayProps): UIElement {
  return <DebugOverlay {...props} />;
}
