import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  HostedCanvasSync,
  type HostedAssetRegistry,
  type HostedCanvasSource,
} from "#application/canvas/hosted-canvas-sync.ts";
import type { CanvasEntityMutation } from "#engine";
import {
  HostedWorkspaceDocument,
  type HostedAssetReference,
  type HostedWorkspaceEntity,
} from "#lib/hosted-workspace-document.ts";
import { config } from "#config";
import { MediaType, ShaderType } from "#types/canvas.ts";
import type { ShaderCanvasEntity } from "#types/canvas.ts";

const asset: HostedAssetReference = {
  byteLength: 100,
  contentType: "image/png",
  id: "asset-1",
  mediaType: "image",
  originalFilename: "source.png",
};

function runtimeEntity(): ShaderCanvasEntity {
  return {
    edited: false,
    id: "entity-1",
    imageBitmap: {} as ImageBitmap,
    locked: false,
    mediaSource: {
      asset: {
        alphaMode: "supported",
        blob: new Blob(),
        id: "local-asset",
        imageBitmap: {} as ImageBitmap,
        revision: 0,
      },
      type: MediaType.image,
    },
    name: "Source",
    originalSize: { height: 100, width: 100 },
    position: { x: 0, y: 0 },
    rotation: 0,
    shaderParams: structuredClone(config.defaults.shaderParams),
    shaderType: ShaderType.halftone,
    size: { height: 100, width: 100 },
    zIndex: 1,
  };
}

class FakeSource implements HostedCanvasSource {
  readonly entities = new Map<string, ShaderCanvasEntity>();
  readonly listeners = new Set<(mutation: CanvasEntityMutation) => void>();

  getEntity(id: string): ShaderCanvasEntity | undefined {
    return this.entities.get(id);
  }

  getEntities(): readonly ShaderCanvasEntity[] {
    return [...this.entities.values()];
  }

  subscribeMutations(listener: (mutation: CanvasEntityMutation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(mutation: CanvasEntityMutation): void {
    for (const listener of this.listeners) listener(mutation);
  }
}

describe("HostedCanvasSync", () => {
  it("registers an asset before publishing a local entity", async () => {
    const source = new FakeSource();
    const entity = runtimeEntity();
    source.entities.set(entity.id, entity);
    const document = new HostedWorkspaceDocument({ document: new Y.Doc(), now: () => 1_000 });
    const register = vi.fn<HostedAssetRegistry["register"]>(async () => asset);
    const assets: HostedAssetRegistry = { getReference: () => asset, register, release: () => {} };
    const sync = new HostedCanvasSync({
      assets,
      document,
      onError: (error) => {
        throw error;
      },
      projection: { applyRemoteEntity: async () => {}, removeRemoteEntities: () => {} },
      source,
      writable: true,
    });
    sync.start();
    source.emit({ entities: [entity], type: "add" });

    await vi.waitFor(() => expect(document.getEntity(entity.id)?.asset).toEqual(asset));
    expect(register).toHaveBeenCalledOnce();
    sync.destroy();
  });

  it("releases the hosted asset binding when a local entity is removed", async () => {
    const source = new FakeSource();
    const entity = runtimeEntity();
    source.entities.set(entity.id, entity);
    const document = new HostedWorkspaceDocument({ document: new Y.Doc(), now: () => 1_000 });
    document.addEntity({
      asset,
      edited: entity.edited,
      id: entity.id,
      locked: entity.locked ?? false,
      name: entity.name,
      originalSize: entity.originalSize,
      position: entity.position,
      rotation: entity.rotation,
      shaderParams: entity.shaderParams,
      shaderType: entity.shaderType,
      size: entity.size,
      zIndex: entity.zIndex,
    });
    const release = vi.fn<(entityId: string) => void>();
    const sync = new HostedCanvasSync({
      assets: { getReference: () => asset, register: async () => asset, release },
      document,
      onError: (error) => {
        throw error;
      },
      projection: { applyRemoteEntity: async () => {}, removeRemoteEntities: () => {} },
      source,
      writable: true,
    });
    sync.start();

    source.entities.delete(entity.id);
    source.emit({ entityIds: [entity.id], type: "remove" });

    expect(release).toHaveBeenCalledWith(entity.id);
    expect(document.getEntity(entity.id)).toBeNull();
    sync.destroy();
  });

  it("suppresses canvas mutation echoes while projecting remote changes", async () => {
    const remoteY = new Y.Doc();
    const localY = new Y.Doc();
    const remote = new HostedWorkspaceDocument({ document: remoteY, now: () => 1_000 });
    const local = new HostedWorkspaceDocument({ document: localY, now: () => 1_000 });
    const source = new FakeSource();
    const register = vi.fn<HostedAssetRegistry["register"]>(async () => asset);
    const applyRemoteEntity = vi.fn<
      (entity: HostedWorkspaceEntity, applyPlayback: boolean) => Promise<void>
    >(async (entity: HostedWorkspaceEntity, _applyPlayback: boolean) => {
      const runtime = runtimeEntity();
      runtime.position = { ...entity.position };
      source.entities.set(runtime.id, runtime);
      source.emit({
        batch: [{ id: runtime.id, updates: { position: runtime.position } }],
        type: "update",
      });
    });
    const sync = new HostedCanvasSync({
      assets: { getReference: () => asset, register, release: () => {} },
      document: local,
      onError: (error) => {
        throw error;
      },
      projection: { applyRemoteEntity, removeRemoteEntities: () => {} },
      source,
      writable: true,
    });
    sync.start();
    const hosted = {
      asset,
      edited: false,
      id: "entity-1",
      locked: false,
      name: "Source",
      originalSize: { height: 100, width: 100 },
      position: { x: 12, y: 24 },
      rotation: 0,
      shaderParams: structuredClone(config.defaults.shaderParams),
      shaderType: ShaderType.halftone,
      size: { height: 100, width: 100 },
      zIndex: 1,
    };
    remote.addEntity(hosted);
    Y.applyUpdate(localY, Y.encodeStateAsUpdate(remoteY));

    await vi.waitFor(() => expect(applyRemoteEntity).toHaveBeenCalledOnce());
    expect(register).not.toHaveBeenCalled();
    sync.destroy();
  });

  it("reprojects active shader playback anchors during the drift guard", async () => {
    const remoteY = new Y.Doc();
    const localY = new Y.Doc();
    let now = 1_000;
    const remote = new HostedWorkspaceDocument({ document: remoteY, now: () => 1_000 });
    const local = new HostedWorkspaceDocument({ document: localY, now: () => now });
    const source = new FakeSource();
    const applyRemoteEntity = vi.fn<
      (entity: HostedWorkspaceEntity, applyPlayback: boolean) => Promise<void>
    >(async (_entity: HostedWorkspaceEntity, _applyPlayback: boolean) => {});
    const sync = new HostedCanvasSync({
      assets: { getReference: () => asset, register: async () => asset, release: () => {} },
      document: local,
      onError: (error) => {
        throw error;
      },
      projection: { applyRemoteEntity, removeRemoteEntities: () => {} },
      source,
      writable: true,
    });
    sync.start();
    const entity = runtimeEntity();
    entity.shaderParams.time = 2;
    entity.shaderParams.timeAutoPlay = true;
    remote.addEntity({
      asset,
      edited: entity.edited,
      id: entity.id,
      locked: entity.locked ?? false,
      name: entity.name,
      originalSize: entity.originalSize,
      position: entity.position,
      rotation: entity.rotation,
      shaderParams: entity.shaderParams,
      shaderType: entity.shaderType,
      size: entity.size,
      zIndex: entity.zIndex,
    });
    Y.applyUpdate(localY, Y.encodeStateAsUpdate(remoteY));
    await vi.waitFor(() => expect(applyRemoteEntity).toHaveBeenCalledOnce());

    now = 3_000;
    sync.refreshPlayback();
    await vi.waitFor(() => expect(applyRemoteEntity).toHaveBeenCalledTimes(2));
    expect(applyRemoteEntity.mock.calls[1]![0].shaderParams.time).toBe(4);
    sync.destroy();
  });
});
