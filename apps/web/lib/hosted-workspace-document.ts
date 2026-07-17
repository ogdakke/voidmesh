import * as Y from "yjs";
import type { UndoDelegate } from "#lib/undo.ts";
import {
  ShaderType,
  type ColorPalette,
  type PlaybackState,
  type ShaderParams,
} from "#types/canvas.ts";

const ENTITY_FIELDS = "entities";
const PARAM_PREFIX = "appearance.params.";
const PLAYBACK_PARAM_KEYS = new Set(["time", "timeAutoPlay"]);
const MAX_COORDINATE = 100_000_000;

type EntityMap = Y.Map<unknown>;

export interface HostedAssetReference {
  byteLength: number;
  contentHash?: string | null;
  contentType: string;
  id: string;
  mediaType: string;
  originalFilename: string;
}

export interface HostedWorkspaceEntity {
  asset: HostedAssetReference;
  edited: boolean;
  fps?: number | null;
  hasAudio?: boolean;
  id: string;
  locked: boolean;
  name: string;
  originalPalette?: ColorPalette;
  originalSize: { height: number; width: number };
  playback?: PlaybackState;
  playbackCommandId?: string;
  playbackDuration?: number;
  position: { x: number; y: number };
  rotation: number;
  shaderParams: ShaderParams;
  shaderPlaybackCommandId?: string;
  shaderType: ShaderType;
  size: { height: number; width: number };
  zIndex: number;
}

export interface HostedWorkspaceDocumentChange {
  entityIds: ReadonlySet<string>;
  isRemote: boolean;
  shouldProject: boolean;
}

interface PlaybackAnchor {
  commandId: string;
  duration: number;
  sequence?: number;
  state: PlaybackState;
  updatedAt: number;
}

interface ShaderPlaybackAnchor {
  commandId: string;
  isPlaying: boolean;
  sequence?: number;
  time: number;
  updatedAt: number;
}

export interface HostedWorkspaceDocumentOptions {
  document: Y.Doc;
  now?: () => number;
}

/**
 * Voidmesh's durable scene model. The provider owns persistence and transport;
 * this class only maps domain operations onto conflict-free Yjs fields.
 */
export class HostedWorkspaceDocument {
  readonly #document: Y.Doc;
  readonly #entities: Y.Map<EntityMap>;
  readonly #now: () => number;
  readonly #undoManager: Y.UndoManager;
  readonly #undoListeners = new Set<() => void>();
  readonly undo: UndoDelegate;

  constructor(options: HostedWorkspaceDocumentOptions) {
    this.#document = options.document;
    this.#entities = this.#document.getMap<EntityMap>(ENTITY_FIELDS);
    this.#now = options.now ?? Date.now;
    this.#undoManager = new Y.UndoManager(this.#entities, { captureTimeout: 500 });
    const notifyUndo = () => {
      for (const listener of this.#undoListeners) listener();
    };
    this.#undoManager.on("stack-item-added", notifyUndo);
    this.#undoManager.on("stack-item-popped", notifyUndo);
    this.#undoManager.on("stack-item-updated", notifyUndo);
    this.#undoManager.on("stack-cleared", notifyUndo);
    this.undo = {
      abortTransaction: () => this.#undoManager.stopCapturing(),
      beginTransaction: () => this.#undoManager.stopCapturing(),
      canRedo: () => this.#undoManager.redoStack.length > 0,
      canUndo: () => this.#undoManager.undoStack.length > 0,
      clear: () => this.#undoManager.clear(),
      commitTransaction: () => this.#undoManager.stopCapturing(),
      redo: () => this.#undoManager.redo(),
      subscribe: (listener) => {
        this.#undoListeners.add(listener);
        return () => this.#undoListeners.delete(listener);
      },
      undo: () => this.#undoManager.undo(),
    };
  }

  onChange(listener: (change: HostedWorkspaceDocumentChange) => void): () => void {
    const observe = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
      const entityIds = new Set<string>();
      for (const event of events) {
        const [entityId] = event.path;
        if (typeof entityId === "string") entityIds.add(entityId);
        else if (event instanceof Y.YMapEvent) {
          for (const key of event.keysChanged) entityIds.add(key);
        }
      }
      if (entityIds.size > 0) {
        const isRemote = transaction.local === false;
        listener({
          entityIds,
          isRemote,
          shouldProject: isRemote || transaction.origin === this.#undoManager,
        });
      }
    };
    this.#entities.observeDeep(observe);
    return () => this.#entities.unobserveDeep(observe);
  }

  getEntityIds(): string[] {
    return [...this.#entities.keys()];
  }

  getEntities(): HostedWorkspaceEntity[] {
    return this.getEntityIds()
      .map((id) => this.getEntity(id))
      .filter((entity): entity is HostedWorkspaceEntity => entity !== null)
      .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
  }

  getEntity(id: string): HostedWorkspaceEntity | null {
    const map = this.#entities.get(id);
    return map ? readEntity(id, map, this.#now()) : null;
  }

  addEntity(entity: HostedWorkspaceEntity): void {
    this.#document.transact(() => {
      const map = new Y.Map<unknown>();
      this.#entities.set(entity.id, map);
      writeIdentity(map, entity);
      writeGeometry(map, entity);
      writeAppearance(map, entity, this.#now());
      map.set("asset", clone(entity.asset));
      if (entity.playback)
        writePlayback(map, entity.playback, entity.playbackDuration ?? 0, this.#now());
    });
  }

  replaceEntities(entities: readonly HostedWorkspaceEntity[]): void {
    this.#document.transact(() => {
      this.#entities.clear();
      for (const entity of entities) {
        const map = new Y.Map<unknown>();
        this.#entities.set(entity.id, map);
        writeIdentity(map, entity);
        writeGeometry(map, entity);
        writeAppearance(map, entity, this.#now());
        map.set("asset", clone(entity.asset));
        if (entity.playback) {
          writePlayback(map, entity.playback, entity.playbackDuration ?? 0, this.#now());
        }
      }
    });
  }

  setIdentity(entity: HostedWorkspaceEntity): void {
    const map = this.#entities.get(entity.id);
    if (map) this.#document.transact(() => writeIdentity(map, entity));
  }

  setGeometry(entity: HostedWorkspaceEntity): void {
    const map = this.#entities.get(entity.id);
    if (map) this.#document.transact(() => writeGeometry(map, entity));
  }

  setAppearance(entity: HostedWorkspaceEntity, syncPlayback = true): void {
    const map = this.#entities.get(entity.id);
    if (!map) return;
    this.#document.transact(() =>
      writeAppearance(map, entity, syncPlayback ? this.#now() : undefined),
    );
  }

  setAsset(entityId: string, asset: HostedAssetReference): void {
    const map = this.#entities.get(entityId);
    if (map) this.#document.transact(() => setIfChanged(map, "asset", asset));
  }

  replaceAssetReference(assetId: string, replacement: HostedAssetReference): void {
    this.#document.transact(() => {
      for (const map of this.#entities.values()) {
        const current = map.get("asset");
        if (isAsset(current) && current.id === assetId) map.set("asset", clone(replacement));
      }
    });
  }

  setPlayback(entityId: string, state: PlaybackState, duration: number): string | null {
    const map = this.#entities.get(entityId);
    if (!map) return null;
    const commandId = crypto.randomUUID();
    this.#document.transact(() =>
      map.set("playback", {
        commandId,
        duration,
        state: clone(state),
        updatedAt: this.#now(),
      } satisfies PlaybackAnchor),
    );
    return commandId;
  }

  setShaderPlayback(entityId: string, time: number, isPlaying: boolean): string | null {
    const map = this.#entities.get(entityId);
    if (!map) return null;
    const commandId = crypto.randomUUID();
    this.#document.transact(() =>
      map.set("appearance.shaderPlayback", {
        commandId,
        isPlaying,
        time,
        updatedAt: this.#now(),
      } satisfies ShaderPlaybackAnchor),
    );
    return commandId;
  }

  removeEntities(entityIds: ReadonlySet<string> | readonly string[]): void {
    this.#document.transact(() => {
      for (const id of entityIds) this.#entities.delete(id);
    });
  }

  destroy(): void {
    this.#undoManager.destroy();
    this.#undoListeners.clear();
  }
}

function writeIdentity(map: EntityMap, entity: HostedWorkspaceEntity): void {
  setIfChanged(map, "identity.name", entity.name);
  setIfChanged(map, "identity.locked", entity.locked);
  setIfChanged(map, "identity.edited", entity.edited);
  if (entity.originalPalette) setIfChanged(map, "identity.originalPalette", entity.originalPalette);
  else map.delete("identity.originalPalette");
  if (entity.fps !== undefined) setIfChanged(map, "media.fps", entity.fps);
  else map.delete("media.fps");
  if (entity.hasAudio !== undefined) setIfChanged(map, "media.hasAudio", entity.hasAudio);
  else map.delete("media.hasAudio");
}

function writeGeometry(map: EntityMap, entity: HostedWorkspaceEntity): void {
  setIfChanged(map, "geometry.position.x", entity.position.x);
  setIfChanged(map, "geometry.position.y", entity.position.y);
  setIfChanged(map, "geometry.size.width", entity.size.width);
  setIfChanged(map, "geometry.size.height", entity.size.height);
  setIfChanged(map, "geometry.originalSize.width", entity.originalSize.width);
  setIfChanged(map, "geometry.originalSize.height", entity.originalSize.height);
  setIfChanged(map, "geometry.rotation", entity.rotation);
  setIfChanged(map, "geometry.zIndex", entity.zIndex);
}

function writeAppearance(
  map: EntityMap,
  entity: HostedWorkspaceEntity,
  playbackTimestamp?: number,
): void {
  setIfChanged(map, "appearance.shaderType", entity.shaderType);
  syncFlatRecord(map, entity.shaderParams);
  if (playbackTimestamp !== undefined) {
    map.set("appearance.shaderPlayback", {
      commandId: crypto.randomUUID(),
      isPlaying: entity.shaderParams.timeAutoPlay !== false,
      time: entity.shaderParams.time ?? 0,
      updatedAt: playbackTimestamp,
    } satisfies ShaderPlaybackAnchor);
  }
}

function writePlayback(map: EntityMap, state: PlaybackState, duration: number, now: number): void {
  map.set("playback", {
    commandId: crypto.randomUUID(),
    duration,
    state: clone(state),
    updatedAt: now,
  } satisfies PlaybackAnchor);
}

function readEntity(id: string, map: EntityMap, now: number): HostedWorkspaceEntity | null {
  const name = map.get("identity.name");
  const locked = map.get("identity.locked");
  const edited = map.get("identity.edited");
  const originalPalette = map.get("identity.originalPalette");
  const position = { x: map.get("geometry.position.x"), y: map.get("geometry.position.y") };
  const size = { width: map.get("geometry.size.width"), height: map.get("geometry.size.height") };
  const originalSize = {
    width: map.get("geometry.originalSize.width"),
    height: map.get("geometry.originalSize.height"),
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
    !isShaderType(shaderType) ||
    !isShaderParams(shaderParams) ||
    !isAsset(asset) ||
    (originalPalette !== undefined && !isPalette(originalPalette)) ||
    (playback !== undefined && !isPlaybackAnchor(playback)) ||
    (shaderPlayback !== undefined && !isShaderPlaybackAnchor(shaderPlayback)) ||
    (fps !== undefined && fps !== null && (!isFiniteNumber(fps) || fps <= 0)) ||
    (hasAudio !== undefined && typeof hasAudio !== "boolean")
  )
    return null;

  if (shaderPlayback) {
    shaderParams.time = advanceShaderPlayback(shaderPlayback, now);
    shaderParams.timeAutoPlay = shaderPlayback.isPlaying;
  }
  const playbackState = playback ? advancePlayback(playback, now) : undefined;
  return {
    asset: clone(asset),
    edited,
    ...(fps !== undefined && { fps }),
    ...(hasAudio !== undefined && { hasAudio }),
    id,
    locked,
    name,
    ...(originalPalette && { originalPalette: clone(originalPalette) }),
    originalSize,
    ...(playbackState && {
      playback: playbackState,
      playbackCommandId: playback!.commandId,
      playbackDuration: playback!.duration,
    }),
    position,
    rotation,
    shaderParams,
    ...(shaderPlayback && { shaderPlaybackCommandId: shaderPlayback.commandId }),
    shaderType,
    size,
    zIndex,
  };
}

function advancePlayback(anchor: PlaybackAnchor, now: number): PlaybackState {
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

function syncFlatRecord(map: EntityMap, value: ShaderParams): void {
  const flattened = new Map<string, unknown>();
  flattenRecord(
    value as unknown as Record<string, unknown>,
    PARAM_PREFIX,
    flattened,
    PLAYBACK_PARAM_KEYS,
  );
  for (const key of map.keys())
    if (key.startsWith(PARAM_PREFIX) && !flattened.has(key)) map.delete(key);
  for (const [key, entry] of flattened) setIfChanged(map, key, entry);
}

function flattenRecord(
  value: Record<string, unknown>,
  prefix: string,
  output: Map<string, unknown>,
  excluded?: ReadonlySet<string>,
): void {
  for (const [key, entry] of Object.entries(value)) {
    if (excluded?.has(key)) continue;
    const path = `${prefix}${key}`;
    if (isRecord(entry)) flattenRecord(entry, `${path}.`, output);
    else if (entry !== undefined) output.set(path, entry);
  }
}

function readFlatRecord(map: EntityMap): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of map) {
    if (!key.startsWith(PARAM_PREFIX)) continue;
    setPath(result, key.slice(PARAM_PREFIX.length).split("."), clone(value));
  }
  return result;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target;
  for (let index = 0; index < path.length - 1; index++) {
    const segment = path[index]!;
    if (!isRecord(current[segment])) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[path.at(-1)!] = value;
}

function setIfChanged(map: EntityMap, key: string, value: unknown): void {
  if (!sameValue(map.get(key), value)) map.set(key, clone(value));
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => sameValue(left[key], right[key]))
    );
  }
  return false;
}

function isPlaybackAnchor(value: unknown): value is PlaybackAnchor {
  return (
    isRecord(value) &&
    typeof value.commandId === "string" &&
    isFiniteNumber(value.duration) &&
    value.duration >= 0 &&
    isFiniteNumber(value.updatedAt) &&
    isPlaybackState(value.state)
  );
}

function isShaderPlaybackAnchor(value: unknown): value is ShaderPlaybackAnchor {
  return (
    isRecord(value) &&
    typeof value.commandId === "string" &&
    typeof value.isPlaying === "boolean" &&
    isFiniteNumber(value.time) &&
    isFiniteNumber(value.updatedAt)
  );
}

function isPlaybackState(value: unknown): value is PlaybackState {
  return (
    isRecord(value) &&
    typeof value.isPlaying === "boolean" &&
    isFiniteNumber(value.currentTime) &&
    value.currentTime >= 0 &&
    typeof value.loop === "boolean" &&
    isFiniteNumber(value.playbackRate) &&
    value.playbackRate > 0 &&
    typeof value.muted === "boolean" &&
    isFiniteNumber(value.volume) &&
    value.volume >= 0 &&
    value.volume <= 1
  );
}

function isAsset(value: unknown): value is HostedAssetReference {
  return (
    isRecord(value) &&
    isIdentifier(value.id) &&
    isFiniteNumber(value.byteLength) &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength >= 0 &&
    (value.contentHash === undefined ||
      value.contentHash === null ||
      (typeof value.contentHash === "string" && /^[a-f0-9]{64}$/.test(value.contentHash))) &&
    typeof value.contentType === "string" &&
    value.contentType.length > 0 &&
    typeof value.mediaType === "string" &&
    value.mediaType.length > 0 &&
    typeof value.originalFilename === "string" &&
    value.originalFilename.length <= 1_024
  );
}

function isShaderParams(value: unknown): value is ShaderParams {
  return (
    isRecord(value) &&
    isFiniteNumber(value.size) &&
    typeof value.shape === "string" &&
    Array.isArray(value.color) &&
    Array.isArray(value.background) &&
    typeof value.preserveColors === "boolean" &&
    typeof value.reversePalette === "boolean" &&
    typeof value.showOriginal === "boolean" &&
    isFiniteNumber(value.scale) &&
    isFiniteNumber(value.intensity) &&
    isBoundedJson(value)
  );
}

function isPalette(value: unknown): value is ColorPalette {
  return (
    isRecord(value) &&
    (value.id === undefined || typeof value.id === "string") &&
    typeof value.name === "string" &&
    typeof value.shortName === "string" &&
    Array.isArray(value.colors) &&
    value.colors.length >= 2 &&
    value.colors.length <= 16
  );
}

function isShaderType(value: unknown): value is ShaderType {
  return typeof value === "string" && Object.values(ShaderType).includes(value as ShaderType);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isPoint(value: { x: unknown; y: unknown }): value is { x: number; y: number } {
  return (
    isFiniteNumber(value.x) &&
    Math.abs(value.x) <= MAX_COORDINATE &&
    isFiniteNumber(value.y) &&
    Math.abs(value.y) <= MAX_COORDINATE
  );
}

function isSize(value: {
  width: unknown;
  height: unknown;
}): value is { width: number; height: number } {
  return (
    isFiniteNumber(value.width) &&
    value.width > 0 &&
    value.width <= MAX_COORDINATE &&
    isFiniteNumber(value.height) &&
    value.height > 0 &&
    value.height <= MAX_COORDINATE
  );
}

function isBoundedJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 4_096;
  if (Array.isArray(value))
    return value.length <= 128 && value.every((entry) => isBoundedJson(entry, depth + 1));
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 128 && entries.every(([, entry]) => isBoundedJson(entry, depth + 1));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return typeof value === "object" && value !== null ? structuredClone(value) : value;
}
