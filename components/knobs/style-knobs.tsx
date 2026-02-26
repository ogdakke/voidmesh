import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  SHADER_TYPE_OPTIONS,
  ShaderType,
  DitheringKind,
  AsciiKind,
  GlassKind,
  Shape,
} from "#types/canvas.ts";
import { useCanvas } from "#context/use-canvas.ts";
import { useCanvasActions, useParamValue } from "#hooks/use-canvas-actions.ts";
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

// ============================================================================
// Shader Type Picker (top row)
// ============================================================================

const shaderIconMap: Record<ShaderType, () => ReactNode> = {
  [ShaderType.ascii]: () => <span>A</span>,
  [ShaderType.blobs]: () => <span>B</span>,
  [ShaderType.dithering]: () => <span>D</span>,
  [ShaderType.halftone]: () => <span>H</span>,
  [ShaderType.melt]: () => <span>M</span>,
  [ShaderType.glass]: () => <span>G</span>,
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
    icon: () => <span>B</span>,
  },
  {
    value: DitheringKind.bayer4x4,
    label: "Bayer 4×4",
    shortLabel: "4×4",
    icon: () => <span>B</span>,
  },
  {
    value: DitheringKind.bayer8x8,
    label: "Bayer 8×8",
    shortLabel: "8×8",
    icon: () => <span>B</span>,
  },
  {
    value: DitheringKind.whiteNoise,
    label: "White Noise",
    shortLabel: "White",
    icon: () => <span>W</span>,
  },
  {
    value: DitheringKind.blueNoise,
    label: "Blue Noise",
    shortLabel: "Blue",
    icon: () => <span>B</span>,
  },
  {
    value: DitheringKind.floydSteinberg,
    label: "Floyd-Steinberg",
    shortLabel: "F-S",
    icon: () => <span>F</span>,
  },
  {
    value: DitheringKind.atkinson,
    label: "Atkinson",
    shortLabel: "Atkin",
    icon: () => <span>A</span>,
  },
  {
    value: DitheringKind.jarvisJudiceNinke,
    label: "Jarvis-Judice-Ninke",
    shortLabel: "J-J-N",
    icon: () => <span>J</span>,
  },
  {
    value: DitheringKind.stucki,
    label: "Stucki",
    shortLabel: "Stucki",
    icon: () => <span>S</span>,
  },
  {
    value: DitheringKind.burkes,
    label: "Burkes",
    shortLabel: "Burkes",
    icon: () => <span>B</span>,
  },
  {
    value: DitheringKind.sierra,
    label: "Sierra",
    shortLabel: "Sierra",
    icon: () => <span>S</span>,
  },
  {
    value: DitheringKind.sierraLite,
    label: "Sierra Lite",
    shortLabel: "Lite",
    icon: () => <span>S</span>,
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
    icon: () => <span>S</span>,
  },
  {
    value: AsciiKind.extended,
    label: "Extended Characters",
    shortLabel: "Extended",
    icon: () => <span>E</span>,
  },
  {
    value: AsciiKind.binary,
    label: "Binary Characters",
    shortLabel: "Binary",
    icon: () => <span>B</span>,
  },
  {
    value: AsciiKind.minimal,
    label: "Minimal Characters",
    shortLabel: "Minimal",
    icon: () => <span>M</span>,
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
    icon: () => (
      <svg viewBox="0 0 24 24" width="16" height="16">
        <circle cx="12" cy="12" r="8" fill="currentColor" />
      </svg>
    ),
  },
  {
    value: Shape.square,
    label: "Square",
    shortLabel: "Square",
    icon: () => (
      <svg viewBox="0 0 24 24" width="16" height="16">
        <rect x="4" y="4" width="16" height="16" fill="currentColor" />
      </svg>
    ),
  },
  {
    value: Shape.rect_v,
    label: "Vertical Rectangle",
    shortLabel: "Vert",
    icon: () => (
      <svg viewBox="0 0 24 24" width="16" height="16">
        <rect x="8" y="3" width="8" height="18" fill="currentColor" />
      </svg>
    ),
  },
];

// ============================================================================
// Mobile Dithering Style Knobs
// ============================================================================

function MobileDitheringStyleKnobs() {
  const { handleDitheringKindChange } = useCanvasActions();
  const ditheringKind = useParamValue(
    "dithering.kind",
    config.defaults.shaderParams.dithering.kind,
  );

  // Floating label state
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show floating label on value change
  const handleValueChange = (value: string) => {
    handleDitheringKindChange(value);
    const item = DITHERING_ITEMS.find((i) => i.value === value);
    if (item) setFloatingLabel(item.label);
  };

  // Show floating label on interaction start
  const handleInteractionStart = () => {
    undo.beginTransaction();
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    if (ditheringKind.isMixed) {
      setFloatingLabel("Mixed");
    } else {
      const item = DITHERING_ITEMS.find((i) => i.value === ditheringKind.value);
      if (item) setFloatingLabel(item.label);
    }
  };

  // Hide floating label after timeout
  const handleValueCommit = () => {
    undo.commitTransaction();
    floatingLabelTimeoutRef.current = setTimeout(() => {
      setFloatingLabel(null);
    }, config.ui.floatingParamLabelHideTimeoutMs);
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
                <button type="button" className="ui-button" data-variant="primary" tabIndex={-1}>
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
                <button type="button" className="ui-button" data-variant="primary" tabIndex={-1}>
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
  const { handleAsciiKindChange } = useCanvasActions();
  const asciiKind = useParamValue("ascii.kind", config.defaults.shaderParams.ascii.kind);

  // Floating label state
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show floating label on value change
  const handleValueChange = (value: string) => {
    handleAsciiKindChange(value);
    const item = ASCII_ITEMS.find((i) => i.value === value);
    if (item) setFloatingLabel(item.label);
  };

  // Show floating label on interaction start
  const handleInteractionStart = () => {
    undo.beginTransaction();
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    if (asciiKind.isMixed) {
      setFloatingLabel("Mixed");
    } else {
      const item = ASCII_ITEMS.find((i) => i.value === asciiKind.value);
      if (item) setFloatingLabel(item.label);
    }
  };

  // Hide floating label after timeout
  const handleValueCommit = () => {
    undo.commitTransaction();
    floatingLabelTimeoutRef.current = setTimeout(() => {
      setFloatingLabel(null);
    }, config.ui.floatingParamLabelHideTimeoutMs);
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
                <button type="button" className="ui-button" data-variant="primary" tabIndex={-1}>
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
                <button type="button" className="ui-button" data-variant="primary" tabIndex={-1}>
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
    icon: () => <span>F</span>,
  },
  {
    value: GlassKind.frostedVoronoi,
    label: "Frosted Glass",
    shortLabel: "Frosted",
    icon: () => <span>V</span>,
  },
  {
    value: GlassKind.flowing,
    label: "Flowing Glass (experimental)",
    shortLabel: "Flowing",
    icon: () => <span>F</span>,
  },
];

// ============================================================================
// Mobile Glass Style Knobs
// ============================================================================

function MobileGlassStyleKnobs() {
  const { handleGlassKindChange } = useCanvasActions();
  const glassKind = useParamValue("glass.kind", config.defaults.shaderParams.glass!.kind);

  // Floating label state
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleValueChange = (value: string) => {
    handleGlassKindChange(value);
    const item = GLASS_ITEMS.find((i) => i.value === value);
    if (item) setFloatingLabel(item.label);
  };

  const handleInteractionStart = () => {
    undo.beginTransaction();
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    if (glassKind.isMixed) {
      setFloatingLabel("Mixed");
    } else {
      const item = GLASS_ITEMS.find((i) => i.value === glassKind.value);
      if (item) setFloatingLabel(item.label);
    }
  };

  const handleValueCommit = () => {
    undo.commitTransaction();
    floatingLabelTimeoutRef.current = setTimeout(() => {
      setFloatingLabel(null);
    }, config.ui.floatingParamLabelHideTimeoutMs);
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
                <button type="button" className="ui-button" data-variant="primary" tabIndex={-1}>
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
                <button type="button" className="ui-button" data-variant="primary" tabIndex={-1}>
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
  const { updateSelectedEntityParams } = useCanvas();
  const shape = useParamValue("shape", config.defaults.shaderParams.shape);

  // Floating label state
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Handle shape change
  const handleShapeChange = (value: string) => {
    updateSelectedEntityParams({ shape: value as Shape });
    const item = SHAPE_ITEMS.find((i) => i.value === value);
    if (item) setFloatingLabel(item.label);
  };

  // Show floating label on interaction start
  const handleInteractionStart = () => {
    undo.beginTransaction();
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    if (shape.isMixed) {
      setFloatingLabel("Mixed");
    } else {
      const item = SHAPE_ITEMS.find((i) => i.value === shape.value);
      if (item) setFloatingLabel(item.label);
    }
  };

  // Hide floating label after timeout
  const handleValueCommit = () => {
    undo.commitTransaction();
    floatingLabelTimeoutRef.current = setTimeout(() => {
      setFloatingLabel(null);
    }, config.ui.floatingParamLabelHideTimeoutMs);
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
                <button type="button" className="ui-button" data-variant="primary" tabIndex={-1}>
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
                <button type="button" className="ui-button" data-variant="primary" tabIndex={-1}>
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
  const { selectedShaderType, updateSelectedShaderType } = useCanvas();
  const { selectionState, handleShowOriginalChange } = useCanvasActions();

  // Floating label state
  const [floatingLabel, setFloatingLabel] = useState<string | null>(null);
  const floatingLabelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isShaderMixed = !selectionState.hasUniformShader;

  // Show original state for toggle-on-reselect
  const showOriginal = useParamValue("showOriginal", config.defaults.shaderParams.showOriginal);

  const showFloatingLabel = (text: string) => {
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    setFloatingLabel(text);
    floatingLabelTimeoutRef.current = setTimeout(() => {
      setFloatingLabel(null);
    }, config.ui.floatingParamLabelHideTimeoutMs);
  };

  const handleShowOriginalToggle = () => {
    // if mixed, set all to true; otherwise toggle
    const newValue = showOriginal.isMixed ? true : !showOriginal.value;
    handleShowOriginalChange(newValue);
    showFloatingLabel(newValue ? "Show Original On" : "Show Original Off");
  };

  const handleShaderTypeChange = (value: string) => {
    updateSelectedShaderType(value as ShaderType);
    const option = SHADER_TYPE_OPTIONS.find((o) => o.value === value);
    if (option) setFloatingLabel(option.label);
  };

  const handleInteractionStart = () => {
    undo.beginTransaction();
    if (floatingLabelTimeoutRef.current) clearTimeout(floatingLabelTimeoutRef.current);
    if (isShaderMixed) {
      setFloatingLabel("Mixed");
    } else {
      const option = SHADER_TYPE_OPTIONS.find((o) => o.value === selectedShaderType);
      if (option) setFloatingLabel(option.label);
    }
  };

  const handleValueCommit = () => {
    undo.commitTransaction();
    floatingLabelTimeoutRef.current = setTimeout(() => {
      setFloatingLabel(null);
    }, config.ui.floatingParamLabelHideTimeoutMs);
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
                <button type="button" className="ui-button" data-variant="primary" tabIndex={-1}>
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
                <button type="button" className="ui-button" data-variant="primary" tabIndex={-1}>
                  {shaderIconMap[shader.value]()}
                </button>
                <span className="mobile-style-knobs__label">{shader.label}</span>
              </SliderPickerItem>
            ))}
          </SliderPickerOptions>
          <div className="mobile-style-knobs__highlight" aria-hidden="true" />
        </SliderPickerWindow>
      </SliderPicker>

      {/* Shader-specific style picker - only one will render based on selected shader */}
      <MobileDitheringStyleKnobs />
      <MobileAsciiStyleKnobs />
      <MobileGlassStyleKnobs />
      <MobileShapeStyleKnobs />
    </>
  );
}
