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
  /** Deduplicated static shader parameter records (v6+) */
  shaderParamsTable?: ShaderParams[];
  /** Deduplicated archive media paths (v6+) */
  mediaFiles?: string[];
  /** Deduplicated original palettes referenced by entities (v6+) */
  originalPalettes?: ColorPalette[];
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
  /** Inline shader parameters used by legacy manifests. */
  shaderParams?: ShaderParams;
  /** Index into StudioManifest.shaderParamsTable (v6+). */
  shaderParamsRef?: number;
  /** Per-entity animated fields excluded from the static parameter table. */
  shaderTime?: number;
  shaderTimeAutoPlay?: boolean;
  /** Palette extracted from source image (v4+) */
  originalPalette?: ColorPalette;
  /** Index into StudioManifest.originalPalettes (v6+). */
  originalPaletteRef?: number;
  /** Inline archive path used by legacy manifests. */
  mediaFile?: string;
  /** Index into StudioManifest.mediaFiles (v6+). */
  mediaFileRef?: number;
}

export interface SerializedImageEntity extends SerializedEntityBase {
  mediaType: "image";
}

export interface SerializedVideoEntity extends SerializedEntityBase {
  mediaType: "video";
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
  /** Total duration in seconds */
  duration: number;
  /** Average frames per second */
  fps: number;
  /** Playback state at time of save */
  playback: SerializedPlaybackState;
}

export interface SerializedSvgEntity extends SerializedEntityBase {
  mediaType: "svg";
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
  type: "imageBitmap" | "bytes";
  bitmap?: ImageBitmap;
  bytes?: Uint8Array;
}

// ============================================================================
// Type Guards
// ============================================================================

/** Validate the top-level manifest envelope */
export function isStudioManifest(data: unknown): data is StudioManifest {
  return validateStudioManifest(data) !== null;
}

export interface StudioManifestValidation {
  manifest: StudioManifest;
  duplicateEntityId: string | null;
  videoEntityCount: number;
  mediaFileUseCounts: Map<string, number>;
}

/** Validate entity records while collecting import metadata in the same pass. */
export function validateStudioManifest(data: unknown): StudioManifestValidation | null {
  if (!isRecord(data)) return null;
  const obj = data;
  const validEnvelope =
    obj.type === "studio-canvas" &&
    isFiniteNumber(obj.version) &&
    Number.isInteger(obj.version) &&
    obj.version >= 1 &&
    typeof obj.createdAt === "string" &&
    isSerializedViewport(obj.viewport) &&
    Array.isArray(obj.entities) &&
    (obj.shaderParamsTable === undefined ||
      (Array.isArray(obj.shaderParamsTable) && obj.shaderParamsTable.every(isRecord))) &&
    (obj.mediaFiles === undefined ||
      (Array.isArray(obj.mediaFiles) &&
        obj.mediaFiles.every((value) => typeof value === "string" && value.length > 0))) &&
    (obj.originalPalettes === undefined ||
      (Array.isArray(obj.originalPalettes) && obj.originalPalettes.every(isColorPalette))) &&
    (obj.palettes === undefined ||
      (Array.isArray(obj.palettes) && obj.palettes.every(isColorPalette)));
  if (!validEnvelope) return null;

  const shaderParamsCount = Array.isArray(obj.shaderParamsTable)
    ? obj.shaderParamsTable.length
    : undefined;
  const mediaFileCount = Array.isArray(obj.mediaFiles) ? obj.mediaFiles.length : undefined;
  const originalPaletteCount = Array.isArray(obj.originalPalettes)
    ? obj.originalPalettes.length
    : undefined;
  const seenEntityIds = new Set<string>();
  let duplicateEntityId: string | null = null;
  let videoEntityCount = 0;
  const mediaFileUseCounts = new Map<string, number>();
  for (const entity of obj.entities as unknown[]) {
    if (!isSerializedEntity(entity, shaderParamsCount, mediaFileCount, originalPaletteCount)) {
      return null;
    }
    if (duplicateEntityId === null && seenEntityIds.has(entity.id)) {
      duplicateEntityId = entity.id;
    }
    seenEntityIds.add(entity.id);
    if (entity.mediaType === "video") videoEntityCount++;
    const mediaFile =
      entity.mediaFile ??
      (entity.mediaFileRef === undefined
        ? undefined
        : (obj.mediaFiles as string[] | undefined)?.[entity.mediaFileRef]);
    if (mediaFile) {
      mediaFileUseCounts.set(mediaFile, (mediaFileUseCounts.get(mediaFile) ?? 0) + 1);
    }
  }

  return {
    manifest: obj as unknown as StudioManifest,
    duplicateEntityId,
    videoEntityCount,
    mediaFileUseCounts,
  };
}

/** Validate fields consumed synchronously while an entity is decoded and indexed. */
export function isSerializedEntity(
  data: unknown,
  shaderParamsCount?: number,
  mediaFileCount?: number,
  originalPaletteCount?: number,
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
    ((isRecord(e.shaderParams) && e.shaderParamsRef === undefined) ||
      (e.shaderParams === undefined &&
        isValidTableIndex(e.shaderParamsRef, shaderParamsCount) &&
        (e.shaderTime === undefined || isFiniteNumber(e.shaderTime)) &&
        (e.shaderTimeAutoPlay === undefined || typeof e.shaderTimeAutoPlay === "boolean"))) &&
    ((e.originalPalette === undefined && e.originalPaletteRef === undefined) ||
      (isColorPalette(e.originalPalette) && e.originalPaletteRef === undefined) ||
      (e.originalPalette === undefined &&
        isValidTableIndex(e.originalPaletteRef, originalPaletteCount))) &&
    ((typeof e.mediaFile === "string" && e.mediaFile.length > 0 && e.mediaFileRef === undefined) ||
      (e.mediaFile === undefined && isValidTableIndex(e.mediaFileRef, mediaFileCount)));
  if (!validBase) return false;

  switch (e.mediaType) {
    case "image":
    case "svg":
      return true;
    case "video":
      return (
        isNonNegativeNumber(e.duration) &&
        (e.fps === null || (isFiniteNumber(e.fps) && e.fps > 0)) &&
        (e.hasAudio === undefined || typeof e.hasAudio === "boolean") &&
        isSerializedPlaybackState(e.playback)
      );
    case "gif":
      return (
        isNonNegativeNumber(e.duration) &&
        isFiniteNumber(e.fps) &&
        e.fps > 0 &&
        isSerializedPlaybackState(e.playback)
      );
    default:
      return false;
  }
}

function isValidTableIndex(value: unknown, length: number | undefined): value is number {
  return (
    length !== undefined &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < length
  );
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
