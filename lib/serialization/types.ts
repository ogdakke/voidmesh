import type {
  ColorPalette,
  PlaybackState,
  ShaderCanvasEntity,
  ShaderParams,
  Viewport,
} from "#types/canvas.ts";
import { createPlaybackState } from "#lib/media-playback.ts";

// ============================================================================
// Document Envelope
// ============================================================================

/** Top-level manifest stored as manifest.json inside a .studio zip archive */
export interface StudioManifest {
  /** Format identifier */
  type: "studio-canvas";
  /** Schema version (integer, monotonically increasing) */
  version: number;
  /** ISO 8601 timestamp of when this document was created */
  createdAt: string;
  /** Viewport state at time of save */
  viewport: SerializedViewport;
  /** All entities on the canvas, sorted by zIndex */
  entities: SerializedEntity[];
  /** Custom/extracted palettes referenced by entities (v4+) */
  palettes?: ColorPalette[];
}

// ============================================================================
// Viewport
// ============================================================================

export interface SerializedViewport {
  offset: { x: number; y: number };
  zoom: number;
}

// ============================================================================
// Entity (discriminated union on mediaType)
// ============================================================================

export type SerializedEntity =
  | SerializedImageEntity
  | SerializedVideoEntity
  | SerializedGifEntity
  | SerializedSvgEntity;

interface SerializedEntityBase {
  id: string;
  name: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  originalSize: { width: number; height: number };
  zIndex: number;
  rotation: number;
  locked: boolean;
  edited: boolean;
  /** MIME type of the exact bytes stored at mediaFile (v6+) */
  mimeType?: string;
  /** Base64 ThumbHash of the entity's image or first frame (v7+) */
  thumbhash?: string;
  shaderType: string;
  shaderParams: ShaderParams;
  /** Palette extracted from source image (v4+) */
  originalPalette?: ColorPalette;
}

export interface SerializedImageEntity extends SerializedEntityBase {
  mediaType: "image";
  /** Path to the image file inside the zip archive */
  mediaFile: string;
}

export interface SerializedVideoEntity extends SerializedEntityBase {
  mediaType: "video";
  /** Path to the video file inside the zip archive */
  mediaFile: string;
  /** Original video duration in seconds */
  duration: number;
  /** Detected frame rate (null if unknown) */
  fps: number | null;
  /** Whether the source video contains an audio track (added in v3) */
  hasAudio: boolean;
  /** Playback state at time of save */
  playback: SerializedPlaybackState;
}

export interface SerializedGifEntity extends SerializedEntityBase {
  mediaType: "gif";
  /** Path to the GIF file inside the zip archive */
  mediaFile: string;
  /** Total duration in seconds */
  duration: number;
  /** Average frames per second */
  fps: number;
  /** Playback state at time of save */
  playback: SerializedPlaybackState;
}

export interface SerializedSvgEntity extends SerializedEntityBase {
  mediaType: "svg";
  /** Path to the SVG file inside the zip archive */
  mediaFile: string;
}

/** Playback state for serialization */
export interface SerializedPlaybackState {
  currentTime: number;
  loop: boolean;
  playbackRate: number;
  muted?: boolean;
  volume?: number;
  isPlaying?: boolean;
}

// ============================================================================
// Deserialization Result
// ============================================================================

export interface DeserializeResult {
  success: boolean;
  entityCount: number;
  maxEntityId: number;
  maxZIndex: number;
  warnings: string[];
  errors: { entityId: string; entityName: string; error: string }[];
}

export type DeserializeStage =
  | "reading"
  | "unzipping"
  | "parsing"
  | "decoding"
  | "restoring"
  | "done";

export interface DeserializeProgress {
  stage: DeserializeStage;
  entityIndex?: number;
  entityCount?: number;
  entityName?: string;
  fileSizeBytes?: number;
}

export interface DeserializeOptions {
  signal?: AbortSignal;
  onProgress?: (progress: DeserializeProgress) => void;
}

/** Decoded workspace whose media ownership remains staged until adopt succeeds. */
export interface DecodedWorkspace {
  readonly palettes: readonly ColorPalette[];
  adopt(
    replaceWorkspace: (entities: readonly ShaderCanvasEntity[], viewport: Viewport) => void,
  ): readonly ShaderCanvasEntity[];
}

export type CommitDecodedWorkspace = (workspace: DecodedWorkspace) => void;

// ============================================================================
// Serialize Worker
// ============================================================================

/** Media data passed between main thread and serialization worker. */
export interface SerializeMediaEntry {
  path: string;
  bytes: Uint8Array;
}

// ============================================================================
// Type Guards
// ============================================================================

/** Validate the top-level manifest envelope */
export function isStudioManifest(data: unknown): data is StudioManifest {
  if (!isRecord(data)) return false;
  const obj = data;
  const requiresMimeType = typeof obj.version === "number" && obj.version >= 6;
  return (
    obj.type === "studio-canvas" &&
    isFiniteNumber(obj.version) &&
    Number.isInteger(obj.version) &&
    obj.version >= 1 &&
    typeof obj.createdAt === "string" &&
    isSerializedViewport(obj.viewport) &&
    Array.isArray(obj.entities) &&
    obj.entities.every((entity) => isSerializedEntity(entity, requiresMimeType)) &&
    (obj.palettes === undefined ||
      (Array.isArray(obj.palettes) && obj.palettes.every(isColorPalette)))
  );
}

/** Validate fields consumed synchronously while an entity is decoded and indexed. */
export function isSerializedEntity(
  data: unknown,
  requireMimeType = false,
): data is SerializedEntity {
  if (!isRecord(data)) return false;
  const e = data;
  const validBase =
    typeof e.id === "string" &&
    e.id.length > 0 &&
    typeof e.name === "string" &&
    typeof e.shaderType === "string" &&
    isPoint(e.position) &&
    isSize(e.size) &&
    isSize(e.originalSize) &&
    isFiniteNumber(e.zIndex) &&
    isFiniteNumber(e.rotation) &&
    typeof e.locked === "boolean" &&
    typeof e.edited === "boolean" &&
    isRecord(e.shaderParams) &&
    (e.thumbhash === undefined || isValidThumbhash(e.thumbhash)) &&
    (e.originalPalette === undefined || isColorPalette(e.originalPalette));
  if (
    !validBase ||
    typeof e.mediaFile !== "string" ||
    e.mediaFile.length === 0 ||
    (requireMimeType && (typeof e.mimeType !== "string" || e.mimeType.length === 0)) ||
    (e.mimeType !== undefined && (typeof e.mimeType !== "string" || e.mimeType.length === 0))
  ) {
    return false;
  }

  switch (e.mediaType) {
    case "image":
      return e.mimeType === undefined || e.mimeType.startsWith("image/");
    case "svg":
      return e.mimeType === undefined || e.mimeType === "image/svg+xml";
    case "video":
      return (
        (e.mimeType === undefined || e.mimeType.startsWith("video/")) &&
        isNonNegativeNumber(e.duration) &&
        (e.fps === null || (isFiniteNumber(e.fps) && e.fps > 0)) &&
        (e.hasAudio === undefined || typeof e.hasAudio === "boolean") &&
        isSerializedPlaybackState(e.playback)
      );
    case "gif":
      return (
        (e.mimeType === undefined || e.mimeType === "image/gif") &&
        isNonNegativeNumber(e.duration) &&
        isFiniteNumber(e.fps) &&
        e.fps > 0 &&
        isSerializedPlaybackState(e.playback)
      );
    default:
      return false;
  }
}

function isValidThumbhash(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return bytes.byteLength > 0 && bytes.byteLength <= 128;
  } catch {
    return false;
  }
}

function isSerializedViewport(value: unknown): value is SerializedViewport {
  return isRecord(value) && isPoint(value.offset) && isFiniteNumber(value.zoom) && value.zoom > 0;
}

function isSerializedPlaybackState(value: unknown): value is SerializedPlaybackState {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    (value.currentTime === undefined || isNonNegativeNumber(value.currentTime)) &&
    (value.loop === undefined || typeof value.loop === "boolean") &&
    (value.playbackRate === undefined ||
      (isFiniteNumber(value.playbackRate) && value.playbackRate > 0)) &&
    (value.muted === undefined || typeof value.muted === "boolean") &&
    (value.volume === undefined ||
      (isFiniteNumber(value.volume) && value.volume >= 0 && value.volume <= 1)) &&
    (value.isPlaying === undefined || typeof value.isPlaying === "boolean")
  );
}

function isColorPalette(value: unknown): value is ColorPalette {
  if (!isRecord(value)) return false;
  return (
    (value.id === undefined || typeof value.id === "string") &&
    typeof value.name === "string" &&
    typeof value.shortName === "string" &&
    Array.isArray(value.colors) &&
    value.colors.length >= 2 &&
    value.colors.length <= 16 &&
    value.colors.every(isRgba)
  );
}

function isRgba(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((channel) => isFiniteNumber(channel) && channel >= 0 && channel <= 1)
  );
}

function isPoint(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isSize(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.width) &&
    value.width > 0 &&
    isFiniteNumber(value.height) &&
    value.height > 0
  );
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Playback state with safe defaults */
export function toPlaybackState(s: SerializedPlaybackState | undefined): PlaybackState {
  return createPlaybackState(s);
}
