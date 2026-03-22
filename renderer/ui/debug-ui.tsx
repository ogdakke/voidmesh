import type {
  UIColorValue,
  UIBackground,
  UIEventHandler,
  StateStyle,
  ReactIconComponent,
} from "./elements.ts";
import { blur, edges, gradient, lightDark, solid, spring } from "./elements.ts";
import { Box, Text, Icon, Polyline } from "./primitives.tsx";
import { memo } from "react";
import {
  Check,
  Xmark,
  Star,
  Heart,
  Settings,
  Drag,
  Palette,
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

type ButtonProps = {
  label?: string;
  background?: UIBackground;
  color?: UIColorValue;
  borderColor?: UIColorValue;
  icon?: ReactIconComponent;
  onClick?: UIEventHandler;
};

type BadgeProps = {
  label: string;
  background?: UIBackground;
  color?: UIColorValue;
};

type StatRowProps = {
  label: string;
  value: string;
  stacked?: boolean;
  valueMaxWidth?: number;
};

type SpecimenCardProps = {
  title: string;
  background: UIBackground;
  color: UIColorValue;
};

export interface DebugOverlayStats {
  fps: number;
  fpsLow1: number;
  frameWorstMs: number;
  fpsHistory: number[];
  renderMedianMs: number;
  renderP95Ms: number;
  entityCount: number;
  renderedCount: number;
  sampleCount: number;
}

type DebugOverlayProps = {
  zoom: number;
  perf: DebugOverlayStats;
};

type ButtonSpec = {
  label: string;
  icon?: ReactIconComponent;
  background?: UIBackground;
  color?: UIColorValue;
  borderColor?: UIColorValue;
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
const SUBTLE_BACKDROP_BLUR = 4;
const MUTED: UIColorValue = lightDark("var(--gray-700)", "var(--gray-1300)");
const PANEL_TEXT: UIColorValue = lightDark("var(--gray-900)", "var(--gray-1500)");
const PANEL_TEXT_SOFT: UIColorValue = lightDark("var(--gray-800)", "var(--gray-1400)");
const PANEL_BORDER: UIColorValue = lightDark("rgba(20, 26, 38, 0.12)", "rgba(255, 255, 255, 0.16)");
const DIVIDER: UIColorValue = lightDark("rgba(16, 22, 34, 0.12)", "rgba(255, 255, 255, 0.12)");
const PANEL_BG = solid(
  lightDark(
    "rgba(255, 255, 255, 0.88)",
    "color-mix(in oklch, var(--gray-200) 34%, var(--floating-background))",
  ),
);
const CARD_BG = gradient(
  lightDark(
    "rgba(255, 255, 255, 0.82)",
    "color-mix(in oklch, var(--gray-200) 26%, var(--input-bg))",
  ),
  lightDark(
    "rgba(248, 249, 252, 0.94)",
    "color-mix(in oklch, var(--gray-100) 14%, var(--input-bg))",
  ),
);
const WINDOW_BG = gradient(
  lightDark(
    "rgba(255, 255, 255, 0.94)",
    "color-mix(in oklch, var(--gray-200) 40%, var(--floating-background))",
  ),
  lightDark(
    "rgba(247, 248, 252, 0.98)",
    "color-mix(in oklch, var(--gray-100) 20%, var(--floating-background))",
  ),
);
const WINDOW_ALT_BG = gradient(
  lightDark(
    "rgba(245, 249, 255, 0.96)",
    "color-mix(in oklch, var(--gray-200) 24%, color-mix(in oklch, var(--primary-25) 38%, var(--floating-background)))",
  ),
  lightDark(
    "rgba(255, 255, 255, 0.94)",
    "color-mix(in oklch, var(--gray-100) 16%, color-mix(in oklch, var(--primary-25) 20%, var(--floating-background)))",
  ),
);
const PRIMARY_BG = gradient("var(--primary-lighter)", "var(--primary)");
const SUCCESS_BG = gradient("var(--green-400)", "var(--green-700)");
const DANGER_BG = gradient("var(--destructive-lighter)", "var(--destructive)");
const ACCENT_BG = gradient("var(--amber-300)", "var(--amber-700)");
const SUNSET_BG = gradient("var(--amber-400)", "var(--amber-800)");
const SKY_BG = gradient("var(--gray-200)", "var(--gray-500)");
const OUTLINE_BG = gradient("var(--background)", "var(--input-bg)");
const SOFT_PRIMARY_BG = solid(
  lightDark(
    "color-mix(in oklch, var(--primary-25) 72%, white)",
    "color-mix(in oklch, var(--primary-25) 88%, rgba(255, 255, 255, 0.14))",
  ),
);
const SOFT_AMBER_BG = solid(
  lightDark(
    "color-mix(in oklch, var(--amber-100) 74%, white)",
    "color-mix(in oklch, var(--amber-100) 82%, rgba(255, 255, 255, 0.12))",
  ),
);
const SOFT_SUCCESS_BG = solid(
  lightDark(
    "color-mix(in oklch, var(--green-100) 72%, white)",
    "color-mix(in oklch, var(--green-100) 84%, rgba(255, 255, 255, 0.12))",
  ),
);
const WORLD_PANEL_BG = gradient(
  lightDark(
    "color-mix(in oklch, var(--primary-25) 82%, white)",
    "color-mix(in oklch, var(--primary-25) 55%, rgba(12, 18, 32, 0.96))",
  ),
  lightDark(
    "color-mix(in oklch, var(--primary-25) 58%, var(--input-bg))",
    "color-mix(in oklch, var(--primary-25) 28%, rgba(9, 14, 26, 0.96))",
  ),
);
const WORLD_PANEL_BORDER: UIColorValue = lightDark(
  "rgba(72, 103, 168, 0.22)",
  "rgba(121, 154, 245, 0.42)",
);
const HOVER_STYLE: StateStyle = { opacity: 0.96, scale: 1.02 };
const ACTIVE_STYLE: StateStyle = { scale: 0.96 };
const SPRING_SCALE = { scale: spring(0.24) };
const HUD_BG = solid(
  lightDark(
    "rgba(255, 255, 255, 0.82)",
    "color-mix(in oklch, var(--gray-200) 32%, var(--floating-background))",
  ),
);
const HUD_BORDER: UIColorValue = lightDark("rgba(20, 26, 38, 0.12)", "rgba(255, 255, 255, 0.16)");
const HUD_GRAPH_BG = solid(
  lightDark(
    "rgba(15, 23, 42, 0.05)",
    "color-mix(in oklch, var(--gray-200) 18%, rgba(8, 12, 20, 0.88))",
  ),
);
const HUD_GRAPH_GRID: UIColorValue = lightDark(
  "rgba(15, 23, 42, 0.08)",
  "rgba(255, 255, 255, 0.12)",
);
const HUD_VALUE: UIColorValue = lightDark("var(--gray-900)", "var(--gray-1500)");
const HUD_LABEL: UIColorValue = lightDark("var(--gray-700)", "var(--gray-1300)");
const HUD_GRAPH_LINE: UIColorValue = "var(--primary)";

const TARGET_GLYPHS = "W A V Z / v w";
const STRESS_GLYPHS = "WWW AAA VVV ZZZ /// vvv www";
const SPECIMEN_ROWS = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
];
const SWATCH_SETS = [
  ["var(--gray-1600)", "var(--gray-1100)", "var(--primary)", "var(--green-600)", "var(--gray-50)"],
  ["var(--gray-1500)", "var(--primary-50)", "var(--primary)", "var(--amber-500)", "var(--gray-50)"],
  [
    "var(--gray-1400)",
    "var(--destructive-50)",
    "var(--amber)",
    "var(--green-500)",
    "var(--gray-50)",
  ],
];
const ACTION_ROWS: ButtonSpec[][] = [
  [
    { label: "Import", icon: Import, background: PRIMARY_BG, borderColor: "var(--primary)" },
    {
      label: "Snapshot",
      icon: Download,
      background: SKY_BG,
      color: PANEL_TEXT,
      borderColor: "var(--border)",
    },
    {
      label: "Save",
      icon: FloppyDiskArrowIn,
      background: SUCCESS_BG,
      borderColor: "var(--green-600)",
    },
  ],
  [
    {
      label: "Duplicate",
      icon: Copy,
      background: ACCENT_BG,
      color: BLACK,
      borderColor: "var(--amber-500)",
    },
    {
      label: "Inject",
      icon: MediaImagePlus,
      background: SUNSET_BG,
      color: BLACK,
      borderColor: "var(--amber-700)",
    },
    {
      label: "Inspect",
      icon: InfoCircle,
      background: OUTLINE_BG,
      color: PANEL_TEXT,
      borderColor: "var(--border)",
    },
  ],
  [
    {
      label: "Undo",
      icon: Undo,
      background: OUTLINE_BG,
      color: PANEL_TEXT,
      borderColor: "var(--border)",
    },
    {
      label: "Redo",
      icon: Redo,
      background: OUTLINE_BG,
      color: PANEL_TEXT,
      borderColor: "var(--border)",
    },
    { label: "Delete", icon: Trash, background: DANGER_BG, borderColor: "var(--destructive-50)" },
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
  { label: "Retained", background: SOFT_PRIMARY_BG, color: PANEL_TEXT },
  { label: "TSX", background: SOFT_SUCCESS_BG, color: PANEL_TEXT },
  { label: "WebGPU", background: SOFT_AMBER_BG, color: PANEL_TEXT },
  { label: "World", background: SKY_BG, color: PANEL_TEXT },
  { label: "Drag", background: SOFT_AMBER_BG, color: PANEL_TEXT },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatMs(value: number): string {
  return value > 0 ? `${value.toFixed(1)} ms` : "warming";
}

function formatCompactMs(value: number): string {
  return value > 0 ? `${value.toFixed(1)}ms` : "--";
}

function formatCompactFps(value: number): string {
  return value > 0 ? `${Math.round(value)}` : "--";
}

function Button({ label, background, color, borderColor, icon: iconProp, onClick }: ButtonProps) {
  const bg = background ?? PRIMARY_BG;
  const textColor = color ?? WHITE;
  const stroke = borderColor ?? (bg === OUTLINE_BG ? "var(--border)" : "transparent");

  return (
    <Box
      direction="row"
      gap={6}
      padding={edges(6, 12)}
      background={bg}
      borderRadius={999}
      borderWidth={1}
      borderColor={stroke}
      align="center"
      hover={HOVER_STYLE}
      active={ACTIVE_STYLE}
      transition={SPRING_SCALE}
      onClick={onClick}
    >
      {iconProp && <Icon icon={iconProp} size={14} tint={textColor} />}
      {label && (
        <Text fontSize={12} color={textColor}>
          {label}
        </Text>
      )}
    </Box>
  );
}

function Badge({ label, background, color }: BadgeProps) {
  return (
    <Box
      padding={edges(3, 8)}
      background={background ?? ACCENT_BG}
      borderRadius={999}
      borderWidth={1}
      borderColor={lightDark("rgba(15, 23, 42, 0.06)", "rgba(255, 255, 255, 0.14)")}
      hover={HOVER_STYLE}
      active={ACTIVE_STYLE}
      transition={SPRING_SCALE}
    >
      <Text fontSize={10} color={color ?? WHITE}>
        {label}
      </Text>
    </Box>
  );
}

function SectionEyebrow({ label }: { label: string }) {
  return (
    <Text fontSize={11} color={MUTED}>
      {label}
    </Text>
  );
}

function StatRow({ label, value, stacked = false, valueMaxWidth }: StatRowProps) {
  if (stacked) {
    return (
      <Box direction="col" gap={2}>
        <Text fontSize={10} color={MUTED}>
          {label}
        </Text>
        <Text fontSize={12} color={PANEL_TEXT_SOFT} maxWidth={valueMaxWidth}>
          {value}
        </Text>
      </Box>
    );
  }

  return (
    <Box direction="row" gap={8} align="center" justifyContent="space-between">
      <Text fontSize={11} color={MUTED}>
        {label}
      </Text>
      <Text fontSize={11} color={PANEL_TEXT} maxWidth={valueMaxWidth}>
        {value}
      </Text>
    </Box>
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
}) {
  return (
    <Box
      direction="col"
      gap={6}
      padding={edges(12)}
      minWidth={104}
      background={background}
      borderRadius={12}
      borderWidth={1}
      borderColor={PANEL_BORDER}
      flexGrow={1}
    >
      <Text fontSize={11} color={MUTED}>
        {label}
      </Text>
      <Text fontSize={18} color={PANEL_TEXT}>
        {value}
      </Text>
    </Box>
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
}) {
  const fillWidth = clamp((value / max) * 180, 12, 180);

  return (
    <Box direction="col" gap={6}>
      <Box direction="row" justifyContent="space-between" align="center">
        <Text fontSize={10} color={MUTED}>
          {label}
        </Text>
        <Text fontSize={10} color={PANEL_TEXT}>
          {formatted}
        </Text>
      </Box>
      <Box
        width={180}
        height={12}
        padding={1}
        background={solid(lightDark("rgba(15, 23, 42, 0.06)", "rgba(255, 255, 255, 0.12)"))}
        borderRadius={999}
        borderWidth={1}
        borderColor={lightDark("rgba(15, 23, 42, 0.08)", "rgba(255, 255, 255, 0.14)")}
      >
        <Box width={fillWidth} height={8} background={fill} borderRadius={999} />
      </Box>
    </Box>
  );
}

function SwatchStrip({ title, colors }: { title: string; colors: string[] }) {
  return (
    <Box direction="col" gap={6}>
      <Text fontSize={10} color={MUTED}>
        {title}
      </Text>
      <Box direction="row" gap={6}>
        {colors.map((color, index) => (
          <Box
            key={`${title}-${index}`}
            width={24}
            height={24}
            background={solid(color)}
            borderRadius={6}
            borderWidth={1}
            borderColor={PANEL_BORDER}
          />
        ))}
      </Box>
    </Box>
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
  backdropBlur = SUBTLE_BACKDROP_BLUR,
  draggable = true,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: ReactIconComponent;
  width?: number;
  minWidth?: number;
  background?: UIBackground;
  borderColor?: UIColorValue;
  backdropBlur?: number;
  draggable?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box
      direction="col"
      gap={14}
      padding={edges(16)}
      width={width}
      minWidth={minWidth}
      background={background}
      backdropFilter={backdropBlur > 0 ? [blur(backdropBlur)] : undefined}
      borderRadius={18}
      borderWidth={1}
      borderColor={borderColor}
      draggable={draggable}
    >
      <Box direction="row" justifyContent="space-between" align="center">
        <Box direction="row" gap={10} align="center">
          <Icon icon={icon} size={16} tint={PANEL_TEXT} />
          <Box direction="col" gap={2}>
            <Text key="title" fontSize={15} color={PANEL_TEXT}>
              {title}
            </Text>
            {subtitle && (
              <Text key="subtitle" fontSize={11} color={MUTED}>
                {subtitle}
              </Text>
            )}
          </Box>
        </Box>
      </Box>
      {children}
    </Box>
  );
}

function ActionMatrix() {
  return (
    <PanelChrome
      title="Action Matrix"
      subtitle="Shared buttons, palettes, and chrome"
      icon={Palette}
      width={352}
      background={WINDOW_ALT_BG}
    >
      <Box direction="col" gap={10}>
        <Box direction="col" gap={10}>
          {ACTION_ROWS.map((row, rowIndex) => (
            <Box key={`action-row-${rowIndex}`} direction="row" gap={8} align="center">
              {row.map((item) => (
                <Button
                  key={item.label}
                  label={item.label}
                  icon={item.icon}
                  background={item.background}
                  color={item.color}
                  borderColor={item.borderColor}
                  onClick={() => console.log(`[CanvasUI] ${item.label} clicked`)}
                />
              ))}
            </Box>
          ))}
        </Box>

        <Box direction="row" gap={10}>
          <Box direction="col" gap={10} flexGrow={1}>
            <SwatchStrip title="Diffusion strip" colors={SWATCH_SETS[0]!} />
            <SwatchStrip title="Neon strip" colors={SWATCH_SETS[1]!} />
          </Box>
          <Box direction="col" gap={10} flexGrow={1}>
            <SwatchStrip title="Warm strip" colors={SWATCH_SETS[2]!} />
            <Box
              direction="col"
              gap={8}
              padding={edges(12)}
              background={SOFT_PRIMARY_BG}
              borderRadius={12}
              borderWidth={1}
              borderColor={PANEL_BORDER}
            >
              <SectionEyebrow label="Engine flags" />
              <StatRow label="Event routing" value="UI first" />
              <StatRow label="Drag mode" value="retained node" />
              <StatRow label="Layout" value="row + col + abs" />
            </Box>
          </Box>
        </Box>
      </Box>
    </PanelChrome>
  );
}

function MenuItem({ item }: { item: MenuItemSpec }) {
  const textColor = item.destructive ? "var(--destructive)" : PANEL_TEXT;
  const selectedText = "var(--gray-50)";
  const hoverBackground = item.destructive
    ? solid("var(--destructive-25)")
    : solid("var(--gray-100)");

  return (
    <Box
      direction="row"
      justifyContent="space-between"
      align="center"
      padding={edges(8, 10)}
      minWidth={208}
      background={item.selected ? solid("var(--gray-900)") : undefined}
      borderRadius={4}
      hover={{ background: hoverBackground, scale: 1.01 }}
      active={ACTIVE_STYLE}
      transition={SPRING_SCALE}
      onClick={() => console.log(`[CanvasUI] Menu item clicked: ${item.label}`)}
    >
      <Box direction="row" gap={8} align="center">
        <Icon icon={item.icon} size={14} tint={item.selected ? selectedText : textColor} />
        <Text fontSize={11} color={item.selected ? selectedText : textColor}>
          {item.label}
        </Text>
      </Box>

      <Box direction="row" gap={8} align="center">
        {item.hint ? (
          <Text key="hint" fontSize={10} color={item.selected ? selectedText : MUTED}>
            {item.hint}
          </Text>
        ) : null}
        {item.hasChild ? (
          <Icon
            key="child"
            icon={NavArrowRight}
            size={12}
            tint={item.selected ? selectedText : MUTED}
          />
        ) : null}
      </Box>
    </Box>
  );
}

function FloatingContextMenu() {
  return (
    <PanelChrome
      title="Context Stack"
      subtitle="Menu-like overlay in world space"
      icon={QuestionMark}
      width={244}
      background={solid("var(--floating-background)")}
      borderColor="var(--border)"
      backdropBlur={SUBTLE_BACKDROP_BLUR}
    >
      <Box direction="col" gap={4}>
        {MENU_ITEMS.map((item) => (
          <Box key={item.label}>
            <MenuItem item={item} />
          </Box>
        ))}
      </Box>
    </PanelChrome>
  );
}

function WindowStack() {
  return (
    <Box width={420} height={540}>
      <Box position="absolute" left={0} top={28} zIndex={10}>
        <PanelChrome
          title="Signal Deck"
          subtitle="Overlapping windows"
          icon={InfoCircle}
          width={246}
          background={WINDOW_ALT_BG}
        >
          <Box direction="col" gap={8}>
            <StatRow label="Textures" value="pooled" />
            <StatRow label="Icons" value="cached" />
            <StatRow label="Glyphs" value="SDF atlas" />
            <Box direction="row" gap={6}>
              <Badge label="hover" background={SKY_BG} />
              <Badge label="active" background={SUCCESS_BG} />
              <Badge label="drag" background={SUNSET_BG} />
            </Box>
          </Box>
        </PanelChrome>
      </Box>

      <Box position="absolute" left={124} top={0} zIndex={20}>
        <PanelChrome
          title="Prompt Rail"
          subtitle="Panel chrome + nested stacks"
          icon={Settings}
          width={286}
          background={WORLD_PANEL_BG}
          borderColor={WORLD_PANEL_BORDER}
        >
          <Box direction="col" gap={8}>
            <Box
              direction="row"
              gap={8}
              padding={edges(10)}
              background={SOFT_AMBER_BG}
              borderRadius={10}
              borderWidth={1}
              borderColor="var(--amber-200)"
            >
              <Icon icon={WarningCircle} size={16} tint="var(--amber-800)" />
              <Text fontSize={11} color={PANEL_TEXT} maxWidth={228}>
                Push layout until it stops being polite.
              </Text>
            </Box>
            <Box direction="row" gap={8}>
              <MiniStat label="Mode" value="world" background={CARD_BG} />
              <MiniStat label="Chrome" value="stacked" background={CARD_BG} />
            </Box>
            <Box direction="row" gap={8}>
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
                color={PANEL_TEXT}
                borderColor="var(--border)"
                onClick={() => console.log("[CanvasUI] Prompt rail queue")}
              />
            </Box>
          </Box>
        </PanelChrome>
      </Box>

      <Box position="absolute" left={36} top={250} zIndex={30}>
        <FloatingContextMenu />
      </Box>
    </Box>
  );
}

function SpecimenCard({ title, background, color }: SpecimenCardProps) {
  return (
    <Box
      direction="col"
      gap={8}
      padding={edges(14)}
      background={background}
      borderRadius={16}
      borderWidth={1}
      borderColor={PANEL_BORDER}
      minWidth={468}
      draggable
    >
      <Box key="floating-tag" position="absolute" right={12} top={12} zIndex={10}>
        <Badge label="Specimen" background={ACCENT_BG} />
      </Box>
      <Text key="title" fontSize={15} color={color}>
        {title}
      </Text>
      <Text key="targets" fontSize={28} color={color}>
        {TARGET_GLYPHS}
      </Text>
      <Text key="stress" fontSize={20} color={color}>
        {STRESS_GLYPHS}
      </Text>
      {SPECIMEN_ROWS.map((row, index) => (
        <Text key={`specimen-row-${index}`} fontSize={18} color={color}>
          {row}
        </Text>
      ))}
      <Box key="specimen-footer" direction="row" gap={6} align="center">
        <Badge label="Grid-fit" background={OUTLINE_BG} color={PANEL_TEXT} />
        <Badge label="No DOM" background={SKY_BG} />
        <Badge label="Zoom-linked" background={SUCCESS_BG} />
      </Box>
    </Box>
  );
}

function DebugPanel({ zoom, perf }: DebugOverlayProps) {
  const zoomLabel = `${Math.round(zoom * 100)}%`;
  const frameCountLabel = perf.sampleCount > 0 ? `${perf.sampleCount}/300` : "warming";
  const fpsValue = perf.fps > 0 ? `${perf.fps}` : "warming";
  const entityLabel = perf.entityCount > 0 ? `${perf.renderedCount}/${perf.entityCount}` : "0/0";

  return (
    <PanelChrome
      title="UI Engine Stress Test"
      subtitle="Live perf inside the floating UI language"
      icon={Settings}
      width={352}
      background={PANEL_BG}
    >
      <Box direction="col" gap={14}>
        <Box direction="row" gap={10}>
          <MiniStat label="FPS" value={fpsValue} background={SOFT_PRIMARY_BG} />
          <MiniStat label="Median" value={formatMs(perf.renderMedianMs)} />
          <MiniStat label="P95" value={formatMs(perf.renderP95Ms)} background={SOFT_AMBER_BG} />
        </Box>

        <Box direction="row" gap={10}>
          <MiniStat label="Zoom" value={zoomLabel} />
          <MiniStat label="Entities" value={entityLabel} />
          <MiniStat label="Ring" value={frameCountLabel} />
        </Box>

        <Box background={solid(DIVIDER)} height={1} />

        <Box direction="col" gap={12}>
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
        </Box>

        <Box direction="row" gap={10}>
          <Box
            direction="col"
            gap={8}
            padding={edges(12)}
            background={CARD_BG}
            borderRadius={12}
            borderWidth={1}
            borderColor={PANEL_BORDER}
            flexGrow={1}
            flexShrink={1}
          >
            <Box direction="row" gap={6} align="center">
              <Icon icon={Heart} size={14} tint="var(--destructive)" />
              <Text fontSize={13} color={PANEL_TEXT}>
                Frame HUD
              </Text>
            </Box>
            <StatRow label="Placement" value="inside panel" stacked valueMaxWidth={140} />
            <StatRow label="Anchor" value="world-space" stacked valueMaxWidth={140} />
            <StatRow label="Events" value="hover + active + drag" stacked valueMaxWidth={140} />
          </Box>

          <Box
            direction="col"
            gap={8}
            padding={edges(12)}
            background={CARD_BG}
            borderRadius={12}
            borderWidth={1}
            borderColor={PANEL_BORDER}
            flexGrow={1}
            flexShrink={1}
          >
            <Box direction="row" gap={6} align="center">
              <Icon icon={Eye} size={14} tint={PANEL_TEXT} />
              <Text fontSize={13} color={PANEL_TEXT}>
                Layout probes
              </Text>
            </Box>
            <StatRow label="Stacking" value="z-index" stacked valueMaxWidth={140} />
            <StatRow label="Windows" value="overlap" stacked valueMaxWidth={140} />
            <StatRow label="Menu" value="mocked" stacked valueMaxWidth={140} />
          </Box>
        </Box>

        <Box direction="row" gap={6} align="center">
          {STATUS_BADGES.map((badge) => (
            <Badge
              key={badge.label}
              label={badge.label}
              background={badge.background}
              color={badge.color}
            />
          ))}
        </Box>

        <Box direction="row" gap={8} align="center">
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
            borderColor="var(--destructive-50)"
            icon={Xmark}
            onClick={() => console.log("[CanvasUI] Danger clicked")}
          />
          <Button
            label="Questions"
            background={OUTLINE_BG}
            color={PANEL_TEXT}
            borderColor="var(--border)"
            icon={QuestionMark}
            onClick={() => console.log("[CanvasUI] Questions clicked")}
          />
        </Box>

        <Box direction="row" gap={4} align="center" justifyContent="center">
          <Text fontSize={10} color={MUTED}>
            No fixed DOM overlay · live perf snapshot · retained scene graph
          </Text>
        </Box>
      </Box>
    </PanelChrome>
  );
}

function WorldSpacePanel() {
  return (
    <PanelChrome
      title="World-Space District"
      subtitle="Canvas-native windows, cards, and controls"
      icon={Drag}
      width={468}
      background={WORLD_PANEL_BG}
      borderColor={WORLD_PANEL_BORDER}
    >
      <Box direction="col" gap={14}>
        <Box position="absolute" right={14} top={14} zIndex={40}>
          <Badge label="Drag me" background={SKY_BG} />
        </Box>

        <Box
          direction="col"
          gap={10}
          padding={edges(14)}
          background={SOFT_PRIMARY_BG}
          borderRadius={14}
          borderWidth={1}
          borderColor={WORLD_PANEL_BORDER}
        >
          <SectionEyebrow label="Canvas behavior" />
          <Text fontSize={18} color={PANEL_TEXT} maxWidth={408}>
            Zoom to scale the whole district. Drag any card to see retained positions stick.
          </Text>
        </Box>

        <Box
          direction="col"
          gap={10}
          padding={edges(14)}
          background={CARD_BG}
          borderRadius={14}
          borderWidth={1}
          borderColor={WORLD_PANEL_BORDER}
        >
          <SectionEyebrow label="Signals" />
          <Box direction="row" gap={6}>
            <Badge label="layout" background={PRIMARY_BG} />
            <Badge label="paint" background={SUCCESS_BG} />
          </Box>
          <Box direction="row" gap={6}>
            <Badge label="hit-test" background={ACCENT_BG} />
            <Badge label="stack" background={SUNSET_BG} />
          </Box>
        </Box>

        <Box direction="row" gap={10}>
          <MiniStat label="Docks" value="3" background={CARD_BG} />
          <MiniStat label="Windows" value="5" background={CARD_BG} />
          <MiniStat label="Menus" value="1 mock" background={CARD_BG} />
        </Box>

        <Box direction="row" gap={8} align="center">
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
            color={PANEL_TEXT}
            borderColor="var(--border)"
            icon={DropletHalf}
            onClick={() => console.log("[CanvasUI] Shades clicked")}
          />
          <Button
            label="Inspect"
            background={OUTLINE_BG}
            color={PANEL_TEXT}
            borderColor="var(--border)"
            icon={InfoCircle}
            onClick={() => console.log("[CanvasUI] Inspect clicked")}
          />
        </Box>
      </Box>
    </PanelChrome>
  );
}

function DebugOverlay({ zoom, perf }: DebugOverlayProps) {
  return (
    <Box key="debug-root" direction="row" gap={18} align="start">
      <Box direction="col" gap={14}>
        <DebugPanel zoom={zoom} perf={perf} />
        <ActionMatrix />
      </Box>

      <Box direction="col" gap={12}>
        <WorldSpacePanel />
        <SpecimenCard
          title="Font Specimen · White on Black"
          background={gradient("#111318", "#050608")}
          color={WHITE}
        />
        <SpecimenCard
          title="Font Specimen · Black on White"
          background={gradient("#f6f4f1", "#ffffff")}
          color={BLACK}
        />
        <SpecimenCard
          title="Font Specimen · Electric Accent"
          background={gradient("#2394ff", "#1170d6")}
          color={WHITE}
        />
      </Box>

      <WindowStack />

      <Box position="absolute" left={412} top={-52} zIndex={60}>
        <Badge label="Canvas-native overlay city" background={SUNSET_BG} />
      </Box>

      <Box position="absolute" left={1108} top={116} zIndex={80}>
        <FloatingContextMenu />
      </Box>
      <Box position="absolute" left={1132} top={152} zIndex={79}>
        <Box
          direction="row"
          gap={8}
          padding={edges(10)}
          background={solid("var(--floating-background)")}
          backdropFilter={[blur(SUBTLE_BACKDROP_BLUR)]}
          borderRadius={12}
          borderWidth={1}
          borderColor={PANEL_BORDER}
          draggable
        >
          <Icon icon={WarningCircle} size={14} tint="var(--amber-800)" />
          <Text fontSize={11} color={PANEL_TEXT}>
            Faux nested submenu
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

function PerfMetric({
  label,
  value,
  width,
  valueColor = HUD_VALUE,
}: {
  label: string;
  value: string;
  width: number;
  valueColor?: UIColorValue;
}) {
  return (
    <Box
      direction="row"
      gap={4}
      align="center"
      justifyContent="space-between"
      padding={edges(0, 2)}
      width={width}
      minWidth={width}
      maxWidth={width}
      flexShrink={0}
    >
      <Text fontSize={9} color={HUD_LABEL}>
        {label}
      </Text>
      <Text fontSize={10} color={valueColor}>
        {value}
      </Text>
    </Box>
  );
}

function FpsSparkline({ history, fps }: { history: number[]; fps: number }) {
  const width = 152;
  const height = 24;
  const points = history.length > 0 ? history : fps > 0 ? [fps] : [];

  if (points.length === 0) {
    return (
      <Box
        width={width}
        height={height}
        background={HUD_GRAPH_BG}
        borderRadius={8}
        borderWidth={1}
        borderColor={HUD_BORDER}
      />
    );
  }

  let floor = points[0]!;
  let ceiling = points[0]!;
  for (const point of points) {
    floor = Math.min(floor, point);
    ceiling = Math.max(ceiling, point);
  }
  floor = Math.max(0, floor - 8);
  ceiling = Math.max(60, ceiling + 4);
  if (ceiling - floor < 24) floor = Math.max(0, ceiling - 24);

  const yFor = (value: number) => {
    const normalized = clamp((value - floor) / Math.max(ceiling - floor, 1), 0, 1);
    return Math.round(height - 4 - normalized * (height - 8));
  };

  const xFor = (index: number) => {
    if (points.length === 1) return width - 3;
    return Math.round((index / (points.length - 1)) * (width - 3));
  };

  const linePoints = points.map((point, index) => ({
    x: xFor(index),
    y: yFor(point),
  }));

  return (
    <Box
      width={width}
      height={height}
      background={HUD_GRAPH_BG}
      borderRadius={8}
      borderWidth={1}
      borderColor={HUD_BORDER}
      overflow="hidden"
      position="relative"
    >
      <Box
        position="absolute"
        left={0}
        top={6}
        width={width}
        height={1}
        background={solid(HUD_GRAPH_GRID)}
      />
      <Box
        position="absolute"
        left={0}
        top={height - 7}
        width={width}
        height={1}
        background={solid(HUD_GRAPH_GRID)}
      />
      <Polyline
        position="absolute"
        left={0}
        top={0}
        zIndex={1}
        width={width}
        height={height}
        points={linePoints}
        stroke={HUD_GRAPH_LINE}
        strokeWidth={2}
        strokeLineCap="round"
      />
      <Box
        position="absolute"
        left={linePoints[linePoints.length - 1]!.x - 1}
        top={linePoints[linePoints.length - 1]!.y - 1}
        width={4}
        height={4}
        borderRadius={999}
        zIndex={2}
        background={solid(HUD_GRAPH_LINE)}
      />
    </Box>
  );
}

export const PerfHud = memo(function PerfHud({ perf }: { perf: DebugOverlayStats }) {
  const fpsValue = formatCompactFps(perf.fps);
  const low1FpsValue = formatCompactFps(perf.fpsLow1);
  const worstFrameValue = formatCompactMs(perf.frameWorstMs);
  const entitiesValue = `${perf.renderedCount}/${perf.entityCount}`;

  return (
    <Box position="fixed" left={12} top={12} zIndex={9500}>
      <Box
        direction="row"
        gap={8}
        align="center"
        padding={edges(6, 8)}
        background={HUD_BG}
        backdropFilter={[blur(SUBTLE_BACKDROP_BLUR)]}
        borderRadius={12}
        borderWidth={1}
        borderColor={HUD_BORDER}
      >
        <FpsSparkline history={perf.fpsHistory} fps={perf.fps} />
        <PerfMetric label="FPS" value={fpsValue} width={52} valueColor={HUD_GRAPH_LINE} />
        <PerfMetric label="1% Low" value={low1FpsValue} width={72} />
        <PerfMetric label="Worst" value={worstFrameValue} width={82} />
        <PerfMetric label="Median" value={formatCompactMs(perf.renderMedianMs)} width={88} />
        <PerfMetric label="P95" value={formatCompactMs(perf.renderP95Ms)} width={78} />
        <PerfMetric label="Entities" value={entitiesValue} width={72} />
      </Box>
    </Box>
  );
});

export function DebugUI({ zoom, perf }: DebugOverlayProps) {
  return <DebugPanel zoom={zoom} perf={perf} />;
}

export function DebugOverlayUI(props: DebugOverlayProps) {
  return <DebugOverlay {...props} />;
}
