import {
  type ShaderParams,
  type PostProcessParams,
  type AdjustmentsParams,
  type ParamPaths,
  DitheringKind,
  AsciiKind,
  Shape,
  type Viewport,
  ShaderType,
  type RGBA,
  type ColorMode,
  type ViewportLensDistortionConfig,
  GlassKind,
  GlitchKind,
} from "#types/canvas.ts";
import type { PartialDeep } from "type-fest";
import type { easings } from "../canvas-math";
import { palettes } from "./palettes.config";
import { DecelerationRate } from "../touch-scroll";
import { type ActionLayerConfig, actionLayerDefaults } from "./action-layer.config";
import type { MinimapConfig } from "#renderer/canvas-renderer.ts";
import { CanvasLensing } from "#types/enums.ts";

// ============================================================================
// Shader Feature Definitions (for multi-select param intersection)
// ============================================================================

/** Color mode determines which color UI to show */
/** Defines which parameters a shader supports */
export interface ShaderFeature {
  /** Parameters this shader uses (intersection computed for multi-select) */
  params: readonly (keyof ShaderParams)[];
  /** Which color mode the shader uses */
  colorMode: ColorMode;
}

/** Feature definitions for each shader type */
export const shaderFeatures: Record<ShaderType, ShaderFeature> = {
  dithering: {
    // 'scale' visibility is conditional on algorithm — see paramVisibilityRules
    params: [
      "size",
      "intensity",
      "scale",
      "preserveColors",
      "reversePalette",
      "showOriginal",
      "dithering",
      "palette",
      "adjustments",
      "postProcess",
    ] as const,
    colorMode: "palette",
  },
  halftone: {
    params: [
      "size",
      "intensity",
      "shape",
      "scale",
      "preserveColors",
      "reversePalette",
      "showOriginal",
      "palette",
      "adjustments",
      "postProcess",
    ] as const,
    colorMode: "palette",
  },
  melt: {
    params: [
      "size",
      "intensity",
      "shape",
      "scale",
      "preserveColors",
      "reversePalette",
      "showOriginal",
      "palette",
      "adjustments",
      "postProcess",
    ] as const,
    colorMode: "palette",
  },
  blobs: {
    params: [
      "size",
      "intensity",
      "shape",
      "scale",
      "preserveColors",
      "reversePalette",
      "showOriginal",
      "palette",
      "adjustments",
      "postProcess",
      "blobs",
    ] as const satisfies (keyof ShaderParams)[],
    colorMode: "palette",
  },
  glass: {
    params: [
      "size",
      "intensity",
      "scale",
      "showOriginal",
      "glass",
      "time",
      "adjustments",
      "postProcess",
    ] as const,
    colorMode: "palette",
  },
  ascii: {
    params: [
      "size",
      "intensity",
      "scale",
      "preserveColors",
      "reversePalette",
      "showOriginal",
      "ascii",
      "palette",
      "adjustments",
      "postProcess",
    ] as const,
    colorMode: "palette",
  },
  glitch: {
    params: [
      "size",
      "intensity",
      "scale",
      "preserveColors",
      "reversePalette",
      "showOriginal",
      "glitch",
      "palette",
      "adjustments",
      "postProcess",
    ] as const,
    colorMode: "palette",
  },
};

// ============================================================================
// Shader Sensible Defaults (applied when switching shader types)
// ============================================================================

/** Configuration for per-shader sensible defaults */
export interface ShaderDefaultsConfig {
  /** Params that MUST be reset for optimal appearance (forced overrides) */
  resetParams: PartialDeep<ShaderParams>;
  /** Params to use if entity doesn't have them set (fills in missing only) */
  mergeParams: PartialDeep<ShaderParams>;
}

/** Per-shader defaults applied when switching TO a shader type */
export const shaderDefaults: Record<ShaderType, ShaderDefaultsConfig> = {
  dithering: {
    resetParams: { size: 1, preserveColors: false, adjustments: { blur: 0 } },
    mergeParams: { dithering: { kind: DitheringKind.bayer8x8 } },
  },
  halftone: {
    resetParams: { size: 10, shape: Shape.circle, scale: 1.0, adjustments: { blur: 0 } },
    mergeParams: {},
  },
  blobs: {
    resetParams: {
      size: 10,
      blobs: { eagerness: 0.4 },
      scale: 0.5,
      intensity: 0.5,
      shape: Shape.circle,
      preserveColors: true,
      adjustments: { blur: 0 },
    },
    mergeParams: {},
  },
  melt: {
    resetParams: { size: 8, shape: Shape.rect_v, scale: 2.0, adjustments: { blur: 0 } },
    mergeParams: {},
  },
  ascii: {
    resetParams: { size: 12, scale: 1.0, adjustments: { blur: 0 } },
    mergeParams: { ascii: { kind: AsciiKind.standard, invert: false } },
  },
  glass: {
    resetParams: {
      size: 6,
      intensity: 1.0,
      scale: 1.0,
      postProcess: { enabled: true, chromaticAberration: { enabled: true, offset: 6 } },
      glass: { angle: 0, caustic: 0.1 },
      adjustments: {
        blur: 3,
      },
    },
    mergeParams: {
      glass: { angle: 0, caustic: 0.1 },
    },
  },
  glitch: {
    resetParams: {
      size: 25,
      intensity: 1,
      scale: 1.0,
      preserveColors: true,
      adjustments: { blur: 0 },
    },
    mergeParams: {
      glitch: { kind: GlitchKind.channelShift, angle: 0 },
    },
  },
};

/**
 * Per-glass-kind param resets applied when switching glass sub-types.
 * Every kind must specify all tunable params (size, intensity, scale, blur)
 * to ensure clean resets when switching between kinds.
 */
export const glassKindResets: Record<GlassKind, PartialDeep<ShaderParams>> = {
  [GlassKind.fluted]: { size: 20, intensity: 1, scale: 1, adjustments: { blur: 5 } },
  [GlassKind.frostedVoronoi]: { size: 6, intensity: 1, scale: 1, adjustments: { blur: 3 } },
  [GlassKind.flowing]: { size: 40, intensity: 4, scale: 1.55, adjustments: { blur: 0 } },
};

/**
 * Per-glitch-kind param resets applied when switching glitch sub-types.
 * Every kind must specify all tunable params (size, intensity, scale)
 * to ensure clean resets when switching between kinds.
 */
export const glitchKindResets: Record<GlitchKind, PartialDeep<ShaderParams>> = {
  [GlitchKind.channelShift]: { size: 25, intensity: 1, scale: 1 },
  [GlitchKind.blockCorrupt]: { size: 8, intensity: 2, scale: 1 },
  [GlitchKind.pixelSmear]: { size: 50, intensity: 2, scale: 1 },
  [GlitchKind.scanline]: { size: 3, intensity: 1, scale: 1 },
};

/** Error diffusion algorithms do NOT support scale parameter */
export const errorDiffusionAlgorithms: readonly DitheringKind[] = [
  DitheringKind.floydSteinberg,
  DitheringKind.atkinson,
  DitheringKind.jarvisJudiceNinke,
  DitheringKind.stucki,
  DitheringKind.burkes,
  DitheringKind.sierra,
  DitheringKind.sierraLite,
] as const;

/** Check if a dithering algorithm supports the scale parameter */
export function isDitheringWithScale(kind: DitheringKind): boolean {
  return !errorDiffusionAlgorithms.includes(kind);
}

/** Compute intersection of features for multiple shader types (for multi-select UI) */
export function getCommonFeatures(shaderTypes: ShaderType[]): {
  params: (keyof ShaderParams)[];
  colorMode: ColorMode | "mixed";
} {
  if (shaderTypes.length === 0) return { params: [], colorMode: "mixed" };

  const firstType = shaderTypes[0];
  if (!firstType) return { params: [], colorMode: "mixed" };

  if (shaderTypes.length === 1) {
    const feature = shaderFeatures[firstType];
    return { params: [...feature.params], colorMode: feature.colorMode };
  }

  // Use Set.intersection() for cleaner param intersection
  const paramSets = shaderTypes.map((t) => new Set(shaderFeatures[t].params));
  const intersection = paramSets.reduce((acc, set) => acc.intersection(set));

  const colorModes = new Set(shaderTypes.map((t) => shaderFeatures[t].colorMode));
  const firstColorMode = colorModes.values().next().value;
  const colorMode: ColorMode | "mixed" =
    colorModes.size === 1 && firstColorMode ? firstColorMode : "mixed";

  return { params: [...intersection], colorMode };
}

// ============================================================================
// Conditional Param Visibility Rules
// ============================================================================

/**
 * Conditional param visibility rules per shader type.
 *
 * When a rule exists for (shaderType, paramPath), `isSupported` is only true
 * if the rule's `isVisible` returns true for that entity's params.
 *
 * This handles cases where param support depends on sub-type state
 * (e.g., dithering scale depends on algorithm kind, glass sub-params
 * depend on glass kind).
 */
export const paramVisibilityRules: Partial<
  Record<ShaderType, { param: ParamPaths; isVisible: (params: ShaderParams) => boolean }[]>
> = {
  dithering: [
    {
      param: "scale",
      isVisible: (p) => !p.dithering?.kind || isDitheringWithScale(p.dithering.kind),
    },
  ],
  glass: [
    { param: "glass.angle", isVisible: (p) => p.glass?.kind === GlassKind.fluted },
    { param: "glass.caustic", isVisible: (p) => p.glass?.kind === GlassKind.fluted },
    { param: "glass.frostiness", isVisible: (p) => p.glass?.kind === GlassKind.frostedVoronoi },
    { param: "glass.highlight", isVisible: (p) => p.glass?.kind === GlassKind.frostedVoronoi },
    { param: "glass.flow", isVisible: (p) => p.glass?.kind === GlassKind.flowing },
    { param: "time", isVisible: (p) => p.glass?.kind === GlassKind.flowing },
  ],
  glitch: [
    {
      param: "glitch.angle",
      isVisible: (p) =>
        p.glitch?.kind === GlitchKind.channelShift || p.glitch?.kind === GlitchKind.pixelSmear,
    },
    {
      param: "scale",
      isVisible: (p) => p.glitch?.kind !== GlitchKind.channelShift,
    },
  ],
};

// Uniform buffer sizes (16-byte aligned)
const GRID_UNIFORM_SIZE = 64; // resolution(8) + offset(8) + zoom(4) + gridSize(4) + dotSize(4) + padding(4) + bgColor(16) + dotColor(16)
const VIEWPORT_UNIFORM_SIZE = 64; // matrix(48) + resolution(8) + padding(8)
const ENTITY_UNIFORM_SIZE = 48; // position(8) + size(8) + rotation(4) + reserved(4) + isSelected(4) + padding(8)
const HALFTONE_UNIFORM_SIZE = 304; // Matches the shared palette layout
// Dithering uniform buffer (extended for palette support):
// Base (32 bytes) + palette metadata(16) + palette[16](256) = 304 bytes
const DITHERING_UNIFORM_SIZE = 304;
// Adjustments (pre-processing) uniform buffer:
// resolution(8) + brightness(4) + contrast(4) + saturation(4) + padding(12) = 32 bytes
const ADJUSTMENTS_UNIFORM_SIZE = 32;
// Dual Kawase blur uniform buffer:
// src/dst_resolution(8) + offset(4) + padding(4) = 16 bytes
const BLUR_UNIFORM_SIZE = 16;
// Post-process uniform buffer:
// resolution(8) + grain_size(4) + grain_intensity(4) + bloom_threshold(4) + bloom_intensity(4) +
// bloom_radius(4) + chromatic_offset(4) + enabled_flags(4) + time(4) + padding(24) = 64 bytes
const POST_PROCESS_UNIFORM_SIZE = 64;

export interface GridConfig {
  gridSize: number;
  dotSize: number;
  backgroundColor: [number, number, number, number];
  dotColor: [number, number, number, number];
}

/** Configuration for drag visual feedback (spring scale animation) */
export interface DragVisualSpringConfig {
  /** Spring response time in seconds */
  response: number;
  /** Damping ratio (0-1, where higher = less bounce) */
  damping: number;
}

/** Configuration for drag visual feedback (spring scale animation) */
export interface DragVisualConfig {
  /** Delay in ms before scale-down animation starts */
  possibleDragDelay: number;
  /** Target scale during possible-drag phase (e.g., 0.95 = 5% shrink) */
  scaleDown: number;
  /** Spring preset for the scale-down animation */
  scaleDownSpring: DragVisualSpringConfig;
  /** Spring preset for the pop-back to normal size */
  popBackSpring: DragVisualSpringConfig;
  /** Spring preset for the release animation */
  releaseSpring: DragVisualSpringConfig;
}

/** Configuration for touch gesture sensitivity and momentum */
export interface TouchConfig {
  /** Multiplier for live panning speed */
  panSensitivity: number;
  /** Multiplier for momentum velocity */
  velocityScale: number;
  /** Minimum velocity to trigger momentum in px/ms */
  velocityThreshold: number;
  /** Maximum velocity for momentum fling in px/ms (caps sharp flicks) */
  maxVelocity: number;
  /** Deceleration rate for momentum, 0-1 where higher = longer glide */
  decelerationRate: number;
  /** Duration in ms to hold before entering entity drag mode */
  longPressDelay: number;
  /** Max screen-pixel movement allowed during the hold period */
  longPressMoveThreshold: number;
  /** Time window in ms for detecting double-tap gestures */
  doubleTapWindow: number;
  /** Visual feedback for entity drag gestures */
  dragVisual: DragVisualConfig;
  /** Zoom momentum settings (pinch-fling) */
  zoomMomentum: {
    /** Minimum velocity to trigger zoom momentum (log-space units/ms) */
    velocityThreshold: number;
    /** Maximum velocity for zoom momentum (log-space units/ms, caps sharp pinch flicks) */
    maxVelocity: number;
    /** Deceleration rate for zoom momentum, 0-1 where higher = longer glide */
    decelerationRate: number;
    /** Multiplier applied to raw zoom velocity before fling */
    velocityScale: number;
    /** Spring-back response time in seconds (lower = snappier bounce at zoom bounds) */
    springResponse: number;
  };
  /** Double-tap + hold + drag zoom settings (iOS Maps-style one-finger zoom) */
  doubleTapHoldZoom: {
    /** Log-zoom change per CSS pixel of vertical finger movement */
    sensitivity: number;
    /** Min vertical movement in px to activate zoom mode (distinguish from hold-still) */
    activationThreshold: number;
  };
}

export interface AlphaHitTestingConfig {
  /** Enables alpha-aware entity picking for pointer/touch hit tests. */
  enabled: boolean;
  /** Source-media pixel size of each alpha occupancy cell. */
  cellSizePx: number;
  /** Pixel alpha byte threshold. Values above this are counted as opaque. */
  alphaThreshold: number;
  /** Minimum opaque-pixel coverage for a cell to receive hits. */
  coverageThreshold: number;
  /** Renders the derived cell grid over entities. */
  debug: boolean;
  /** Avoids accidental debug rendering explosions on very large media. */
  debugMaxCellsPerEntity: number;
}

export const DEFAULT_GRID_CONFIG: GridConfig = {
  gridSize: 25,
  dotSize: 1.5,
  backgroundColor: [0.98, 0.98, 0.98, 1], // Light gray background
  dotColor: [0.75, 0.75, 0.75, 1], // Subtle gray dots (#BFBFBF)
};

export const DEFAULT_GRID_CONFIG_DARK: GridConfig = {
  ...DEFAULT_GRID_CONFIG,
  backgroundColor: [0.023, 0.023, 0.03, 1],
  dotColor: [0.15, 0.15, 0.15, 1],
};

const DEFAULT_MAX_STORAGE_BUFFER_SIZE_BYTES = 128 * 1024 * 1024; // 128 MiB
const SELECTION_BORDER_COLOR = [59 / 255, 130 / 255, 246 / 255, 1] satisfies RGBA;
/** application config */
export const config = {
  ui: {
    floatingParamLabelHideTimeoutMs: 800,
  },
  /** Selection rectangle styling for drag-to-select (themed) */
  selectionRectangle: {
    light: {
      borderColor: SELECTION_BORDER_COLOR,
      backgroundColor: [0, 0.1, 1, 0.15] satisfies RGBA,
      borderWidth: 2,
    },
    dark: {
      borderColor: SELECTION_BORDER_COLOR,
      backgroundColor: [59 / 255, 130 / 255, 246 / 255, 0.25] satisfies RGBA,
      borderWidth: 2,
    },
  },
  /** Multi-select bounding box styling (border only, no fill, themed) */
  multiSelectBoundingBox: {
    light: {
      borderColor: SELECTION_BORDER_COLOR,
      backgroundColor: [0, 0, 0, 0] satisfies RGBA,
      borderWidth: 2,
    },
    dark: {
      borderColor: SELECTION_BORDER_COLOR,
      backgroundColor: [0, 0, 0, 0] satisfies RGBA,
      borderWidth: 2,
    },
  },
  rendering: {
    gridUniformSize: GRID_UNIFORM_SIZE,
    viewportUniformSize: VIEWPORT_UNIFORM_SIZE,
    entityUniformSize: ENTITY_UNIFORM_SIZE,
    halftoneUniformSize: HALFTONE_UNIFORM_SIZE,
    ditheringUniformSize: DITHERING_UNIFORM_SIZE,
    postProcessUniformSize: POST_PROCESS_UNIFORM_SIZE,
    adjustmentsUniformSize: ADJUSTMENTS_UNIFORM_SIZE,
    blurUniformSize: BLUR_UNIFORM_SIZE,
    maxStorageBufferSizeBytes: DEFAULT_MAX_STORAGE_BUFFER_SIZE_BYTES,
    /** Persistent source + processed entity texture budget. Visible textures stay pinned. */
    entityTextureBudgetBytes: 512 * 1024 * 1024,
    /** Maximum idle scratch memory retained by TexturePool across dimensions/usages. */
    texturePoolBudgetBytes: 64 * 1024 * 1024,
    /** Persistent dimension-keyed blur and bloom texture budget. */
    processingTextureBudgetBytes: 128 * 1024 * 1024,
    /** Quantized maximum dimensions for static-image viewport rendering. */
    imageLodTiers: [64, 128, 256, 512, 1024, 2048, 4096] as const,
    /** Extra physical pixels retained around the projected size before promotion. */
    imageLodOverscan: 1.25,
    /** Unchanged rendered frames required before LOD convergence begins. */
    lodSettleFrames: 2,
    /** Maximum source/processed dimension changes admitted in one settled frame. */
    lodTransitionsPerFrame: 4,
    /** Maximum target pixels admitted per settled frame (one oversized item may progress). */
    lodTransitionPixelBudget: 2 * 1024 * 1024,
    /** Minimum visible fraction required when admitting or rebuilding a full-scene batch. */
    fullSceneBatchMinVisibleFraction: 0.25,
    grid: {
      default: DEFAULT_GRID_CONFIG,
      dark: DEFAULT_GRID_CONFIG_DARK,
    },
  },
  canvas: {
    /** Viewport culling buffer as fraction of viewport size (0.1 = 10% margin on each side) */
    cullingBufferFraction: 0.1,
    // /** Zoom constraints */
    minZoom: 0.01,
    maxZoom: 10,
    staggerMultiplier: 60,
    /** Maximum deletion batch that may allocate per-entity disintegration snapshots. */
    fancyDeleteMaxBatchSize: 32,
    /** Gap between entities in layout (world pixels). Equals SNAP_GRID_SIZE (1 snap cell). */
    layoutGap: 125,
    /** Maximum columns in grid layout */
    maxGridColumns: 4,
    /** Mobile layout insets (CSS pixels) */
    mobile: {
      /** Bottom inset: mobile controls (160) + bottom bar (48) + spacing (8) */
      bottomInset: 180,
    },
    fitToViewPadding: 0.1, // 10% padding around fit-to-view bounds
    /** Viewport animation settings */
    animation: {
      /** Default easing: 'easeOutCubic' */
      easing: "easeOutCubic" as const satisfies keyof typeof easings,
      /** Duration for zoom reset (ms) */
      zoomResetDuration: 250,
      /** Duration for centering canvas (ms) */
      centerCanvasDuration: 300,
      /** Duration for fit-to-view (ms) */
      fitToViewDuration: 300,
    },
    lens: {
      subtle: {
        enabled: true,
        strength: 0.4,
        radius: 0.07,
        falloff: 1.8,
        dispersion: 0.25,
        scale: 1,
        reflectionIntensity: 0.23,
        reflectionFocus: 0.87,
        occlusion: 0.04,
        vignetteLight: 0.16,
        vignetteDark: 0.32,
      } satisfies ViewportLensDistortionConfig,
      extreme: {
        enabled: true,
        strength: 0.35,
        radius: 0.33,
        falloff: 3.55,
        dispersion: 0.65,
        scale: 4,
        reflectionIntensity: 0.16,
        reflectionFocus: 0,
        occlusion: 0.03,
        vignetteLight: 0.22,
        vignetteDark: 0,
      } satisfies ViewportLensDistortionConfig,
    },
    minimap: {
      enabled: true,
      width: 160,
      height: 120,
      borderRadius: 32,
      margin: 8,
      worldPaddingScale: 1,
      dragSensitivity: 0.42,
      backdropScale: 0.75,
      backdropBlur: 0,
      mapOpacity: 0.1,
      mapTint: [1, 1, 0.96],
      entityOpacity: 0.66,
      entityColor: [0.88, 0.88, 0.86],
      strength: 4,
      edgeWidth: 1.2,
      falloff: 10,
      dispersion: 1.3,
      scale: 1,
      reflectionIntensity: 0.56,
      reflectionFocus: 0.45,
      occlusion: 0.14,
      vignette: 0,
    } satisfies MinimapConfig,
  },
  hitTesting: {
    alphaGrid: {
      enabled: true,
      cellSizePx: 16,
      alphaThreshold: 8,
      coverageThreshold: 0.01,
      debug: false,
      debugMaxCellsPerEntity: 20_000,
    } satisfies AlphaHitTestingConfig,
  },
  supports: {
    /** Supported video MIME types */
    video: [
      "video/mp4",
      "video/mpeg",
      "video/webm",
      "video/ogg",
      "video/quicktime",
      // TODO: .mkv is kinda laggy sometimes, at least for 4k videos
      "video/matroska",
    ],
    /** Supported image MIME types */
    image: ["image/*"],
  },
  defaults: {
    viewport: {
      offset: { x: 0, y: 0 },
      zoom: 1,
    } satisfies Viewport,
    shader: ShaderType.dithering,
    shaderParams: {
      size: 1,
      shape: Shape.circle,
      // rgb(33 150 243)
      color: [33 / 255, 150 / 255, 243 / 255, 1],
      background: [0, 0, 0, 1],
      preserveColors: false,
      reversePalette: false,
      showOriginal: false,
      scale: 1.0,
      intensity: 1.0,
      blobs: { eagerness: 0.5 },
      dithering: { kind: DitheringKind.bayer8x8 },
      ascii: { kind: AsciiKind.standard, invert: false },
      glass: {
        angle: 0,
        caustic: 1.0,
        frostiness: 0.8,
        highlight: 0.1,
        dispersion: 0.6,
        flow: 0.5,
        kind: GlassKind.frostedVoronoi,
      },
      glitch: {
        kind: GlitchKind.channelShift,
        angle: 0,
      },
      palette: palettes.blackAndWhite,
      postProcess: {
        enabled: true,
        grain: { enabled: true, size: 1, intensity: 0.12 },
        bloom: {
          enabled: true,
          threshold: 0.5,
          intensity: 0.15,
          filterRadius: 21,
          softness: 0.1,
        },
        chromaticAberration: { enabled: false, offset: 2 },
      } satisfies PostProcessParams,
      adjustments: {
        brightness: 0.5,
        contrast: 0.5,
        saturation: 0.5,
        blur: 0,
      } satisfies AdjustmentsParams,
      time: 0,
      timeAutoPlay: true,
    } satisfies ShaderParams,
    paletteDefaults: {
      newPaletteColor: [0.5, 0.5, 0.65, 1] satisfies RGBA,
    },
  },
  palettes,

  /**
   * Async palette preset IDs - these are extracted from entity images
   * and not available as static presets
   */
  asyncPalettes: ["original"] as const,

  /**
   * ID used for custom palettes (uploaded or manually edited).
   * Not a preset - signals that palette colors should be serialized to URL.
   */
  customPaletteId: "custom" as const,

  /** Prefixes for user-created palette IDs */
  paletteIdPrefix: {
    custom: "cstm_" as const,
    extracted: "ext_" as const,
  },

  postProcessing: {
    grain: {
      size: { min: 1, max: 10, step: 1 },
      intensity: { min: 0, max: 1, step: 0.01 },
    },
    bloom: {
      threshold: { min: 0, max: 1, step: 0.01 },
      intensity: { min: 0, max: 1, step: 0.01 },
      filterRadius: { min: 0, max: 100, step: 1, renderer: { min: 0.001, max: 0.03 } },
      softness: { min: 0, max: 1, step: 0.01 },
    },
    chromaticAberration: {
      offset: { min: 0, max: 10, step: 1 },
    },
  },
  adjustments: {
    brightness: { min: 0, max: 1, step: 0.01, default: 0.5 },
    contrast: { min: 0, max: 1, step: 0.01, default: 0.5 },
    saturation: { min: 0, max: 1, step: 0.01, default: 0.5 },
    blur: { min: 0, max: 60, step: 0.1, default: 0 },
  },
  shaderParams: {
    size: { min: 1, max: 100, step: 1, default: 1 },
    intensity: { min: 0, max: 5, step: 0.01, default: 1 },
    scale: { min: 0.1, max: 3, step: 0.01, default: 1 },
    eagerness: { min: 0, max: 1, step: 0.01, default: 0.5 },
    angle: { min: 0, max: 360, step: 1, default: 0 },
    caustic: { min: 0, max: 2, step: 0.01, default: 1 },
    frostiness: { min: 0, max: 1, step: 0.01, default: 0.8 },
    highlight: { min: 0, max: 1, step: 0.01, default: 0.1 },
    dispersion: { min: 0, max: 1, step: 0.01, default: 0.6 },
    flow: { min: 0, max: 1, step: 0.01, default: 0.5 },
    time: { min: 0, max: 0, step: 1, default: 0 },
  },
  touch: {
    /**
     * Multiplier for live panning speed (default: 1.5)
     *
     * @deprecated use DPR instead
     */
    panSensitivity: 1.75,
    /**
     * Multiplier for momentum velocity (default: 1.5)
     *
     * @deprecated use DPR instead
     */
    velocityScale: 1.0,
    /** Minimum velocity to trigger momentum in px/ms (default: 0.05) */
    velocityThreshold: 0.05,
    /** Maximum velocity for momentum fling in px/ms */
    maxVelocity: 2.2,
    /** Deceleration rate for momentum, 0-1 where higher = longer glide */
    decelerationRate: DecelerationRate.REASONABLE,
    /** Duration in ms to hold before entering entity drag mode (default: 400) */
    longPressDelay: 400,
    /** Max screen-pixel movement allowed during the hold period (default: 10) */
    longPressMoveThreshold: 10,
    /** Time window in ms for detecting double-tap gestures (default: 300) */
    doubleTapWindow: 250,
    dragVisual: {
      possibleDragDelay: 100,
      scaleDown: 0.95,
      scaleDownSpring: {
        response: 0.2,
        damping: 0.94,
      },
      popBackSpring: {
        response: 0.22,
        damping: 0.4,
      },
      releaseSpring: {
        response: 0.3,
        damping: 0.7,
      },
    },
    zoomMomentum: {
      velocityThreshold: 0.0001,
      maxVelocity: 0.008,
      decelerationRate: 0.993,
      velocityScale: 1.0,
      springResponse: 0.25,
    },
    doubleTapHoldZoom: {
      sensitivity: 0.007, // ~100px vertical movement ≈ 2x zoom change
      activationThreshold: 5, // 5px before zoom activates
    },
  },
  imageExporting: {
    quality: {
      png: 1,
      jpeg: 0.92,
    },
  },
  videoExporting: {
    defaults: {
      fps: 30,
      /** Base bitrate for 1080p (1920×1080) - scales with resolution */
      bitrateBase1080p: 25_000_000, // 25 Mbps (increased from 15 for better quality)
    },
    /** H.264 High Profile @ Level 5.2 - better compression than Main Profile */
    codec: "avc1.640034" as const,
    /** MP4 industry standard timescale (90kHz) */
    mp4Timescale: 90000,
    /** Insert keyframe every N seconds */
    keyFrameIntervalSeconds: 2,
    hardwareAcceleration: "prefer-hardware" as const,
    latencyMode: "quality" as const,
    /** Constant bitrate for more predictable quality */
    bitrateMode: "constant" as const,
    /** UI control ranges for export settings */
    ui: {
      fps: { min: 1, max: 60, step: 1 },
      gifFps: { min: 1, max: 30, step: 1 },
      gifMaxWidth: { min: 100, max: 1920, step: 10 },
      bitrate: { min: 1000, max: 50000, step: 100 }, // kbps
    },
  },
  actionLayer: actionLayerDefaults,
};

export type { ActionLayerConfig };

/** Reference resolution for bitrate scaling (1920×1080 = 2,073,600 pixels) */
const PIXELS_1080P = 1920 * 1080;

/**
 * Calculate video bitrate based on resolution (scales from 1080p baseline)
 *
 * Examples:
 * - 720p (1280×720): ~6.7 Mbps
 * - 1080p (1920×1080): 15 Mbps
 * - 1440p (2560×1440): ~26.7 Mbps
 * - 4K (3840×2160): ~60 Mbps
 */
export function calculateVideoBitrate(width: number, height: number): number {
  const pixelCount = width * height;
  const scale = pixelCount / PIXELS_1080P;
  return Math.round(config.videoExporting.defaults.bitrateBase1080p * scale);
}

/**
 * Select H.264 High Profile codec string with appropriate level for the resolution/fps.
 * Lower levels are more reliably hardware-decoded on iOS devices.
 */
export function getH264Codec(width: number, height: number, fps: number): string {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbPerSec = macroblocks * fps;

  // Level 4.1: up to 8192 MBs, 245760 MB/s (covers 1080p@30fps)
  if (macroblocks <= 8192 && mbPerSec <= 245760) return "avc1.640029";
  // Level 5.0: up to 22080 MBs, 589824 MB/s (covers ~2560x1920@30fps)
  if (macroblocks <= 22080 && mbPerSec <= 589824) return "avc1.640032";
  // Level 5.1: up to 36864 MBs, 983040 MB/s (covers 4K@30fps)
  if (macroblocks <= 36864 && mbPerSec <= 983040) return "avc1.640033";
  // Level 5.2: fallback for extreme resolutions (4K@60fps+)
  return config.videoExporting.codec;
}

/** Convert bloom filterRadius from canonical 0-100 integer to renderer UV-space value */
export function bloomFilterRadiusToRenderer(value: number): number {
  const { min, max } = config.postProcessing.bloom.filterRadius.renderer;
  return min + (value / 100) * (max - min);
}

/** Maximum number of Dual Kawase blur levels (downsample + upsample) */
export const MAX_BLUR_MIP_LEVELS = 8;

/** Parameters for Dual Kawase blur with cross-level blending support */
export interface KawaseBlurParams {
  levelsLow: number; // Lower level count (fewer passes)
  levelsHigh: number; // Higher level count (may equal levelsLow when not blending)
  offsetLow: number; // Per-pass offset for low-level blur (0-0.5)
  offsetHigh: number; // Per-pass offset for high-level blur (0-0.5)
  blendFactor: number; // 0 = pure levelsLow, 1 = pure levelsHigh
}

/** Fraction of each segment width used for cross-level blending (0-1) */
const BLUR_BLEND_ZONE_FRACTION = 0.3;

/**
 * Convert blur slider value (0-60) to Dual Kawase parameters with
 * cross-level blending for smooth transitions at breakpoint boundaries.
 *
 * The blur radius grows exponentially with each level (each level doubles
 * the effective radius). Near breakpoint boundaries, returns two level counts
 * and a blend factor so the renderer can interpolate between them, preventing
 * visible stepping artifacts when dragging the slider.
 */
export function blurParamToKawaseParams(value: number): KawaseBlurParams {
  const zero: KawaseBlurParams = {
    levelsLow: 0,
    levelsHigh: 0,
    offsetLow: 0,
    offsetHigh: 0,
    blendFactor: 0,
  };
  if (value <= 0.001) return zero;

  // Piecewise-linear mapping: each range maps to one level.
  // Ranges grow wider at higher values because each additional
  // level doubles the blur radius (exponential growth).
  const breakpoints = [0.3, 2, 6, 14, 24, 36, 48, 60];

  for (let i = 0; i < breakpoints.length; i++) {
    const lo = i === 0 ? 0 : breakpoints[i - 1]!;
    const hi = breakpoints[i]!;
    if (value <= hi) {
      const t = (value - lo) / (hi - lo); // 0-1 position within segment
      const level = i + 1;
      const isLastSegment = i === breakpoints.length - 1;
      const blendZoneStart = 1 - BLUR_BLEND_ZONE_FRACTION;

      if (t < blendZoneStart || isLastSegment) {
        // Pure single-level zone (or last segment with no next level)
        const range = isLastSegment ? 1 : blendZoneStart;
        const offset = (t / range) * 0.5;
        return {
          levelsLow: level,
          levelsHigh: level,
          offsetLow: offset,
          offsetHigh: offset,
          blendFactor: 0,
        };
      }

      // Blend zone: crossfade from current level to next level
      const blendT = Math.min(1, (t - blendZoneStart) / BLUR_BLEND_ZONE_FRACTION);
      return {
        levelsLow: level,
        levelsHigh: level + 1,
        offsetLow: 0.5, // max offset pushes low level toward high
        offsetHigh: 0, // min offset for the new level
        blendFactor: blendT,
      };
    }
  }

  return {
    levelsLow: MAX_BLUR_MIP_LEVELS,
    levelsHigh: MAX_BLUR_MIP_LEVELS,
    offsetLow: 0.5,
    offsetHigh: 0.5,
    blendFactor: 0,
  };
}

export function getViewportLensDistortionConfig(
  canvasLensing: CanvasLensing,
): ViewportLensDistortionConfig {
  if (canvasLensing === CanvasLensing.subtle)
    return { ...config.canvas.lens.subtle, enabled: true };
  if (canvasLensing === CanvasLensing.extreme)
    return { ...config.canvas.lens.extreme, enabled: true };
  return { ...config.canvas.lens.subtle, enabled: false };
}

export function getMiniMapConfig({ enabled }: { enabled: boolean }): MinimapConfig {
  return {
    ...config.canvas.minimap,
    enabled,
  };
}
