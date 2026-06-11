import type { ColorPalette, PlaybackState, ShaderParams } from "#types/canvas.ts";
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

// ============================================================================
// Serialize Worker
// ============================================================================

/** Media data passed between main thread and serialization worker. */
export interface SerializeMediaEntry {
  path: string;
  type: "imageBitmap" | "bytes";
  bitmap?: ImageBitmap;
  bytes?: Uint8Array;
}

// ============================================================================
// Type Guards
// ============================================================================

/** Validate the top-level manifest envelope */
export function isStudioManifest(data: unknown): data is StudioManifest {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    obj.type === "studio-canvas" &&
    typeof obj.version === "number" &&
    Array.isArray(obj.entities) &&
    typeof obj.viewport === "object" &&
    obj.viewport !== null
  );
}

/** Minimal validation that a serialized entity has required fields */
export function isSerializedEntity(data: unknown): data is SerializedEntity {
  if (typeof data !== "object" || data === null) return false;
  const e = data as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.name === "string" &&
    typeof e.mediaType === "string" &&
    typeof e.shaderType === "string" &&
    typeof e.position === "object" &&
    typeof e.size === "object"
  );
}

/** Playback state with safe defaults */
export function toPlaybackState(s: SerializedPlaybackState | undefined): PlaybackState {
  return createPlaybackState(s);
}
