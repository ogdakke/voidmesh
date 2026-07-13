import { gzipSync, gunzipSync } from "fflate";
import type {
  ColorPalette,
  PlaybackState,
  ShaderCanvasEntity,
  ShaderParams,
  ShaderType,
  MediaPreview,
} from "#types/canvas.ts";
import { isMediaPreview } from "#lib/thumbhash.ts";

export const COLLABORATION_PROTOCOL_VERSION = 3;
export const COLLABORATION_INVITE_PREFIX = "collab";

export interface CollaborationInvite {
  version: typeof COLLABORATION_PROTOCOL_VERSION;
  roomId: string;
  password: string;
}

export interface CollaborativeAssetDescriptor {
  transferId: string;
  hash?: string;
  mimeType: string;
  byteLength: number;
  filename: string;
  preview: MediaPreview;
}

export interface CollaborativeEntity {
  id: string;
  name: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  originalSize: { width: number; height: number };
  zIndex: number;
  rotation: number;
  locked: boolean;
  edited: boolean;
  shaderType: ShaderType;
  shaderParams: ShaderParams;
  originalPalette?: ColorPalette;
  playback?: PlaybackState;
  playbackDuration?: number;
  playbackCommandId?: string;
  asset: CollaborativeAssetDescriptor;
}

export type AssetCompression = "identity" | "gzip";

export interface PreparedAssetPayload {
  bytes: Uint8Array;
  compression: AssetCompression;
  originalByteLength: number;
  transmittedByteLength: number;
}

export interface ReceivedAssetMetadata extends Omit<
  CollaborativeAssetDescriptor,
  "hash" | "preview"
> {
  hash: string;
  compression: AssetCompression;
  originalByteLength: number;
  protocolVersion: number;
}

const COMPRESSIBLE_MIME_TYPES = new Set(["image/svg+xml", "application/json"]);

export function createCollaborationInvite(): CollaborationInvite {
  return {
    version: COLLABORATION_PROTOCOL_VERSION,
    roomId: randomBase64Url(16),
    password: randomBase64Url(32),
  };
}

export function createCollaborationInviteUrl(
  invite: CollaborationInvite,
  source: string | URL,
): string {
  const url = new URL(source);
  url.hash = `${COLLABORATION_INVITE_PREFIX}=v${invite.version}.${invite.roomId}.${invite.password}`;
  return url.toString();
}

export function parseCollaborationInvite(source: string | URL): CollaborationInvite | null {
  const url = new URL(source);
  const match = url.hash.match(/^#collab=v(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!match) return null;

  const version = Number(match[1]);
  if (version !== COLLABORATION_PROTOCOL_VERSION) return null;
  const roomId = match[2]!;
  const password = match[3]!;
  if (decodeBase64Url(roomId).byteLength !== 16) return null;
  if (decodeBase64Url(password).byteLength !== 32) return null;

  return { version, roomId, password };
}

export function clearCollaborationInvite(source: string | URL): string {
  const url = new URL(source);
  if (url.hash.startsWith(`#${COLLABORATION_INVITE_PREFIX}=`)) url.hash = "";
  return url.toString();
}

export async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return bytesToBase64Url(new Uint8Array(digest));
}

export function getEntityAssetBlob(entity: ShaderCanvasEntity): Blob {
  return entity.mediaSource.type === "image"
    ? entity.mediaSource.asset.blob
    : entity.mediaSource.blob;
}

export function createCollaborativeEntity(
  entity: ShaderCanvasEntity,
  asset: CollaborativeAssetDescriptor,
): CollaborativeEntity {
  return {
    id: entity.id,
    name: entity.name,
    position: { ...entity.position },
    size: { ...entity.size },
    originalSize: { ...entity.originalSize },
    zIndex: entity.zIndex,
    rotation: entity.rotation,
    locked: entity.locked ?? false,
    edited: entity.edited,
    shaderType: entity.shaderType,
    shaderParams: structuredClone(entity.shaderParams),
    ...(entity.originalPalette && { originalPalette: structuredClone(entity.originalPalette) }),
    ...(entity.playback && { playback: { ...entity.playback } }),
    ...(entity.playback && { playbackDuration: getEntityPlaybackDuration(entity) }),
    asset,
  };
}

export function getEntityPlaybackDuration(entity: ShaderCanvasEntity): number {
  if (entity.mediaSource.type === "video" || entity.mediaSource.type === "gif") {
    return entity.mediaSource.duration;
  }
  return 0;
}

export async function prepareAssetPayload(
  blob: Blob,
  mimeType: string,
): Promise<PreparedAssetPayload> {
  const source = new Uint8Array(await blob.arrayBuffer());
  if (!COMPRESSIBLE_MIME_TYPES.has(mimeType)) {
    return {
      bytes: source,
      compression: "identity",
      originalByteLength: source.byteLength,
      transmittedByteLength: source.byteLength,
    };
  }

  const compressed = await gzipBytes(source);
  if (compressed.byteLength >= source.byteLength) {
    return {
      bytes: source,
      compression: "identity",
      originalByteLength: source.byteLength,
      transmittedByteLength: source.byteLength,
    };
  }

  return {
    bytes: compressed,
    compression: "gzip",
    originalByteLength: source.byteLength,
    transmittedByteLength: compressed.byteLength,
  };
}

export async function restoreAssetPayload(
  payload: ArrayBuffer | Uint8Array,
  metadata: ReceivedAssetMetadata,
): Promise<Blob> {
  if (metadata.protocolVersion !== COLLABORATION_PROTOCOL_VERSION) {
    throw new Error(`Unsupported collaboration protocol v${metadata.protocolVersion}`);
  }
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const restored = metadata.compression === "gzip" ? await gunzipBytes(bytes) : bytes;
  if (restored.byteLength !== metadata.originalByteLength) {
    throw new Error(
      `Asset length mismatch: expected ${metadata.originalByteLength}, received ${restored.byteLength}`,
    );
  }
  return new Blob([new Uint8Array(restored).buffer], { type: metadata.mimeType });
}

export function isReceivedAssetMetadata(value: unknown): value is ReceivedAssetMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<ReceivedAssetMetadata>;
  return (
    typeof metadata.hash === "string" &&
    metadata.hash.length > 0 &&
    typeof metadata.transferId === "string" &&
    metadata.transferId.length > 0 &&
    typeof metadata.mimeType === "string" &&
    typeof metadata.byteLength === "number" &&
    Number.isSafeInteger(metadata.byteLength) &&
    metadata.byteLength >= 0 &&
    typeof metadata.filename === "string" &&
    (metadata.compression === "identity" || metadata.compression === "gzip") &&
    typeof metadata.originalByteLength === "number" &&
    Number.isSafeInteger(metadata.originalByteLength) &&
    metadata.originalByteLength >= 0 &&
    metadata.protocolVersion === COLLABORATION_PROTOCOL_VERSION
  );
}

export function isCollaborativeAssetDescriptor(
  value: unknown,
): value is CollaborativeAssetDescriptor {
  if (!value || typeof value !== "object") return false;
  const asset = value as Partial<CollaborativeAssetDescriptor>;
  return (
    typeof asset.transferId === "string" &&
    asset.transferId.length > 0 &&
    (asset.hash === undefined || (typeof asset.hash === "string" && asset.hash.length > 0)) &&
    typeof asset.mimeType === "string" &&
    asset.mimeType.length > 0 &&
    typeof asset.byteLength === "number" &&
    Number.isSafeInteger(asset.byteLength) &&
    asset.byteLength >= 0 &&
    typeof asset.filename === "string" &&
    isMediaPreview(asset.preview)
  );
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return Promise.resolve(gzipSync(bytes));
}

function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return Promise.resolve(gunzipSync(bytes));
}
