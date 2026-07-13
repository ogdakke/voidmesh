import * as Y from "yjs";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import type {
  CollaborativeAssetDescriptor,
  CollaborativeEntity,
} from "#lib/collaboration/protocol.ts";

const REMOTE_ORIGIN = Symbol("voidmesh-collaboration-remote");
const LOCAL_ORIGIN = Symbol("voidmesh-collaboration-local");

type CollaborativeEntityMap = Y.Map<unknown>;

export interface CollaborativeGeometry {
  position: CollaborativeEntity["position"];
  size: CollaborativeEntity["size"];
  originalSize: CollaborativeEntity["originalSize"];
  rotation: number;
}

export interface CollaborativeIdentity {
  name: string;
  locked: boolean;
  edited: boolean;
  originalPalette?: CollaborativeEntity["originalPalette"];
}

export interface CollaborativeAppearance {
  shaderType: CollaborativeEntity["shaderType"];
  shaderParams: CollaborativeEntity["shaderParams"];
}

export interface CollaborativePlayback {
  state: NonNullable<CollaborativeEntity["playback"]>;
  updatedAt: number;
}

export class CollaborationDocument {
  readonly #document = new Y.Doc();
  readonly #entities = this.#document.getMap<CollaborativeEntityMap>("entities");
  readonly #layers = this.#document.getArray<string>("layers");

  onUpdate(listener: (update: Uint8Array, isRemote: boolean) => void): () => void {
    const handleUpdate = (update: Uint8Array, origin: unknown) => {
      listener(update, origin === REMOTE_ORIGIN);
    };
    this.#document.on("update", handleUpdate);
    return () => this.#document.off("update", handleUpdate);
  }

  onChange(listener: () => void): () => void {
    const handleTransaction = () => listener();
    this.#document.on("afterTransaction", handleTransaction);
    return () => this.#document.off("afterTransaction", handleTransaction);
  }

  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.#document);
  }

  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.#document, update, REMOTE_ORIGIN);
  }

  addEntity(entity: CollaborativeEntity): void {
    this.#document.transact(() => {
      const map = new Y.Map<unknown>();
      this.#entities.set(entity.id, map);
      this.#setAllFields(map, entity);
      this.#ensureLayer(entity.id);
    }, LOCAL_ORIGIN);
  }

  setGeometry(entity: ShaderCanvasEntity): void {
    const map = this.#entities.get(entity.id);
    if (!map) return;
    this.#document.transact(() => {
      map.set("geometry", createGeometry(entity));
    }, LOCAL_ORIGIN);
  }

  setIdentity(entity: ShaderCanvasEntity): void {
    const map = this.#entities.get(entity.id);
    if (!map) return;
    this.#document.transact(() => {
      map.set("identity", createIdentity(entity));
    }, LOCAL_ORIGIN);
  }

  setAppearance(entity: ShaderCanvasEntity): void {
    const map = this.#entities.get(entity.id);
    if (!map) return;
    this.#document.transact(() => {
      map.set("appearance", createAppearance(entity));
    }, LOCAL_ORIGIN);
  }

  setPlayback(entityId: string, state: NonNullable<CollaborativeEntity["playback"]>): void {
    const map = this.#entities.get(entityId);
    if (!map) return;
    this.#document.transact(() => {
      const playback: CollaborativePlayback = { state: { ...state }, updatedAt: Date.now() };
      map.set("playback", playback);
    }, LOCAL_ORIGIN);
  }

  setAsset(entityId: string, asset: CollaborativeAssetDescriptor): void {
    const map = this.#entities.get(entityId);
    if (!map) return;
    this.#document.transact(() => {
      map.set("asset", asset);
    }, LOCAL_ORIGIN);
  }

  removeEntities(entityIds: readonly string[]): void {
    this.#document.transact(() => {
      for (const entityId of entityIds) {
        this.#entities.delete(entityId);
        const layerIndex = this.#layers.toArray().indexOf(entityId);
        if (layerIndex >= 0) this.#layers.delete(layerIndex, 1);
      }
    }, LOCAL_ORIGIN);
  }

  replaceEntities(entities: readonly CollaborativeEntity[]): void {
    this.#document.transact(() => {
      this.#entities.clear();
      if (this.#layers.length > 0) this.#layers.delete(0, this.#layers.length);
      for (const entity of entities) {
        const map = new Y.Map<unknown>();
        this.#entities.set(entity.id, map);
        this.#setAllFields(map, entity);
        this.#layers.push([entity.id]);
      }
    }, LOCAL_ORIGIN);
  }

  getEntities(): CollaborativeEntity[] {
    const layerIds = this.#layers.toArray();
    const layerIndex = new Map(layerIds.map((id, index) => [id, index + 1]));
    const entities: CollaborativeEntity[] = [];
    for (const [id, map] of this.#entities) {
      const entity = readEntity(id, map, layerIndex.get(id) ?? layerIds.length + 1);
      if (entity) entities.push(entity);
    }
    entities.sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
    return entities;
  }

  destroy(): void {
    this.#document.destroy();
  }

  #setAllFields(map: CollaborativeEntityMap, entity: CollaborativeEntity): void {
    map.set("identity", {
      name: entity.name,
      locked: entity.locked,
      edited: entity.edited,
      ...(entity.originalPalette && { originalPalette: entity.originalPalette }),
    } satisfies CollaborativeIdentity);
    map.set("geometry", {
      position: entity.position,
      size: entity.size,
      originalSize: entity.originalSize,
      rotation: entity.rotation,
    } satisfies CollaborativeGeometry);
    map.set("appearance", {
      shaderType: entity.shaderType,
      shaderParams: entity.shaderParams,
    } satisfies CollaborativeAppearance);
    map.set("asset", entity.asset);
    if (entity.playback) {
      map.set("playback", {
        state: entity.playback,
        updatedAt: Date.now(),
      } satisfies CollaborativePlayback);
    }
  }

  #ensureLayer(entityId: string): void {
    if (!this.#layers.toArray().includes(entityId)) this.#layers.push([entityId]);
  }
}

function createGeometry(entity: ShaderCanvasEntity): CollaborativeGeometry {
  return {
    position: { ...entity.position },
    size: { ...entity.size },
    originalSize: { ...entity.originalSize },
    rotation: entity.rotation,
  };
}

function createIdentity(entity: ShaderCanvasEntity): CollaborativeIdentity {
  return {
    name: entity.name,
    locked: entity.locked ?? false,
    edited: entity.edited,
    ...(entity.originalPalette && { originalPalette: structuredClone(entity.originalPalette) }),
  };
}

function createAppearance(entity: ShaderCanvasEntity): CollaborativeAppearance {
  return {
    shaderType: entity.shaderType,
    shaderParams: structuredClone(entity.shaderParams),
  };
}

function readEntity(
  id: string,
  map: CollaborativeEntityMap,
  zIndex: number,
): CollaborativeEntity | null {
  const identity = map.get("identity") as CollaborativeIdentity | undefined;
  const geometry = map.get("geometry") as CollaborativeGeometry | undefined;
  const appearance = map.get("appearance") as CollaborativeAppearance | undefined;
  const asset = map.get("asset") as CollaborativeAssetDescriptor | undefined;
  const playback = map.get("playback") as CollaborativePlayback | undefined;
  if (!identity || !geometry || !appearance || !asset) return null;

  return {
    id,
    name: identity.name,
    position: { ...geometry.position },
    size: { ...geometry.size },
    originalSize: { ...geometry.originalSize },
    zIndex,
    rotation: geometry.rotation,
    locked: identity.locked,
    edited: identity.edited,
    shaderType: appearance.shaderType,
    shaderParams: structuredClone(appearance.shaderParams),
    ...(identity.originalPalette && {
      originalPalette: structuredClone(identity.originalPalette),
    }),
    ...(playback && { playback: advancePlayback(playback) }),
    asset: { ...asset },
  };
}

function advancePlayback(playback: CollaborativePlayback): CollaborativePlayback["state"] {
  const state = { ...playback.state };
  if (!state.isPlaying) return state;
  const elapsedSeconds = Math.max(0, Date.now() - playback.updatedAt) / 1000;
  state.currentTime += elapsedSeconds * state.playbackRate;
  return state;
}
