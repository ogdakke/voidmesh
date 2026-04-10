import type { ColorPalette, MediaType, PlaybackState, ShaderParams } from "#types/canvas.ts";

export interface StudioManifest {
  type: "studio-canvas";
  version: number;
  createdAt: string;
  viewport: SerializedViewport;
  assets: SerializedAsset[];
  entities: SerializedEntity[];
  palettes?: ColorPalette[];
}

export interface LegacyStudioManifest {
  type: "studio-canvas";
  version: number;
  createdAt: string;
  viewport: SerializedViewport;
  entities: LegacySerializedEntity[];
  palettes?: ColorPalette[];
}

export interface SerializedViewport {
  offset: { x: number; y: number };
  zoom: number;
}

interface SerializedEntityBase {
  id: string;
  assetId: string;
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
  originalPalette?: ColorPalette;
  playback?: SerializedPlaybackState;
}

export interface SerializedEntity extends SerializedEntityBase {}

interface SerializedAssetBase {
  assetId: string;
  mediaType: MediaType;
  mediaFile: string;
  width: number;
  height: number;
}

export interface SerializedImageAsset extends SerializedAssetBase {
  mediaType: "image";
}

export interface SerializedSvgAsset extends SerializedAssetBase {
  mediaType: "svg";
}

export interface SerializedVideoAsset extends SerializedAssetBase {
  mediaType: "video";
  duration: number;
  fps: number | null;
  hasAudio: boolean;
}

export interface SerializedGifAsset extends SerializedAssetBase {
  mediaType: "gif";
  duration: number;
  fps: number;
}

export type SerializedAsset =
  | SerializedImageAsset
  | SerializedSvgAsset
  | SerializedVideoAsset
  | SerializedGifAsset;

interface LegacySerializedEntityBase {
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
  originalPalette?: ColorPalette;
}

export interface LegacySerializedImageEntity extends LegacySerializedEntityBase {
  mediaType: "image";
  mediaFile: string;
}

export interface LegacySerializedVideoEntity extends LegacySerializedEntityBase {
  mediaType: "video";
  mediaFile: string;
  duration: number;
  fps: number | null;
  hasAudio?: boolean;
  playback: SerializedPlaybackState;
}

export interface LegacySerializedGifEntity extends LegacySerializedEntityBase {
  mediaType: "gif";
  mediaFile: string;
  duration: number;
  fps: number;
  playback: SerializedPlaybackState;
}

export interface LegacySerializedSvgEntity extends LegacySerializedEntityBase {
  mediaType: "svg";
  mediaFile: string;
}

export type LegacySerializedEntity =
  | LegacySerializedImageEntity
  | LegacySerializedVideoEntity
  | LegacySerializedGifEntity
  | LegacySerializedSvgEntity;

export interface SerializedPlaybackState {
  currentTime: number;
  loop: boolean;
  playbackRate: number;
  isPlaying?: boolean;
}

export interface DeserializeResult {
  success: boolean;
  entityCount: number;
  warnings: string[];
  errors: { entityId: string; entityName: string; error: string }[];
}

export interface SerializeMediaEntry {
  path: string;
  type: "imageBitmap" | "bytes";
  bitmap?: ImageBitmap;
  bytes?: Uint8Array;
}

export function isStudioManifest(data: unknown): data is StudioManifest | LegacyStudioManifest {
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

export function isSerializedEntity(data: unknown): data is SerializedEntity {
  if (typeof data !== "object" || data === null) return false;
  const e = data as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.assetId === "string" &&
    typeof e.name === "string" &&
    typeof e.shaderType === "string" &&
    typeof e.position === "object" &&
    typeof e.size === "object"
  );
}

export function toPlaybackState(s: SerializedPlaybackState | undefined): PlaybackState {
  return {
    isPlaying: s?.isPlaying ?? false,
    currentTime: s?.currentTime ?? 0,
    loop: s?.loop ?? true,
    playbackRate: s?.playbackRate ?? 1,
  };
}
