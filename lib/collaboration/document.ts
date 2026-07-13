import * as Y from "yjs";
import { config } from "#config";
import type { ColorPalette, ShaderCanvasEntity, ShaderParams } from "#types/canvas.ts";
import { ShaderType } from "#types/canvas.ts";
import type {
  CollaborativeAssetDescriptor,
  CollaborativeEntity,
} from "#lib/collaboration/protocol.ts";
import { isCollaborativeAssetDescriptor } from "#lib/collaboration/protocol.ts";
import { monotonicEpochNow, type MonotonicClock } from "#lib/collaboration/clock.ts";

const REMOTE_ORIGIN = Symbol("voidmesh-collaboration-remote");
const LOCAL_ORIGIN = Symbol("voidmesh-collaboration-local");
const PARAM_PREFIX = "appearance.params.";
const MAX_SCENE_COORDINATE = 100_000_000;

type CollaborativeEntityMap = Y.Map<unknown>;

export interface CollaborationDocumentChange {
  entityIds: ReadonlySet<string>;
  paletteIds: ReadonlySet<string>;
  isRemote: boolean;
}

export interface CollaborativePlayback {
  state: NonNullable<CollaborativeEntity["playback"]>;
  updatedAt: number;
  duration: number;
  commandId: string;
  sourceId: string;
}

interface CollaborationDocumentOptions {
  sourceId?: string;
  now?: MonotonicClock;
}

export class CollaborationDocument {
  readonly #document = new Y.Doc();
  readonly #entities = this.#document.getMap<CollaborativeEntityMap>("entities");
  readonly #palettes = this.#document.getMap<ColorPalette>("palettes");
  readonly #deletedPalettes = this.#document.getMap<boolean>("deletedPalettes");
  readonly #sourceId: string;
  readonly #now: MonotonicClock;
  readonly #peerClockOffsets = new Map<string, number>();

  constructor(options: CollaborationDocumentOptions = {}) {
    this.#sourceId = options.sourceId ?? "local";
    this.#now = options.now ?? monotonicEpochNow;
  }

  setPeerClockOffset(peerId: string, offsetMs: number): void {
    if (!Number.isFinite(offsetMs)) throw new Error("Peer clock offset must be finite");
    this.#peerClockOffsets.set(peerId, offsetMs);
  }

  onUpdate(listener: (update: Uint8Array, isRemote: boolean) => void): () => void {
    const handleUpdate = (update: Uint8Array, origin: unknown) => {
      listener(update, origin === REMOTE_ORIGIN);
    };
    this.#document.on("update", handleUpdate);
    return () => this.#document.off("update", handleUpdate);
  }

  onChange(listener: (change: CollaborationDocumentChange) => void): () => void {
    const handleEntities = (
      events: Y.YEvent<Y.AbstractType<unknown>>[],
      transaction: Y.Transaction,
    ) => {
      const entityIds = new Set<string>();
      for (const event of events) {
        const [entityId] = event.path;
        if (typeof entityId === "string") {
          entityIds.add(entityId);
          continue;
        }
        if (event instanceof Y.YMapEvent) {
          for (const key of event.keysChanged) entityIds.add(key);
        }
      }
      if (entityIds.size > 0) {
        listener({
          entityIds,
          paletteIds: new Set(),
          isRemote: transaction.origin === REMOTE_ORIGIN,
        });
      }
    };
    const handlePalettes = (_event: Y.YMapEvent<ColorPalette>, transaction: Y.Transaction) => {
      listener({
        entityIds: new Set(),
        paletteIds: new Set(_event.keysChanged),
        isRemote: transaction.origin === REMOTE_ORIGIN,
      });
    };
    const handleDeletedPalettes = (_event: Y.YMapEvent<boolean>, transaction: Y.Transaction) => {
      listener({
        entityIds: new Set(),
        paletteIds: new Set(_event.keysChanged),
        isRemote: transaction.origin === REMOTE_ORIGIN,
      });
    };
    this.#entities.observeDeep(handleEntities);
    this.#palettes.observe(handlePalettes);
    this.#deletedPalettes.observe(handleDeletedPalettes);
    return () => {
      this.#entities.unobserveDeep(handleEntities);
      this.#palettes.unobserve(handlePalettes);
      this.#deletedPalettes.unobserve(handleDeletedPalettes);
    };
  }

  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.#document);
  }

  hasEntity(entityId: string): boolean {
    return this.#entities.has(entityId);
  }

  getEntityIds(): string[] {
    return [...this.#entities.keys()];
  }

  getEntityIdsForAssetHash(hash: string): string[] {
    const entityIds: string[] = [];
    for (const [entityId, map] of this.#entities) {
      const asset = map.get("asset");
      if (isCollaborativeAssetDescriptor(asset) && asset.hash === hash) entityIds.push(entityId);
    }
    return entityIds;
  }

  getAssetHashes(): Set<string> {
    const hashes = new Set<string>();
    for (const map of this.#entities.values()) {
      const asset = map.get("asset");
      if (isCollaborativeAssetDescriptor(asset) && asset.hash) hashes.add(asset.hash);
    }
    return hashes;
  }

  getAssetDescriptor(hash: string): CollaborativeAssetDescriptor | null {
    for (const map of this.#entities.values()) {
      const asset = map.get("asset");
      if (isCollaborativeAssetDescriptor(asset) && asset.hash === hash) return clone(asset);
    }
    return null;
  }

  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.#document, update, REMOTE_ORIGIN);
  }

  addEntity(entity: CollaborativeEntity): void {
    this.#document.transact(() => {
      const map = new Y.Map<unknown>();
      this.#entities.set(entity.id, map);
      this.#setAllFields(map, entity);
      this.#publishPalette(entity.shaderParams.palette);
    }, LOCAL_ORIGIN);
  }

  setGeometry(entity: ShaderCanvasEntity): void {
    const map = this.#entities.get(entity.id);
    if (!map) return;
    this.#document.transact(() => writeGeometry(map, entity), LOCAL_ORIGIN);
  }

  setIdentity(entity: ShaderCanvasEntity): void {
    const map = this.#entities.get(entity.id);
    if (!map) return;
    this.#document.transact(() => writeIdentity(map, entity), LOCAL_ORIGIN);
  }

  setAppearance(entity: ShaderCanvasEntity): void {
    const map = this.#entities.get(entity.id);
    if (!map) return;
    this.#document.transact(() => {
      writeAppearance(map, entity.shaderType, entity.shaderParams);
      this.#publishPalette(entity.shaderParams.palette);
    }, LOCAL_ORIGIN);
  }

  setPlayback(
    entityId: string,
    state: NonNullable<CollaborativeEntity["playback"]>,
    duration: number,
  ): string | null {
    const map = this.#entities.get(entityId);
    if (!map) return null;
    const commandId = crypto.randomUUID();
    this.#document.transact(() => {
      const playback: CollaborativePlayback = {
        state: { ...state },
        updatedAt: this.#now(),
        duration,
        commandId,
        sourceId: this.#sourceId,
      };
      map.set("playback", playback);
    }, LOCAL_ORIGIN);
    return commandId;
  }

  setAsset(entityId: string, asset: CollaborativeAssetDescriptor): void {
    const map = this.#entities.get(entityId);
    if (!map) return;
    this.#document.transact(() => map.set("asset", asset), LOCAL_ORIGIN);
  }

  setAssets(updates: readonly { entityId: string; asset: CollaborativeAssetDescriptor }[]): void {
    this.#document.transact(() => {
      for (const { entityId, asset } of updates) this.#entities.get(entityId)?.set("asset", asset);
    }, LOCAL_ORIGIN);
  }

  removeEntities(entityIds: readonly string[]): void {
    this.#document.transact(() => {
      for (const entityId of entityIds) {
        this.#entities.delete(entityId);
      }
    }, LOCAL_ORIGIN);
  }

  replaceEntities(entities: readonly CollaborativeEntity[]): void {
    this.#document.transact(() => {
      this.#entities.clear();
      for (const entity of entities) {
        const map = new Y.Map<unknown>();
        this.#entities.set(entity.id, map);
        this.#setAllFields(map, entity);
        this.#publishPalette(entity.shaderParams.palette);
      }
    }, LOCAL_ORIGIN);
  }

  setPalettes(palettes: readonly ColorPalette[]): void {
    this.#document.transact(() => {
      for (const palette of palettes) {
        if (
          isColorPalette(palette) &&
          palette.id &&
          isRoomPaletteId(palette.id) &&
          !this.#deletedPalettes.has(palette.id) &&
          !sameValue(this.#palettes.get(palette.id), palette)
        ) {
          this.#palettes.set(palette.id, clone(palette));
        }
      }
    }, LOCAL_ORIGIN);
  }

  removePalette(paletteId: string): void {
    if (!isRoomPaletteId(paletteId)) return;
    this.#document.transact(() => {
      this.#palettes.delete(paletteId);
      this.#deletedPalettes.set(paletteId, true);
    }, LOCAL_ORIGIN);
  }

  restorePalette(palette: ColorPalette): void {
    if (!palette.id || !isRoomPaletteId(palette.id) || !isColorPalette(palette)) return;
    this.#document.transact(() => {
      this.#deletedPalettes.delete(palette.id!);
      this.#palettes.set(palette.id!, clone(palette));
    }, LOCAL_ORIGIN);
  }

  getPalettes(): ColorPalette[] {
    const palettes: ColorPalette[] = [];
    for (const [paletteId, palette] of this.#palettes) {
      if (!this.#deletedPalettes.has(paletteId) && isColorPalette(palette)) {
        palettes.push(clone(palette));
      }
    }
    return palettes;
  }

  getEntities(): CollaborativeEntity[] {
    const entities: CollaborativeEntity[] = [];
    for (const entityId of this.#entities.keys()) {
      const entity = this.getEntity(entityId);
      if (entity) entities.push(entity);
    }
    entities.sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
    return entities;
  }

  getEntity(entityId: string): CollaborativeEntity | null {
    const map = this.#entities.get(entityId);
    if (!map) return null;
    return readEntity(entityId, map, this.#sourceId, this.#now(), (sourceId) =>
      this.#peerClockOffsets.get(sourceId),
    );
  }

  destroy(): void {
    this.#document.destroy();
  }

  #setAllFields(map: CollaborativeEntityMap, entity: CollaborativeEntity): void {
    writeIdentity(map, entity);
    writeGeometry(map, entity);
    writeAppearance(map, entity.shaderType, entity.shaderParams);
    map.set("asset", clone(entity.asset));
    if (entity.playback) {
      map.set("playback", {
        state: { ...entity.playback },
        updatedAt: this.#now(),
        duration: entity.playbackDuration ?? 0,
        commandId: crypto.randomUUID(),
        sourceId: this.#sourceId,
      } satisfies CollaborativePlayback);
    }
  }

  #publishPalette(palette: ColorPalette | undefined): void {
    if (
      palette?.id &&
      isRoomPaletteId(palette.id) &&
      !this.#deletedPalettes.has(palette.id) &&
      isColorPalette(palette) &&
      !sameValue(this.#palettes.get(palette.id), palette)
    ) {
      this.#palettes.set(palette.id, clone(palette));
    }
  }
}

function writeIdentity(
  map: CollaborativeEntityMap,
  entity: ShaderCanvasEntity | CollaborativeEntity,
) {
  setIfChanged(map, "identity.name", entity.name);
  setIfChanged(map, "identity.locked", entity.locked ?? false);
  setIfChanged(map, "identity.edited", entity.edited);
  if (entity.originalPalette) setIfChanged(map, "identity.originalPalette", entity.originalPalette);
  else map.delete("identity.originalPalette");
}

function writeGeometry(
  map: CollaborativeEntityMap,
  entity: ShaderCanvasEntity | CollaborativeEntity,
) {
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
  map: CollaborativeEntityMap,
  shaderType: CollaborativeEntity["shaderType"],
  shaderParams: ShaderParams,
) {
  setIfChanged(map, "appearance.shaderType", shaderType);
  syncFlatRecord(map, PARAM_PREFIX, shaderParams as unknown as Record<string, unknown>);
}

function syncFlatRecord(
  map: CollaborativeEntityMap,
  prefix: string,
  value: Record<string, unknown>,
) {
  const flattened = new Map<string, unknown>();
  flattenRecord(value, prefix, flattened);
  for (const key of map.keys()) {
    if (key.startsWith(prefix) && !flattened.has(key)) map.delete(key);
  }
  for (const [key, entry] of flattened) {
    if (!sameValue(map.get(key), entry)) map.set(key, clone(entry));
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((entry, index) => sameValue(entry, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
    );
  }
  return false;
}

function setIfChanged(map: CollaborativeEntityMap, key: string, value: unknown): void {
  if (!sameValue(map.get(key), value)) map.set(key, clone(value));
}

function flattenRecord(
  value: Record<string, unknown>,
  prefix: string,
  output: Map<string, unknown>,
) {
  for (const [key, entry] of Object.entries(value)) {
    const path = `${prefix}${key}`;
    if (isRecord(entry)) flattenRecord(entry, `${path}.`, output);
    else if (entry !== undefined) output.set(path, entry);
  }
}

function readFlatRecord(map: CollaborativeEntityMap, prefix: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of map) {
    if (!key.startsWith(prefix)) continue;
    setPath(result, key.slice(prefix.length).split("."), clone(value));
  }
  return result;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown) {
  let current = target;
  for (let index = 0; index < path.length - 1; index++) {
    const segment = path[index]!;
    const next = current[segment];
    if (!isRecord(next)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[path.at(-1)!] = value;
}

function readEntity(
  id: string,
  map: CollaborativeEntityMap,
  localSourceId: string,
  localNow: number,
  getPeerClockOffset: (sourceId: string) => number | undefined,
): CollaborativeEntity | null {
  const name = map.get("identity.name");
  const locked = map.get("identity.locked");
  const edited = map.get("identity.edited");
  const originalPalette = map.get("identity.originalPalette");
  const position = { x: map.get("geometry.position.x"), y: map.get("geometry.position.y") };
  const size = {
    width: map.get("geometry.size.width"),
    height: map.get("geometry.size.height"),
  };
  const originalSize = {
    width: map.get("geometry.originalSize.width"),
    height: map.get("geometry.originalSize.height"),
  };
  const rotation = map.get("geometry.rotation");
  const zIndex = map.get("geometry.zIndex");
  const shaderType = map.get("appearance.shaderType");
  const shaderParams = readFlatRecord(map, PARAM_PREFIX);
  const asset = map.get("asset");
  const playback = map.get("playback");
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 512 ||
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
    !isCollaborativeAssetDescriptor(asset) ||
    (originalPalette !== undefined && !isColorPalette(originalPalette)) ||
    (playback !== undefined && !isCollaborativePlayback(playback))
  ) {
    return null;
  }

  return {
    id,
    name,
    position,
    size,
    originalSize,
    zIndex,
    rotation,
    locked,
    edited,
    shaderType,
    shaderParams,
    ...(originalPalette && { originalPalette: clone(originalPalette) }),
    ...(playback && {
      playback: advancePlayback(
        playback,
        localSourceId,
        localNow,
        getPeerClockOffset(playback.sourceId),
      ),
      playbackDuration: playback.duration,
      playbackCommandId: playback.commandId,
      playbackSourceId: playback.sourceId,
    }),
    asset: clone(asset),
  };
}

function advancePlayback(
  playback: CollaborativePlayback,
  localSourceId: string,
  localNow: number,
  peerClockOffset: number | undefined,
): CollaborativePlayback["state"] {
  const state = { ...playback.state };
  if (!state.isPlaying) return state;
  const clockOffset = playback.sourceId === localSourceId ? 0 : peerClockOffset;
  if (clockOffset === undefined) return state;
  const elapsedSeconds = Math.max(0, localNow + clockOffset - playback.updatedAt) / 1000;
  state.currentTime += elapsedSeconds * state.playbackRate;
  if (playback.duration > 0) {
    if (state.loop) state.currentTime %= playback.duration;
    else if (state.currentTime >= playback.duration) {
      state.currentTime = playback.duration;
      state.isPlaying = false;
    }
  }
  return state;
}

function isCollaborativePlayback(value: unknown): value is CollaborativePlayback {
  if (!isRecord(value) || !isPlaybackState(value.state)) return false;
  return (
    isFiniteNumber(value.updatedAt) &&
    isFiniteNumber(value.duration) &&
    value.duration >= 0 &&
    typeof value.commandId === "string" &&
    value.commandId.length > 0 &&
    typeof value.sourceId === "string" &&
    value.sourceId.length > 0
  );
}

function isPlaybackState(value: unknown): value is CollaborativePlayback["state"] {
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

function isShaderParams(value: unknown): value is ShaderParams {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.size) &&
    typeof value.shape === "string" &&
    isRgba(value.color) &&
    isRgba(value.background) &&
    typeof value.preserveColors === "boolean" &&
    typeof value.reversePalette === "boolean" &&
    typeof value.showOriginal === "boolean" &&
    isFiniteNumber(value.scale) &&
    isFiniteNumber(value.intensity) &&
    (value.palette === undefined || isColorPalette(value.palette)) &&
    isBoundedJson(value)
  );
}

function isColorPalette(value: unknown): value is ColorPalette {
  return (
    isRecord(value) &&
    (value.id === undefined || (typeof value.id === "string" && value.id.length <= 512)) &&
    typeof value.name === "string" &&
    value.name.length <= 1_024 &&
    typeof value.shortName === "string" &&
    value.shortName.length <= 256 &&
    Array.isArray(value.colors) &&
    value.colors.length >= 2 &&
    value.colors.length <= 16 &&
    value.colors.every(isRgba)
  );
}

function isRoomPaletteId(paletteId: string): boolean {
  return (
    paletteId.startsWith(config.paletteIdPrefix.custom) ||
    paletteId.startsWith(config.paletteIdPrefix.extracted)
  );
}

function isBoundedJson(value: unknown, depth = 0): boolean {
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

function isShaderType(value: unknown): value is CollaborativeEntity["shaderType"] {
  return typeof value === "string" && Object.values(ShaderType).includes(value as never);
}

function isPoint(value: { x: unknown; y: unknown }): value is { x: number; y: number } {
  return isCoordinate(value.x) && isCoordinate(value.y);
}

function isSize(value: {
  width: unknown;
  height: unknown;
}): value is { width: number; height: number } {
  return (
    isFiniteNumber(value.width) &&
    value.width > 0 &&
    value.width <= MAX_SCENE_COORDINATE &&
    isFiniteNumber(value.height) &&
    value.height > 0 &&
    value.height <= MAX_SCENE_COORDINATE
  );
}

function isCoordinate(value: unknown): value is number {
  return isFiniteNumber(value) && Math.abs(value) <= MAX_SCENE_COORDINATE;
}

function isRgba(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((channel) => isFiniteNumber(channel) && channel >= 0 && channel <= 1)
  );
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
