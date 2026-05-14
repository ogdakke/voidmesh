import type { ColorMode } from "#config";
import type { Get, Paths } from "type-fest";
import { createEnum } from ".";

/** 2D point in world coordinates */
export interface Point {
  x: number;
  y: number;
}

/** 2D size */
export interface Size {
  width: number;
  height: number;
}

/** Axis-aligned bounding box in world coordinates */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Viewport state representing the camera position and zoom */
export interface Viewport {
  /** Camera offset in world coordinates (top-left of visible area) */
  offset: Point;
  /** Zoom level (1.0 = 100%, 0.5 = 50%, 2.0 = 200%) */
  zoom: number;
}

export type CanvasCalloutPlacement = "top" | "bottom" | "screen";

export type CanvasCalloutAnchor =
  | {
      type: "entity";
      entityId: string;
      placement: Exclude<CanvasCalloutPlacement, "screen">;
    }
  | {
      type: "screen";
      position: Point;
      align?: "start" | "center";
    };

export interface CanvasCallout {
  id: string;
  text: string;
  anchor: CanvasCalloutAnchor;
  offset?: Point;
}

export const ShaderType = createEnum({
  halftone: "halftone",
  blobs: "blobs",
  melt: "melt",
  dithering: "dithering",
  ascii: "ascii",
  glass: "glass",
  glitch: "glitch",
});
/** Shader types available for entity processing */
export type ShaderType = typeof ShaderType.infer;

/** Glass effect subtypes */
export const GlassKind = createEnum({
  fluted: "fluted",
  frostedVoronoi: "frostedVoronoi",
  flowing: "flowing",
});
/** Glass effect subtype */
export type GlassKind = typeof GlassKind.infer;

export const GLASS_KIND_OPTIONS = [
  { value: GlassKind.fluted, label: "Fluted" },
  { value: GlassKind.frostedVoronoi, label: "Frosted Voronoi" },
  { value: GlassKind.flowing, label: "Flowing" },
];

/** Dithering algorithm types */
export const DitheringKind = createEnum({
  // Ordered dithering (fragment shader - per-pixel)
  bayer2x2: "bayer2x2",
  bayer4x4: "bayer4x4",
  bayer8x8: "bayer8x8",
  whiteNoise: "whiteNoise",
  blueNoise: "blueNoise",
  // Error diffusion (compute shader - sequential)
  floydSteinberg: "floydSteinberg",
  atkinson: "atkinson",
  jarvisJudiceNinke: "jarvisJudiceNinke",
  stucki: "stucki",
  burkes: "burkes",
  sierra: "sierra",
  sierraLite: "sierraLite",
});
/** Dithering algorithm type */
export type DitheringKind = typeof DitheringKind.infer;

/** Error diffusion algorithms that require compute shader */
const ERROR_DIFFUSION_KINDS: readonly DitheringKind[] = [
  DitheringKind.floydSteinberg,
  DitheringKind.atkinson,
  DitheringKind.jarvisJudiceNinke,
  DitheringKind.stucki,
  DitheringKind.burkes,
  DitheringKind.sierra,
  DitheringKind.sierraLite,
] as const;

export const SHADER_TYPE_OPTIONS = [
  { value: ShaderType.halftone, label: "Halftone" },
  { value: ShaderType.blobs, label: "Blobs" },
  { value: ShaderType.melt, label: "Melt" },
  { value: ShaderType.dithering, label: "Dithering" },
  { value: ShaderType.ascii, label: "ASCII" },
  { value: ShaderType.glass, label: "Glass" },
  { value: ShaderType.glitch, label: "Glitch" },
];

/** ASCII character set types */
export const AsciiKind = createEnum({
  standard: "standard",
  extended: "extended",
  binary: "binary",
  minimal: "minimal",
});
/** ASCII character set type */
export type AsciiKind = typeof AsciiKind.infer;

export const ASCII_KIND_OPTIONS = [
  { value: AsciiKind.standard, label: "Standard", chars: " .:-=+*#%@", levels: 10 },
  {
    value: AsciiKind.extended,
    label: "Extended",
    chars: " .:-=+*#%@ILTJYCVXZF7S3EA2GPKDHUR4NB9QWM&01,;!^~_",
    levels: 49,
  },
  { value: AsciiKind.binary, label: "Binary", chars: "01", levels: 2 },
  { value: AsciiKind.minimal, label: "Minimal", chars: " .-+*#", levels: 6 },
];

export const DITHERING_KIND_OPTIONS = [
  { value: DitheringKind.bayer2x2, label: "Bayer 2x2" },
  { value: DitheringKind.bayer4x4, label: "Bayer 4x4" },
  { value: DitheringKind.bayer8x8, label: "Bayer 8x8" },
  { value: DitheringKind.whiteNoise, label: "White Noise" },
  { value: DitheringKind.blueNoise, label: "Blue Noise" },
  { value: DitheringKind.floydSteinberg, label: "Floyd-Steinberg" },
  { value: DitheringKind.atkinson, label: "Atkinson" },
  { value: DitheringKind.jarvisJudiceNinke, label: "Jarvis-Judice-Ninke" },
  { value: DitheringKind.stucki, label: "Stucki" },
  { value: DitheringKind.burkes, label: "Burkes" },
  { value: DitheringKind.sierra, label: "Sierra" },
  { value: DitheringKind.sierraLite, label: "Sierra Lite" },
];

/** Check if a dithering kind requires compute shader (error diffusion) */
export function isErrorDiffusion(kind: DitheringKind): boolean {
  return ERROR_DIFFUSION_KINDS.includes(kind);
}

/** RGBA color as array of 4 numbers normalized to [0-1] */
export type RGBA = [number, number, number, number];

/** Maximum number of colors in a palette */
export const MAX_PALETTE_COLORS = 16;

/** A color palette for dithering */
export interface ColorPalette {
  /** Palette ID - preset ID, "custom" for custom palettes, or undefined */
  id?: string;
  /** Display name for the palette */
  name: string;
  shortName: string;
  /** Array of RGBA colors (2-16 colors) */
  colors: RGBA[];
}

/** Parameters for the dithering shader */
export interface DitheringParams {
  /** Which dithering algorithm to use */
  kind: DitheringKind;
}

/** Parameters for the ASCII shader */
export interface AsciiParams {
  /** Which character set to use */
  kind: AsciiKind;
  /** Invert brightness mapping (light=dense characters) */
  invert: boolean;
}

// ============================================================================
// Post-Processing Effect Types
// ============================================================================

/** Film grain effect parameters */
export interface GrainParams {
  /** Whether grain effect is enabled */
  enabled: boolean;
  /** Grain size (1-10, default: 1) */
  size: number;
  /** Grain intensity (0-1, default: 0.15) */
  intensity: number;
}

/** Bloom/glow effect parameters (multi-pass physically-based bloom) */
export interface BloomParams {
  /** Whether bloom effect is enabled */
  enabled: boolean;
  /**
   * Brightness threshold for bloom extraction (0-1, default: 0.5)
   * - 0 = all pixels contribute to bloom (no filtering)
   * - 1 = only the brightest pixels contribute (very strict)
   */
  threshold: number;
  /** Bloom mix intensity - how much bloom is added (0-1, default: 0.04 for subtle) */
  intensity: number;
  /** Bloom spread (0-100 integer, mapped to UV-space filter radius at renderer boundary) */
  filterRadius: number;
  /**
   * Softness of the threshold transition (0-1, default: 0.1)
   * - 0 = hard cutoff at threshold
   * - Higher values = smoother gradient around threshold
   */
  softness?: number;
}

/** Chromatic aberration effect parameters */
export interface ChromaticAberrationParams {
  /** Whether chromatic aberration effect is enabled */
  enabled: boolean;
  /** RGB channel offset in pixels (0-20, default: 2) */
  offset: number;
}

/** Post-processing effects configuration */
export interface PostProcessParams {
  /** Master enable for post-processing */
  enabled: boolean;
  /** Film grain effect (optional) */
  grain?: GrainParams | null;
  /** Bloom/glow effect (optional) */
  bloom?: BloomParams | null;
  /** Chromatic aberration effect (optional) */
  chromaticAberration?: ChromaticAberrationParams | null;
}

// ============================================================================
// Image/Video Adjustment Types
// ============================================================================

/** Image/video adjustments applied before shader processing */
export interface AdjustmentsParams {
  /** Brightness adjustment (0-1, default: 0.5 = no change) */
  brightness: number;
  /** Contrast adjustment (0-1, default: 0.5 = no change) */
  contrast: number;
  /** Saturation adjustment (0-1, default: 0.5 = no change) */
  saturation: number;
  /** Gaussian blur (0 = no blur, 1 = max blur) */
  blur: number;
}

export const Shape = createEnum({
  circle: "circle",
  square: "square",
  rect_v: "rect_v",
});
/** Shape types for halftone shader */
export type Shape = typeof Shape.infer;

export const SHAPE_OPTIONS = [
  { label: "Circle", value: Shape.circle },
  { label: "Square", value: Shape.square },
  { label: "Vertical Rectangle", value: Shape.rect_v },
];

/** Parameters for the blobs shader */
export interface BlobsParams {
  /** Controls how eagerly adjacent dots merge (0.0 - 1.0, higher = more merging) */
  eagerness: number;
}

/** Parameters for the glass shader (fluted + frosted + flowing subtypes) */
export interface GlassParams {
  /** Glass effect subtype */
  kind: GlassKind;
  /** Fluted: angle of ridges in degrees (0 = vertical, 90 = horizontal) */
  angle: number;
  /** Fluted: caustic brightness strength (0 = off, 1 = default, higher = more pronounced) */
  caustic: number;
  /** Frosted: frost scatter radius (0 = clear glass, 1 = fully frosted) */
  frostiness: number;
  /** Frosted: edge highlight strength (0 = no highlights, 1 = maximum) */
  highlight: number;
  /** Flowing: chromatic channel separation (0 = no rainbow, 1 = full prism) */
  dispersion: number;
  /** Flowing: ridge undulation amount (0 = straight ridges, 1 = very wavy) */
  flow: number;
}

/** Glitch effect subtypes */
export const GlitchKind = createEnum({
  channelShift: "channelShift",
  scanline: "scanline",
  blockCorrupt: "blockCorrupt",
  pixelSmear: "pixelSmear",
});
/** Glitch effect subtype */
export type GlitchKind = typeof GlitchKind.infer;

export const GLITCH_KIND_OPTIONS = [
  { value: GlitchKind.channelShift, label: "Channel Shift" },
  { value: GlitchKind.scanline, label: "Scanline" },
  { value: GlitchKind.blockCorrupt, label: "Block Corrupt" },
  { value: GlitchKind.pixelSmear, label: "Pixel Smear" },
];

/** Parameters for the glitch shader */
export interface GlitchParams {
  /** Which glitch algorithm to use */
  kind: GlitchKind;
  /** Direction angle in degrees (0-360). Used by channelShift and pixelSmear. */
  angle: number;
}

/** Shader parameters for an entity */
export interface ShaderParams {
  size: number;
  shape: Shape;
  /** RGBA color normalized to [0-1] */
  color: [number, number, number, number];
  /** RGBA background color normalized to [0-1] */
  background: [number, number, number, number];
  preserveColors: boolean;
  /** When true, reverses palette order so lightest color becomes background */
  reversePalette: boolean;
  /** When true, bypass all shader processing and show original image/video */
  showOriginal: boolean;
  /** Particle scale factor (0.1 - 3.0). Reusable across shaders. */
  scale: number;
  /** Effect intensity (0.0 - 5.0). Reusable across shaders. */
  intensity: number;
  /** Parameters for the blobs shader (only used when shaderType is 'blobs') */
  blobs?: BlobsParams;
  /** Parameters for the dithering shader (only used when shaderType is 'dithering') */
  dithering?: DitheringParams;
  /** Parameters for the ASCII shader (only used when shaderType is 'ascii') */
  ascii?: AsciiParams;
  /** Parameters for the glass shader (only used when shaderType is 'glass') */
  glass?: GlassParams;
  /** Parameters for the glitch shader (only used when shaderType is 'glitch') */
  glitch?: GlitchParams;
  /** Color palette for multi-color effects (used by all shaders) */
  palette?: ColorPalette;
  /** Post-processing effects (grain, bloom, chromatic aberration) */
  postProcess?: PostProcessParams;
  /** Image/video adjustments (brightness, contrast, saturation) - applied before shaders */
  adjustments?: AdjustmentsParams;
  /** Animation time for time-based shader effects (e.g., flowing glass). Per-entity. */
  time?: number;
  /** Whether time auto-increments during rendering. Per-entity. */
  timeAutoPlay?: boolean;
}

export type ParamPaths = Paths<ShaderParams>;

/**
 * Get a param value by using its dot.notation path
 *
 * @example
 * type Brightness = GetParamByPath<"adjustments.brightness">;
 */
export type GetParamByPath<Path extends ParamPaths> = Get<ShaderParams, Path>;

/** A single decoded GIF frame with timing metadata */
export interface GifFrame {
  bitmap: ImageBitmap;
  /** Frame display duration in milliseconds */
  delay: number;
  /** Cumulative timestamp in milliseconds (for binary search lookup) */
  timestamp: number;
}

export const MediaType = createEnum({
  image: "image",
  video: "video",
  gif: "gif",
  svg: "svg",
});

export type MediaType = typeof MediaType.infer;

export type MediaSourceImage = {
  type: typeof MediaType.image;
  imageBitmap: ImageBitmap;
  /** Original source data for lossless duplication */
  blob: Blob;
};
export type MediaSourceVideo = {
  type: typeof MediaType.video;
  videoElement: HTMLVideoElement;
  /** Original source data for lossless duplication */
  blob: Blob;
  duration: number;
  fps: number | null;
  /** Whether the source video contains an audio track */
  hasAudio: boolean;
};
export type MediaSourceGif = {
  type: typeof MediaType.gif;
  frames: GifFrame[];
  duration: number;
  fps: number;
  /** Original GIF binary data for serialization */
  blob: Blob;
};
export type MediaSourceSvg = {
  type: typeof MediaType.svg;
  /** Original SVG data for lossless serialization */
  blob: Blob;
};

/** Media source for an entity - an image, video, animated GIF, or SVG */
export type MediaSource = MediaSourceImage | MediaSourceVideo | MediaSourceGif | MediaSourceSvg;

/** Video playback state */
export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  loop: boolean;
  playbackRate: number;
}

type ShaderCanvasEntityBase = {
  id: string;
  /** Display name (filename or "Image N") */
  name: string;
  /** Position in world coordinates */
  position: Point;
  /** Size in world coordinates */
  size: Size;
  /** Z-index for layering (higher = on top) */
  zIndex: number;
  /** Rotation in degrees */
  rotation: number;

  /** Source image bitmap (for images: the bitmap, for videos: current frame snapshot) */
  imageBitmap: ImageBitmap;
  /** Original media dimensions (for aspect ratio preservation) */
  originalSize: Size;
  /** Video playback state (only for video entities) */
  playback?: PlaybackState;

  /** Original palette extracted from source image (images only) */
  originalPalette?: ColorPalette;

  /** Shader type to apply */
  shaderType: ShaderType;
  /** Shader parameters */
  shaderParams: ShaderParams;

  /** Cached processed texture (managed by renderer) */
  texture?: GPUTexture;
  /** True when shader params changed and texture needs re-render */
  textureDirty?: boolean;
  /** Whether entity is currently selected */
  selected?: boolean;
  /** Whether entity is locked (cannot be moved) */
  locked?: boolean;

  /** Whether entity has been edited */
  edited: boolean;
};

type ShaderCanvasVideoEntity = ShaderCanvasEntityBase & {
  /** Media source video */
  mediaSource: MediaSourceVideo;
};

type ShaderCanvasImageEntity = ShaderCanvasEntityBase & {
  /** Media source image */
  mediaSource: MediaSourceImage;
};

type ShaderCanvasGifEntity = ShaderCanvasEntityBase & {
  /** Media source GIF */
  mediaSource: MediaSourceGif;
};

type ShaderCanvasSvgEntity = ShaderCanvasEntityBase & {
  /** Media source SVG */
  mediaSource: MediaSourceSvg;
};

/** Animated entity type for type guard return (not in main union) */
type ShaderCanvasAnimatedEntity = ShaderCanvasVideoEntity | ShaderCanvasGifEntity;

/** Entity on the infinite canvas - an image, video, GIF, or SVG with shader processing */
export type ShaderCanvasEntity =
  | ShaderCanvasImageEntity
  | ShaderCanvasVideoEntity
  | ShaderCanvasGifEntity
  | ShaderCanvasSvgEntity;

/** Type guard for video entities */
export function isVideoEntity(entity: ShaderCanvasEntity): entity is ShaderCanvasVideoEntity {
  return entity.mediaSource.type === "video";
}

/** Type guard for GIF entities */
export function isGifEntity(entity: ShaderCanvasEntity): entity is ShaderCanvasGifEntity {
  return entity.mediaSource.type === "gif";
}

/** Type guard for animated entities (video or GIF) */
export function isAnimatedEntity(entity: ShaderCanvasEntity): entity is ShaderCanvasAnimatedEntity {
  return entity.mediaSource.type === "video" || entity.mediaSource.type === "gif";
}

/** Type guard for SVG entities */
export function isSvgEntity(entity: ShaderCanvasEntity): entity is ShaderCanvasSvgEntity {
  return entity.mediaSource.type === "svg";
}

/** Pointer state for tracking drag operations */
export interface PointerState {
  isDown: boolean;
  startPoint: Point | null;
  currentPoint: Point | null;
  button: number;
  modifiers: {
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
    meta: boolean;
  };
}

/** Drag target information */
export interface DragTarget {
  type: DragTargetType;
  entityId?: string;
}

export const DragTargetType = createEnum({
  entity: "entity",
  canvas: "canvas",
  multiSelection: "multiSelection",
});
export type DragTargetType = typeof DragTargetType.infer;

// ============================================================================
// Multi-Selection Types
// ============================================================================

/** Selection state computed from selected entities */
export interface SelectionState {
  entityIds: Set<string>;
  count: number;
  isEmpty: boolean;
  isSingle: boolean;
  isMultiple: boolean;

  // Computed from selected entities
  shaderTypes: Set<ShaderType>;
  hasUniformShader: boolean;
  commonParams: (keyof ShaderParams)[];
  colorMode: ColorMode | "mixed";

  // For specific params, whether all selected have same value
  paramValues: {
    [K in keyof ShaderParams]?: {
      isUniform: boolean;
      value: ShaderParams[K] | null; // null if mixed
      values: Set<ShaderParams[K]>; // all distinct values
    };
  };
}

/** For UI components to know what selection mode they're in */
export type SelectionMode = "none" | "single" | "multiple";
