import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  SHADER_TYPE_OPTIONS,
  ShaderType,
  DitheringKind,
  AsciiKind,
  GlassKind,
  GlitchKind,
  HalftoneKind,
  Shape,
} from "#types/canvas.ts";
import {
  useCanvasCommands,
  useSelectedEntities,
  useSelectedShaderType,
  useSelectionState,
} from "#context/use-canvas.ts";
import { useParamValue } from "#hooks/use-param-value.ts";
import { analytics } from "#lib/analytics.ts";
import { config } from "#config";
import {
  SliderPicker,
  SliderPickerWindow,
  SliderPickerOptions,
  SliderPickerItem,
  SliderPickerMixedItem,
} from "#components/ui/slider-picker/index.ts";
import "./knobs.css";
import { undo } from "#lib/undo.ts";
import { QuestionMark } from "iconoir-react";
import {
  AsciiBinaryIcon,
  AsciiExtendedIcon,
  AsciiIcon,
  AsciiMinimalIcon,
  AsciiStandardIcon,
  Bayer2x2Icon,
  Bayer4x4Icon,
  Bayer8x8Icon,
  BlobsIcon,
  BlueNoiseIcon,
  DitheringIcon,
  GlassFlowingIcon,
  GlassFlutedIcon,
  GlassFrostedIcon,
  GlassIcon,
  GlitchBlockCorruptIcon,
  GlitchChannelShiftIcon,
  GlitchIcon,
  GlitchPixelSmearIcon,
  GlitchScanlineIcon,
  HalftoneCmykIcon,
  HalftoneIcon,
  HalftoneNewsprintIcon,
  HalftoneRisoIcon,
  MeltIcon,
  ShapeCircleIcon,
  ShapeSquareIcon,
  ShapeVerticalRectIcon,
  WhiteNoiseIcon,
} from "#components/icons/knob-icons.tsx";

// ============================================================================
// Shader Type Picker (top row)
// ============================================================================

const shaderIconMap: Record<ShaderType, () => ReactNode> = {
  [ShaderType.ascii]: () => <AsciiIcon className="knob-icon" />,
  [ShaderType.blobs]: () => <BlobsIcon className="knob-icon" />,
  [ShaderType.dithering]: () => <DitheringIcon className="knob-icon" />,
  [ShaderType.halftone]: () => <HalftoneIcon className="knob-icon" />,
  [ShaderType.melt]: () => <MeltIcon className="knob-icon" />,
  [ShaderType.glass]: () => <GlassIcon className="knob-icon" />,
  [ShaderType.glitch]: () => <GlitchIcon className="knob-icon" />,
};

// ============================================================================
// Mobile Style Item Type
// ============================================================================

interface MobileStyleItem<T> {
  value: T;
  label: string; // Full label for floating label
  shortLabel: string; // Short label under button
  icon: () => ReactNode;
}

// ============================================================================
// Dithering Items
// ============================================================================

const DITHERING_ITEMS: MobileStyleItem<DitheringKind>[] = [
  {
    value: DitheringKind.bayer2x2,
    label: "Bayer 2×2",
    shortLabel: "2×2",
    icon: () => <Bayer2x2Icon className="knob-icon" />,
  },
  {
    value: DitheringKind.bayer4x4,
    label: "Bayer 4×4",
    shortLabel: "4×4",
    icon: () => <Bayer4x4Icon className="knob-icon" />,
  },
  {
    value: DitheringKind.bayer8x8,
    label: "Bayer 8×8",
    shortLabel: "8×8",
    icon: () => <Bayer8x8Icon className="knob-icon" />,
  },
  {
    value: DitheringKind.whiteNoise,
    label: "White Noise",
    shortLabel: "White",
    icon: () => <WhiteNoiseIcon className="knob-icon" />,
  },
  {
    value: DitheringKind.blueNoise,
    label: "Blue Noise",
    shortLabel: "Blue",
    icon: () => <BlueNoiseIcon className="knob-icon" />,
  },
];

// ============================================================================
// ASCII Items
// ============================================================================

const ASCII_ITEMS: MobileStyleItem<AsciiKind>[] = [
  {
    value: AsciiKind.standard,
    label: "Standard Characters",
    shortLabel: "Standard",
    icon: () => <AsciiStandardIcon className="knob-icon" />,
  },
  {
    value: AsciiKind.extended,
    label: "Extended Characters",
    shortLabel: "Extended",
    icon: () => <AsciiExtendedIcon className="knob-icon" />,
  },
  {
    value: AsciiKind.binary,
    label: "Binary Characters",
    shortLabel: "Binary",
    icon: () => <AsciiBinaryIcon className="knob-icon" />,
  },
  {
    value: AsciiKind.minimal,
    label: "Minimal Characters",
    shortLabel: "Minimal",
    icon: () => <AsciiMinimalIcon className="knob-icon" />,
  },
];

// ============================================================================
// Shape Items (with SVG icons)
// ============================================================================

const SHAPE_ITEMS: MobileStyleItem<Shape>[] = [
  {
    value: Shape.circle,
    label: "Circle",
    shortLabel: "Circle",
    icon: () => <ShapeCircleIcon className="knob-icon" />,
  },
  {
    value: Shape.square,
    label: "Square",
    shortLabel: "Square",
    icon: () => <ShapeSquareIcon className="knob-icon" />,
  },
  {
    value: Shape.rect_v,
    label: "Vertical Rectangle",
    shortLabel: "Vert",
    icon: () => <ShapeVerticalRectIcon className="knob-icon" />,
  },
];

// ============================================================================
// Mobile Dithering Style Knobs
// ============================================================================

function MobileDitheringStyleKnobs() {
  const { changeDitheringKind } = useCanvasCommands();
  const ditheringKind = useParamValue(
    "dithering.kind",
    config.defaults.shaderParams.dithering.kind,
  );

  // Floating label state
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFloatingLabel = (text: string) => {
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    setFloatingLabel(text);
    floatingLabelTimeoutRef.current = setTimeout(
      () => setFloatingLabel(null),
      config.ui.floatingParamLabelHideTimeoutMs,
    );
  };

  useEffect(
    () => () => {
      if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    },
    [],
  );

  // Show floating label on value change
  const handleValueChange = (value: string) => {
    changeDitheringKind(value);
    const item = DITHERING_ITEMS.find((i) => i.value === value);
    if (item) showFloatingLabel(item.label);
  };

  // Show floating label on interaction start
  const handleInteractionStart = () => {
    undo.beginTransaction();
    if (ditheringKind.isMixed) {
      showFloatingLabel("Mixed");
    } else {
      const item = DITHERING_ITEMS.find((i) => i.value === ditheringKind.value);
      if (item) showFloatingLabel(item.label);
    }
  };

  // Commit undo transaction
  const handleValueCommit = () => {
    undo.commitTransaction();
  };

  if (!ditheringKind.isSupported) return null;

  return (
    <>
      {/* Floating label via portal */}
      {floatingLabel &&
        createPortal(
          <div className="mobile-style-knobs__floating-label" data-visible>
            {floatingLabel}
          </div>,
          document.body,
        )}

      <SliderPicker
        value={ditheringKind.isMixed ? "" : ditheringKind.value}
        onValueChange={handleValueChange}
        onInteractionStart={handleInteractionStart}
        onValueCommit={handleValueCommit}
        className="mobile-style-knobs"
      >
        <SliderPickerWindow className="mobile-style-knobs__window">
          <SliderPickerOptions
            className="mobile-style-knobs__options"
            aria-label="Dithering algorithm selection"
          >
            {ditheringKind.isMixed && (
              <SliderPickerMixedItem className="mobile-style-knobs__item">
                <button type="button" className="ui-button" tabIndex={-1}>
                  <QuestionMark />
                </button>
                <span className="mobile-style-knobs__label">Mixed</span>
              </SliderPickerMixedItem>
            )}
            {DITHERING_ITEMS.map((item) => (
              <SliderPickerItem
                key={item.value}
                value={item.value}
                className="mobile-style-knobs__item"
              >
                <button type="button" className="ui-button" tabIndex={-1}>
                  {item.icon()}
                </button>
                <span className="mobile-style-knobs__label">{item.shortLabel}</span>
              </SliderPickerItem>
            ))}
          </SliderPickerOptions>
          <div className="mobile-style-knobs__highlight" aria-hidden="true" />
        </SliderPickerWindow>
      </SliderPicker>
    </>
  );
}

// ============================================================================
// Mobile ASCII Style Knobs
// ============================================================================

function MobileAsciiStyleKnobs() {
  const { changeAsciiKind } = useCanvasCommands();
  const asciiKind = useParamValue("ascii.kind", config.defaults.shaderParams.ascii.kind);

  // Floating label state
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFloatingLabel = (text: string) => {
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    setFloatingLabel(text);
    floatingLabelTimeoutRef.current = setTimeout(
      () => setFloatingLabel(null),
      config.ui.floatingParamLabelHideTimeoutMs,
    );
  };

  useEffect(
    () => () => {
      if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    },
    [],
  );

  // Show floating label on value change
  const handleValueChange = (value: string) => {
    changeAsciiKind(value);
    const item = ASCII_ITEMS.find((i) => i.value === value);
    if (item) showFloatingLabel(item.label);
  };

  // Show floating label on interaction start
  const handleInteractionStart = () => {
    undo.beginTransaction();
    if (asciiKind.isMixed) {
      showFloatingLabel("Mixed");
    } else {
      const item = ASCII_ITEMS.find((i) => i.value === asciiKind.value);
      if (item) showFloatingLabel(item.label);
    }
  };

  // Commit undo transaction
  const handleValueCommit = () => {
    undo.commitTransaction();
  };

  if (!asciiKind.isSupported) return null;

  return (
    <>
      {/* Floating label via portal */}
      {floatingLabel &&
        createPortal(
          <div className="mobile-style-knobs__floating-label" data-visible>
            {floatingLabel}
          </div>,
          document.body,
        )}

      <SliderPicker
        value={asciiKind.isMixed ? "" : asciiKind.value}
        onValueChange={handleValueChange}
        onInteractionStart={handleInteractionStart}
        onValueCommit={handleValueCommit}
        className="mobile-style-knobs"
      >
        <SliderPickerWindow className="mobile-style-knobs__window">
          <SliderPickerOptions
            className="mobile-style-knobs__options"
            aria-label="ASCII character set selection"
          >
            {asciiKind.isMixed && (
              <SliderPickerMixedItem className="mobile-style-knobs__item">
                <button type="button" className="ui-button" tabIndex={-1}>
                  <QuestionMark />
                </button>
                <span className="mobile-style-knobs__label">Mixed</span>
              </SliderPickerMixedItem>
            )}
            {ASCII_ITEMS.map((item) => (
              <SliderPickerItem
                key={item.value}
                value={item.value}
                className="mobile-style-knobs__item"
              >
                <button type="button" className="ui-button" tabIndex={-1}>
                  {item.icon()}
                </button>
                <span className="mobile-style-knobs__label">{item.shortLabel}</span>
              </SliderPickerItem>
            ))}
          </SliderPickerOptions>
          <div className="mobile-style-knobs__highlight" aria-hidden="true" />
        </SliderPickerWindow>
      </SliderPicker>
    </>
  );
}

// ============================================================================
// Glass Kind Items
// ============================================================================

const GLASS_ITEMS: MobileStyleItem<GlassKind>[] = [
  {
    value: GlassKind.fluted,
    label: "Fluted Glass",
    shortLabel: "Fluted",
    icon: () => <GlassFlutedIcon className="knob-icon" />,
  },
  {
    value: GlassKind.frostedVoronoi,
    label: "Frosted Glass",
    shortLabel: "Frosted",
    icon: () => <GlassFrostedIcon className="knob-icon" />,
  },
  {
    value: GlassKind.flowing,
    label: "Flowing Glass",
    shortLabel: "Flowing",
    icon: () => <GlassFlowingIcon className="knob-icon" />,
  },
];

// ============================================================================
// Mobile Glass Style Knobs
// ============================================================================

function MobileGlassStyleKnobs() {
  const { changeGlassKind } = useCanvasCommands();
  const glassKind = useParamValue("glass.kind", config.defaults.shaderParams.glass!.kind);

  // Floating label state
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFloatingLabel = (text: string) => {
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    setFloatingLabel(text);
    floatingLabelTimeoutRef.current = setTimeout(
      () => setFloatingLabel(null),
      config.ui.floatingParamLabelHideTimeoutMs,
    );
  };

  useEffect(
    () => () => {
      if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    },
    [],
  );

  const handleValueChange = (value: string) => {
    changeGlassKind(value);
    const item = GLASS_ITEMS.find((i) => i.value === value);
    if (item) showFloatingLabel(item.label);
  };

  const handleInteractionStart = () => {
    undo.beginTransaction();
    if (glassKind.isMixed) {
      showFloatingLabel("Mixed");
    } else {
      const item = GLASS_ITEMS.find((i) => i.value === glassKind.value);
      if (item) showFloatingLabel(item.label);
    }
  };

  const handleValueCommit = () => {
    undo.commitTransaction();
  };

  if (!glassKind.isSupported) return null;

  return (
    <>
      {floatingLabel &&
        createPortal(
          <div className="mobile-style-knobs__floating-label" data-visible>
            {floatingLabel}
          </div>,
          document.body,
        )}

      <SliderPicker
        value={glassKind.isMixed ? "" : glassKind.value}
        onValueChange={handleValueChange}
        onInteractionStart={handleInteractionStart}
        onValueCommit={handleValueCommit}
        className="mobile-style-knobs"
      >
        <SliderPickerWindow className="mobile-style-knobs__window">
          <SliderPickerOptions
            className="mobile-style-knobs__options"
            aria-label="Glass type selection"
          >
            {glassKind.isMixed && (
              <SliderPickerMixedItem className="mobile-style-knobs__item">
                <button type="button" className="ui-button" tabIndex={-1}>
                  <QuestionMark />
                </button>
                <span className="mobile-style-knobs__label">Mixed</span>
              </SliderPickerMixedItem>
            )}
            {GLASS_ITEMS.map((item) => (
              <SliderPickerItem
                key={item.value}
                value={item.value}
                className="mobile-style-knobs__item"
              >
                <button type="button" className="ui-button" tabIndex={-1}>
                  {item.icon()}
                </button>
                <span className="mobile-style-knobs__label">{item.shortLabel}</span>
              </SliderPickerItem>
            ))}
          </SliderPickerOptions>
          <div className="mobile-style-knobs__highlight" aria-hidden="true" />
        </SliderPickerWindow>
      </SliderPicker>
    </>
  );
}

// ============================================================================
// Glitch Kind Items
// ============================================================================

const GLITCH_ITEMS: MobileStyleItem<GlitchKind>[] = [
  {
    value: GlitchKind.channelShift,
    label: "Channel Shift",
    shortLabel: "Channel",
    icon: () => <GlitchChannelShiftIcon className="knob-icon" />,
  },
  {
    value: GlitchKind.scanline,
    label: "Scanline",
    shortLabel: "Scan",
    icon: () => <GlitchScanlineIcon className="knob-icon" />,
  },
  {
    value: GlitchKind.blockCorrupt,
    label: "Block Corrupt",
    shortLabel: "Block",
    icon: () => <GlitchBlockCorruptIcon className="knob-icon" />,
  },
  {
    value: GlitchKind.pixelSmear,
    label: "Pixel Smear",
    shortLabel: "Smear",
    icon: () => <GlitchPixelSmearIcon className="knob-icon" />,
  },
];

// ============================================================================
// Mobile Glitch Style Knobs
// ============================================================================

function MobileGlitchStyleKnobs() {
  const { changeGlitchKind } = useCanvasCommands();
  const glitchKind = useParamValue("glitch.kind", config.defaults.shaderParams.glitch!.kind);

  // Floating label state
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFloatingLabel = (text: string) => {
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    setFloatingLabel(text);
    floatingLabelTimeoutRef.current = setTimeout(
      () => setFloatingLabel(null),
      config.ui.floatingParamLabelHideTimeoutMs,
    );
  };

  useEffect(
    () => () => {
      if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    },
    [],
  );

  const handleValueChange = (value: string) => {
    changeGlitchKind(value);
    const item = GLITCH_ITEMS.find((i) => i.value === value);
    if (item) showFloatingLabel(item.label);
  };

  const handleInteractionStart = () => {
    undo.beginTransaction();
    if (glitchKind.isMixed) {
      showFloatingLabel("Mixed");
    } else {
      const item = GLITCH_ITEMS.find((i) => i.value === glitchKind.value);
      if (item) showFloatingLabel(item.label);
    }
  };

  const handleValueCommit = () => {
    undo.commitTransaction();
  };

  if (!glitchKind.isSupported) return null;

  return (
    <>
      {floatingLabel &&
        createPortal(
          <div className="mobile-style-knobs__floating-label" data-visible>
            {floatingLabel}
          </div>,
          document.body,
        )}

      <SliderPicker
        value={glitchKind.isMixed ? "" : glitchKind.value}
        onValueChange={handleValueChange}
        onInteractionStart={handleInteractionStart}
        onValueCommit={handleValueCommit}
        className="mobile-style-knobs"
      >
        <SliderPickerWindow className="mobile-style-knobs__window">
          <SliderPickerOptions
            className="mobile-style-knobs__options"
            aria-label="Glitch type selection"
          >
            {glitchKind.isMixed && (
              <SliderPickerMixedItem className="mobile-style-knobs__item">
                <button type="button" className="ui-button" tabIndex={-1}>
                  <QuestionMark />
                </button>
                <span className="mobile-style-knobs__label">Mixed</span>
              </SliderPickerMixedItem>
            )}
            {GLITCH_ITEMS.map((item) => (
              <SliderPickerItem
                key={item.value}
                value={item.value}
                className="mobile-style-knobs__item"
              >
                <button type="button" className="ui-button" tabIndex={-1}>
                  {item.icon()}
                </button>
                <span className="mobile-style-knobs__label">{item.shortLabel}</span>
              </SliderPickerItem>
            ))}
          </SliderPickerOptions>
          <div className="mobile-style-knobs__highlight" aria-hidden="true" />
        </SliderPickerWindow>
      </SliderPicker>
    </>
  );
}

// ============================================================================
// Halftone Kind Items
// ============================================================================

const HALFTONE_ITEMS: MobileStyleItem<HalftoneKind>[] = [
  {
    value: HalftoneKind.classic,
    label: "Classic",
    shortLabel: "Classic",
    icon: () => <HalftoneIcon className="knob-icon" />,
  },
  {
    value: HalftoneKind.newsprint,
    label: "Newsprint",
    shortLabel: "News",
    icon: () => <HalftoneNewsprintIcon className="knob-icon" />,
  },
  {
    value: HalftoneKind.cmyk,
    label: "CMYK",
    shortLabel: "CMYK",
    icon: () => <HalftoneCmykIcon className="knob-icon" />,
  },
  {
    value: HalftoneKind.riso,
    label: "Riso",
    shortLabel: "Riso",
    icon: () => <HalftoneRisoIcon className="knob-icon" />,
  },
];

// ============================================================================
// Mobile Halftone Style Knobs
// ============================================================================

function MobileHalftoneStyleKnobs() {
  const { changeHalftoneKind } = useCanvasCommands();
  const halftoneKind = useParamValue("halftone.kind", config.defaults.shaderParams.halftone.kind);

  // Floating label state
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFloatingLabel = (text: string) => {
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    setFloatingLabel(text);
    floatingLabelTimeoutRef.current = setTimeout(
      () => setFloatingLabel(null),
      config.ui.floatingParamLabelHideTimeoutMs,
    );
  };

  useEffect(
    () => () => {
      if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    },
    [],
  );

  const handleValueChange = (value: string) => {
    changeHalftoneKind(value);
    const item = HALFTONE_ITEMS.find((i) => i.value === value);
    if (item) showFloatingLabel(item.label);
  };

  const handleInteractionStart = () => {
    undo.beginTransaction();
    if (halftoneKind.isMixed) {
      showFloatingLabel("Mixed");
    } else {
      const item = HALFTONE_ITEMS.find((i) => i.value === halftoneKind.value);
      if (item) showFloatingLabel(item.label);
    }
  };

  const handleValueCommit = () => {
    undo.commitTransaction();
  };

  if (!halftoneKind.isSupported) return null;

  return (
    <>
      {floatingLabel &&
        createPortal(
          <div className="mobile-style-knobs__floating-label" data-visible>
            {floatingLabel}
          </div>,
          document.body,
        )}

      <SliderPicker
        value={halftoneKind.isMixed ? "" : halftoneKind.value}
        onValueChange={handleValueChange}
        onInteractionStart={handleInteractionStart}
        onValueCommit={handleValueCommit}
        className="mobile-style-knobs"
      >
        <SliderPickerWindow className="mobile-style-knobs__window">
          <SliderPickerOptions
            className="mobile-style-knobs__options"
            aria-label="Halftone screen selection"
          >
            {halftoneKind.isMixed && (
              <SliderPickerMixedItem className="mobile-style-knobs__item">
                <button type="button" className="ui-button" tabIndex={-1}>
                  <QuestionMark />
                </button>
                <span className="mobile-style-knobs__label">Mixed</span>
              </SliderPickerMixedItem>
            )}
            {HALFTONE_ITEMS.map((item) => (
              <SliderPickerItem
                key={item.value}
                value={item.value}
                className="mobile-style-knobs__item"
              >
                <button type="button" className="ui-button" tabIndex={-1}>
                  {item.icon()}
                </button>
                <span className="mobile-style-knobs__label">{item.shortLabel}</span>
              </SliderPickerItem>
            ))}
          </SliderPickerOptions>
          <div className="mobile-style-knobs__highlight" aria-hidden="true" />
        </SliderPickerWindow>
      </SliderPicker>
    </>
  );
}

// ============================================================================
// Mobile Shape Style Knobs
// ============================================================================

function MobileShapeStyleKnobs() {
  const { updateSelectedEntityParams } = useCanvasCommands();
  const shape = useParamValue("shape", config.defaults.shaderParams.shape);

  // Floating label state
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFloatingLabel = (text: string) => {
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    setFloatingLabel(text);
    floatingLabelTimeoutRef.current = setTimeout(
      () => setFloatingLabel(null),
      config.ui.floatingParamLabelHideTimeoutMs,
    );
  };

  useEffect(
    () => () => {
      if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    },
    [],
  );

  // Handle shape change
  const handleShapeChange = (value: string) => {
    updateSelectedEntityParams({ shape: value as Shape });
    const item = SHAPE_ITEMS.find((i) => i.value === value);
    if (item) showFloatingLabel(item.label);
  };

  // Show floating label on interaction start
  const handleInteractionStart = () => {
    undo.beginTransaction();
    if (shape.isMixed) {
      showFloatingLabel("Mixed");
    } else {
      const item = SHAPE_ITEMS.find((i) => i.value === shape.value);
      if (item) showFloatingLabel(item.label);
    }
  };

  // Commit undo transaction
  const handleValueCommit = () => {
    undo.commitTransaction();
  };

  if (!shape.isSupported) return null;

  return (
    <>
      {/* Floating label via portal */}
      {floatingLabel &&
        createPortal(
          <div className="mobile-style-knobs__floating-label" data-visible>
            {floatingLabel}
          </div>,
          document.body,
        )}

      <SliderPicker
        value={shape.isMixed ? "" : shape.value}
        onValueChange={handleShapeChange}
        onInteractionStart={handleInteractionStart}
        onValueCommit={handleValueCommit}
        className="mobile-style-knobs"
      >
        <SliderPickerWindow className="mobile-style-knobs__window">
          <SliderPickerOptions className="mobile-style-knobs__options" aria-label="Shape selection">
            {shape.isMixed && (
              <SliderPickerMixedItem className="mobile-style-knobs__item">
                <button type="button" className="ui-button" tabIndex={-1}>
                  <QuestionMark />
                </button>
                <span className="mobile-style-knobs__label">Mixed</span>
              </SliderPickerMixedItem>
            )}
            {SHAPE_ITEMS.map((item) => (
              <SliderPickerItem
                key={item.value}
                value={item.value}
                className="mobile-style-knobs__item"
              >
                <button type="button" className="ui-button" tabIndex={-1}>
                  {item.icon()}
                </button>
                <span className="mobile-style-knobs__label">{item.shortLabel}</span>
              </SliderPickerItem>
            ))}
          </SliderPickerOptions>
          <div className="mobile-style-knobs__highlight" aria-hidden="true" />
        </SliderPickerWindow>
      </SliderPicker>
    </>
  );
}

// ============================================================================
// Main Mobile Style Knobs Component
// ============================================================================

export function MobileStyleKnobs() {
  const selectedEntities = useSelectedEntities();
  const selectedShaderType = useSelectedShaderType();
  const selectionState = useSelectionState();
  const { setShowOriginal, changeShaderType } = useCanvasCommands();

  // Floating label state
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isShaderMixed = !selectionState.hasUniformShader;

  // Track shader type at interaction start for analytics
  const shaderAtStartRef = useRef<string | null>(null);

  // Show original state for toggle-on-reselect
  const showOriginal = useParamValue("showOriginal", config.defaults.shaderParams.showOriginal);

  const showFloatingLabel = (text: string) => {
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    setFloatingLabel(text);
    floatingLabelTimeoutRef.current = setTimeout(() => {
      setFloatingLabel(null);
    }, config.ui.floatingParamLabelHideTimeoutMs);
  };

  useEffect(
    () => () => {
      if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    },
    [],
  );

  const handleShowOriginalToggle = () => {
    // if mixed, set all to true; otherwise toggle
    const newValue = showOriginal.isMixed ? true : !showOriginal.value;
    setShowOriginal(newValue);
    showFloatingLabel(newValue ? "Show Original On" : "Show Original Off");
  };

  const handleShaderTypeChange = (value: string) => {
    changeShaderType(value);
    const option = SHADER_TYPE_OPTIONS.find((o) => o.value === value);
    if (option) showFloatingLabel(option.label);
  };

  const handleInteractionStart = () => {
    undo.beginTransaction();
    shaderAtStartRef.current = isShaderMixed ? "mixed" : selectedShaderType;
    if (isShaderMixed) {
      showFloatingLabel("Mixed");
    } else {
      const option = SHADER_TYPE_OPTIONS.find((o) => o.value === selectedShaderType);
      if (option) showFloatingLabel(option.label);
    }
  };

  const handleValueCommit = (value: string) => {
    undo.commitTransaction();
    const from = shaderAtStartRef.current;
    if (from && from !== value) {
      analytics.track("shader.changed", {
        from,
        to: value,
        entity_count: selectedEntities.length,
      });
    }
  };

  // checked=true means shader is active (not showing original)
  const showOriginalChecked = showOriginal.isMixed ? true : !showOriginal.value;

  return (
    <>
      {/* Floating label via portal */}
      {floatingLabel &&
        createPortal(
          <div className="mobile-style-knobs__floating-label" data-visible>
            {floatingLabel}
          </div>,
          document.body,
        )}

      {/* Shader type picker */}
      <SliderPicker
        value={isShaderMixed ? "" : selectedShaderType}
        onValueChange={handleShaderTypeChange}
        onInteractionStart={handleInteractionStart}
        onValueCommit={handleValueCommit}
        className="mobile-style-knobs"
      >
        <SliderPickerWindow className="mobile-style-knobs__window">
          <SliderPickerOptions
            className="mobile-style-knobs__options"
            aria-label="Filter selection"
          >
            {isShaderMixed && (
              <SliderPickerMixedItem
                className="mobile-style-knobs__item"
                checked={showOriginalChecked}
                onCheckedChange={handleShowOriginalToggle}
              >
                <button type="button" className="ui-button" tabIndex={-1}>
                  <QuestionMark />
                </button>
                <span className="mobile-style-knobs__label">Mixed</span>
              </SliderPickerMixedItem>
            )}
            {SHADER_TYPE_OPTIONS.map((shader) => (
              <SliderPickerItem
                key={shader.value}
                value={shader.value}
                className="mobile-style-knobs__item"
                checked={showOriginalChecked}
                onCheckedChange={handleShowOriginalToggle}
              >
                <button type="button" className="ui-button" tabIndex={-1}>
                  {shaderIconMap[shader.value]()}
                </button>
                <span className="mobile-style-knobs__label">{shader.label}</span>
              </SliderPickerItem>
            ))}
          </SliderPickerOptions>
          <div className="mobile-style-knobs__highlight" aria-hidden="true" />
        </SliderPickerWindow>
      </SliderPicker>

      {/* Shader-specific style picker - only one will render based on selected shader.
          Shape is shared by several shaders; keying it per shader mounts a fresh picker on a
          shader switch, so it jumps to the value instead of scrolling the old list. */}
      <MobileDitheringStyleKnobs />
      <MobileAsciiStyleKnobs />
      <MobileGlassStyleKnobs />
      <MobileGlitchStyleKnobs />
      <MobileHalftoneStyleKnobs />
      <MobileShapeStyleKnobs key={selectedShaderType} />
    </>
  );
}
