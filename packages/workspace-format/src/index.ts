import * as Y from "yjs";

const PARAM_PREFIX = "appearance.params.";
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
  document: Y.Doc,
  now = Date.now(),
): HostedArchiveEntity[] {
  const entities = document.getMap<Y.Map<unknown>>("entities");
  const result: HostedArchiveEntity[] = [];
  for (const [id, map] of entities) {
    const entity = readEntity(id, map, now);
    if (!entity) throw new Error(`Invalid hosted workspace entity: ${id}`);
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

function readEntity(id: string, map: Y.Map<unknown>, now: number): HostedArchiveEntity | null {
  const name = map.get("identity.name");
  const locked = map.get("identity.locked");
  const edited = map.get("identity.edited");
  const originalPalette = map.get("identity.originalPalette");
  const position = {
    x: map.get("geometry.position.x"),
    y: map.get("geometry.position.y"),
  };
  const size = {
    height: map.get("geometry.size.height"),
    width: map.get("geometry.size.width"),
  };
  const originalSize = {
    height: map.get("geometry.originalSize.height"),
    width: map.get("geometry.originalSize.width"),
  };
  const rotation = map.get("geometry.rotation");
  const zIndex = map.get("geometry.zIndex");
  const shaderType = map.get("appearance.shaderType");
  const shaderParams = readFlatRecord(map);
  const asset = map.get("asset");
  const playback = map.get("playback");
  const shaderPlayback = map.get("appearance.shaderPlayback");
  const fps = map.get("media.fps");
  const hasAudio = map.get("media.hasAudio");
  if (
    !isIdentifier(id) ||
    typeof name !== "string" ||
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
    (playback !== undefined && !isPlaybackAnchor(playback)) ||
    (shaderPlayback !== undefined && !isShaderPlaybackAnchor(shaderPlayback)) ||
    (fps !== undefined && fps !== null && (!isFiniteNumber(fps) || fps <= 0)) ||
    (hasAudio !== undefined && typeof hasAudio !== "boolean")
  ) {
    return null;
  }
  if (shaderPlayback) {
    shaderParams.time = advanceShaderPlayback(shaderPlayback, now);
    shaderParams.timeAutoPlay = shaderPlayback.isPlaying;
  }
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
    ...(playback && {
      playback: advancePlayback(playback, now),
      playbackDuration: playback.duration,
    }),
    position,
    rotation,
    shaderParams,
    shaderType,
    size,
    zIndex,
  };
}

interface PlaybackAnchor {
  duration: number;
  state: ArchivePlaybackState;
  updatedAt: number;
}

interface ShaderPlaybackAnchor {
  isPlaying: boolean;
  time: number;
  updatedAt: number;
}

function advancePlayback(anchor: PlaybackAnchor, now: number): ArchivePlaybackState {
  const state = clone(anchor.state);
  if (!state.isPlaying) return state;
  state.currentTime += (Math.max(0, now - anchor.updatedAt) * state.playbackRate) / 1_000;
  if (anchor.duration > 0 && state.loop) state.currentTime %= anchor.duration;
  else if (anchor.duration > 0 && state.currentTime >= anchor.duration) {
    state.currentTime = anchor.duration;
    state.isPlaying = false;
  }
  return state;
}

function advanceShaderPlayback(anchor: ShaderPlaybackAnchor, now: number): number {
  return anchor.isPlaying ? anchor.time + Math.max(0, now - anchor.updatedAt) / 1_000 : anchor.time;
}

function readFlatRecord(map: Y.Map<unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of map) {
    if (!key.startsWith(PARAM_PREFIX)) continue;
    setPath(result, key.slice(PARAM_PREFIX.length).split("."), value);
  }
  return result;
}

function setPath(target: JsonObject, path: string[], value: unknown): void {
  let current = target;
  for (let index = 0; index < path.length - 1; index++) {
    const segment = path[index]!;
    if (!isJsonObject(current[segment])) current[segment] = {};
    current = current[segment] as JsonObject;
  }
  current[path.at(-1)!] = clone(value) as JsonValue;
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

function isPlaybackAnchor(value: unknown): value is PlaybackAnchor {
  return (
    isRecord(value) &&
    isFiniteNumber(value.duration) &&
    value.duration >= 0 &&
    isFiniteNumber(value.updatedAt) &&
    isPlaybackState(value.state)
  );
}

function isShaderPlaybackAnchor(value: unknown): value is ShaderPlaybackAnchor {
  return (
    isRecord(value) &&
    typeof value.isPlaying === "boolean" &&
    isFiniteNumber(value.time) &&
    isFiniteNumber(value.updatedAt)
  );
}

function isPlaybackState(value: unknown): value is ArchivePlaybackState {
  return (
    isRecord(value) &&
    isFiniteNumber(value.currentTime) &&
    value.currentTime >= 0 &&
    typeof value.isPlaying === "boolean" &&
    typeof value.loop === "boolean" &&
    typeof value.muted === "boolean" &&
    isFiniteNumber(value.playbackRate) &&
    value.playbackRate > 0 &&
    isFiniteNumber(value.volume) &&
    value.volume >= 0 &&
    value.volume <= 1
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
