const MAX_COORDINATE = 100_000_000;

type JsonObject = { [key: string]: JsonValue };
type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string;

export interface ArchiveViewport {
  offset: { x: number; y: number };
  zoom: number;
}

export interface HostedArchiveAsset {
  byteLength: number;
  contentType: string;
  id: string;
  mediaType: "gif" | "image" | "svg" | "video";
  originalFilename: string;
}

export interface HostedArchiveEntity {
  asset: HostedArchiveAsset;
  edited: boolean;
  fps?: number | null;
  hasAudio?: boolean;
  id: string;
  locked: boolean;
  name: string;
  originalPalette?: JsonObject;
  originalSize: { height: number; width: number };
  playback?: ArchivePlaybackState;
  playbackDuration?: number;
  position: { x: number; y: number };
  rotation: number;
  shaderParams: JsonObject;
  shaderType: string;
  size: { height: number; width: number };
  zIndex: number;
}

export interface ArchivePlaybackState {
  currentTime: number;
  isPlaying: boolean;
  loop: boolean;
  muted: boolean;
  playbackRate: number;
  volume: number;
}

export interface VdmshManifest {
  createdAt: string;
  entities: VdmshEntity[];
  type: "studio-canvas";
  version: 6;
  viewport: ArchiveViewport;
}

export type VdmshEntity = Record<string, unknown> & {
  id: string;
  mediaFile: string;
  mediaType: HostedArchiveAsset["mediaType"];
};

export function readHostedArchiveEntities(
  snapshot: unknown,
  now = Date.now(),
): HostedArchiveEntity[] {
  if (
    !isRecord(snapshot) ||
    !Array.isArray(snapshot.entities) ||
    !Array.isArray(snapshot.playback)
  ) {
    throw new Error("Invalid hosted workspace snapshot");
  }
  const playback = new Map<string, Record<string, unknown>>();
  for (const anchor of snapshot.playback) {
    if (isRecord(anchor) && isIdentifier(anchor.entityId)) playback.set(anchor.entityId, anchor);
  }
  const result: HostedArchiveEntity[] = [];
  for (const value of snapshot.entities) {
    const entity = readEntity(value, playback.get(isRecord(value) ? String(value.id) : ""), now);
    if (!entity) throw new Error("Invalid hosted workspace entity");
    result.push(entity);
  }
  return result.sort(
    (left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id),
  );
}

export function createVdmshManifest(
  entities: readonly HostedArchiveEntity[],
  viewport: ArchiveViewport,
  createdAt = new Date().toISOString(),
): VdmshManifest {
  if (!isViewport(viewport)) throw new Error("Invalid archive viewport");
  return {
    createdAt,
    entities: entities.map(toVdmshEntity),
    type: "studio-canvas",
    version: 6,
    viewport: clone(viewport),
  };
}

export function archiveMediaPath(asset: HostedArchiveAsset): string {
  const extension = mediaExtension(asset);
  return `media/assets/${encodeURIComponent(asset.id)}.${extension}`;
}

function toVdmshEntity(entity: HostedArchiveEntity): VdmshEntity {
  const { time, timeAutoPlay, ...staticShaderParams } = entity.shaderParams;
  const base = {
    edited: entity.edited,
    id: entity.id,
    locked: entity.locked,
    mediaFile: archiveMediaPath(entity.asset),
    mediaType: entity.asset.mediaType,
    name: entity.name,
    ...(entity.originalPalette && {
      originalPalette: clone(entity.originalPalette),
    }),
    originalSize: clone(entity.originalSize),
    position: clone(entity.position),
    rotation: entity.rotation,
    shaderParams: staticShaderParams,
    ...(typeof time === "number" && { shaderTime: time }),
    ...(typeof timeAutoPlay === "boolean" && {
      shaderTimeAutoPlay: timeAutoPlay,
    }),
    shaderType: entity.shaderType,
    size: clone(entity.size),
    zIndex: entity.zIndex,
  };
  if (entity.asset.mediaType === "video") {
    return {
      ...base,
      duration: entity.playbackDuration ?? 0,
      fps: entity.fps ?? null,
      hasAudio: entity.hasAudio ?? false,
      playback: entity.playback,
    };
  }
  if (entity.asset.mediaType === "gif") {
    return {
      ...base,
      duration: entity.playbackDuration ?? 0,
      // Documents created before media metadata was persisted have no FPS.
      // One frame per second keeps those archives valid and importable.
      fps: entity.fps && entity.fps > 0 ? entity.fps : 1,
      playback: entity.playback,
    };
  }
  return base;
}

function readEntity(
  value: unknown,
  playback: Record<string, unknown> | undefined,
  now: number,
): HostedArchiveEntity | null {
  if (!isRecord(value)) return null;
  const {
    asset,
    edited,
    fps,
    hasAudio,
    id,
    locked,
    name,
    originalPalette,
    originalSize,
    playbackDuration,
    position,
    rotation,
    shaderParams,
    shaderType,
    size,
    zIndex,
  } = value;
  if (
    !isIdentifier(id) ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 1_024 ||
    typeof locked !== "boolean" ||
    typeof edited !== "boolean" ||
    !isPoint(position) ||
    !isSize(size) ||
    !isSize(originalSize) ||
    !isFiniteNumber(rotation) ||
    !isFiniteNumber(zIndex) ||
    typeof shaderType !== "string" ||
    shaderType.length === 0 ||
    !isJsonObject(shaderParams) ||
    !isAsset(asset) ||
    (originalPalette !== undefined && !isJsonObject(originalPalette)) ||
    (fps !== undefined && fps !== null && (!isFiniteNumber(fps) || fps <= 0)) ||
    (hasAudio !== undefined && typeof hasAudio !== "boolean") ||
    (playbackDuration !== undefined && (!isFiniteNumber(playbackDuration) || playbackDuration < 0))
  ) {
    return null;
  }
  const nextShaderParams = clone(shaderParams);
  if (isShaderPlaybackAnchor(playback)) {
    nextShaderParams.time = advanceShaderPlayback(playback, now);
    nextShaderParams.timeAutoPlay = playback.state === "playing";
  }
  const playbackState = isMediaPlaybackAnchor(playback)
    ? advancePlayback(playback, now)
    : undefined;
  return {
    asset,
    edited,
    ...(fps !== undefined && { fps }),
    ...(hasAudio !== undefined && { hasAudio }),
    id,
    locked,
    name,
    ...(originalPalette && { originalPalette }),
    originalSize,
    ...(playbackState && {
      playback: playbackState,
      playbackDuration: playback!.duration as number,
    }),
    position,
    rotation,
    shaderParams: nextShaderParams,
    shaderType,
    size,
    zIndex,
  };
}

interface MediaPlaybackAnchor {
  duration: number;
  effectiveAtRoomMs: number;
  loop: boolean;
  playbackRate: number;
  positionSeconds: number;
  state: "paused" | "playing";
  type: "media";
}

interface ShaderPlaybackAnchor {
  effectiveAtRoomMs: number;
  shaderTime: number;
  state: "paused" | "playing";
  type: "shader";
}

function advancePlayback(anchor: MediaPlaybackAnchor, now: number): ArchivePlaybackState {
  let currentTime = anchor.positionSeconds;
  let isPlaying = anchor.state === "playing";
  if (isPlaying) {
    currentTime += (Math.max(0, now - anchor.effectiveAtRoomMs) * anchor.playbackRate) / 1_000;
  }
  if (anchor.duration > 0 && anchor.loop) currentTime %= anchor.duration;
  else if (anchor.duration > 0 && currentTime >= anchor.duration) {
    currentTime = anchor.duration;
    isPlaying = false;
  }
  return {
    currentTime,
    isPlaying,
    loop: anchor.loop,
    muted: true,
    playbackRate: anchor.playbackRate,
    volume: 1,
  };
}

function advanceShaderPlayback(anchor: ShaderPlaybackAnchor, now: number): number {
  return anchor.state === "playing"
    ? anchor.shaderTime + Math.max(0, now - anchor.effectiveAtRoomMs) / 1_000
    : anchor.shaderTime;
}

function isAsset(value: unknown): value is HostedArchiveAsset {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(value.id) &&
    Number.isSafeInteger(value.byteLength) &&
    (value.byteLength as number) >= 0 &&
    typeof value.contentType === "string" &&
    value.contentType.length > 0 &&
    (value.mediaType === "gif" ||
      value.mediaType === "image" ||
      value.mediaType === "svg" ||
      value.mediaType === "video") &&
    typeof value.originalFilename === "string" &&
    value.originalFilename.length <= 1_024
  );
}

function isMediaPlaybackAnchor(value: unknown): value is MediaPlaybackAnchor {
  return (
    isRecord(value) &&
    value.type === "media" &&
    isFiniteNumber(value.duration) &&
    value.duration >= 0 &&
    isFiniteNumber(value.effectiveAtRoomMs) &&
    typeof value.loop === "boolean" &&
    isFiniteNumber(value.playbackRate) &&
    value.playbackRate > 0 &&
    isFiniteNumber(value.positionSeconds) &&
    value.positionSeconds >= 0 &&
    (value.state === "paused" || value.state === "playing")
  );
}

function isShaderPlaybackAnchor(value: unknown): value is ShaderPlaybackAnchor {
  return (
    isRecord(value) &&
    value.type === "shader" &&
    isFiniteNumber(value.effectiveAtRoomMs) &&
    isFiniteNumber(value.shaderTime) &&
    (value.state === "paused" || value.state === "playing")
  );
}

function isViewport(value: ArchiveViewport): boolean {
  return isPoint(value.offset) && isFiniteNumber(value.zoom) && value.zoom > 0;
}

function isPoint(value: unknown): value is { x: number; y: number } {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    Math.abs(value.x) <= MAX_COORDINATE &&
    isFiniteNumber(value.y) &&
    Math.abs(value.y) <= MAX_COORDINATE
  );
}

function isSize(value: unknown): value is { height: number; width: number } {
  return (
    isRecord(value) &&
    isFiniteNumber(value.width) &&
    value.width > 0 &&
    value.width <= MAX_COORDINATE &&
    isFiniteNumber(value.height) &&
    value.height > 0 &&
    value.height <= MAX_COORDINATE
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isBoundedJson(value);
}

function isBoundedJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 4_096;
  if (Array.isArray(value)) {
    return value.length <= 128 && value.every((entry) => isBoundedJson(entry, depth + 1));
  }
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 128 && entries.every(([, entry]) => isBoundedJson(entry, depth + 1));
}

function mediaExtension(asset: HostedArchiveAsset): string {
  const fromName = asset.originalFilename.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  if (fromName) return fromName.toLowerCase();
  const byContentType: Record<string, string> = {
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
  };
  return byContentType[asset.contentType.toLowerCase()] ?? "bin";
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
