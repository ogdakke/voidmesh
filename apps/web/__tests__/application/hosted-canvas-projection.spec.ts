import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2HostedAssetRegistry } from "#application/canvas/hosted-asset-registry.ts";
import { HostedCanvasProjectionService } from "#application/canvas/hosted-canvas-projection.ts";
import { config } from "#config";
import { CanvasStore } from "#engine";
import type { HostedApiClient } from "#lib/hosted-api-client.ts";
import type { HostedAssetCache } from "#lib/hosted-asset-cache.ts";
import type {
  HostedAssetReference,
  HostedWorkspaceEntity,
} from "#lib/hosted-workspace-document.ts";
import { ShaderType } from "#types/canvas.ts";
import { mockAllMediaAPIs } from "../mocks/media.mock.ts";

function hostedEntity(id: string, asset: HostedAssetReference): HostedWorkspaceEntity {
  return {
    asset,
    edited: false,
    id,
    locked: false,
    name: asset.originalFilename,
    originalSize: { height: 10, width: 10 },
    position: { x: 0, y: 0 },
    rotation: 0,
    shaderParams: structuredClone(config.defaults.shaderParams),
    shaderType: ShaderType.halftone,
    size: { height: 10, width: 10 },
    zIndex: 1,
  };
}

describe("HostedCanvasProjectionService", () => {
  let cleanupMedia: () => void;

  beforeEach(() => {
    cleanupMedia = mockAllMediaAPIs();
  });

  afterEach(() => {
    cleanupMedia();
    vi.restoreAllMocks();
  });

  it("releases the previous shared image and downloaded blob when an asset changes", async () => {
    const firstAsset: HostedAssetReference = {
      byteLength: 1,
      contentType: "image/png",
      id: "asset-first",
      mediaType: "image",
      originalFilename: "first.png",
    };
    const secondAsset: HostedAssetReference = {
      ...firstAsset,
      id: "asset-second",
      originalFilename: "second.png",
    };
    const get = vi.fn<HostedAssetCache["get"]>(
      async (assetId, contentType) =>
        new Blob([new Uint8Array([assetId === firstAsset.id ? 1 : 2])], { type: contentType }),
    );
    const cache: HostedAssetCache = {
      delete: async () => {},
      get,
      put: async () => {},
    };
    const api = {} as HostedApiClient;
    const assets = new R2HostedAssetRegistry(
      api,
      "workspace-1",
      cache,
      vi.fn<(error: unknown) => void>(),
      vi.fn<() => void>(),
    );
    const store = new CanvasStore();
    const mutations = vi.fn<Parameters<CanvasStore["subscribeEntityMutations"]>[0]>();
    store.subscribeEntityMutations(mutations);
    const projection = new HostedCanvasProjectionService({
      api,
      assets,
      cache,
      onError: (error) => {
        throw error;
      },
      requestRender: () => {},
      store,
      workspaceId: "workspace-1",
    });

    await projection.applyRemoteEntity(hostedEntity("entity-1", firstAsset), false);
    expect(mutations).toHaveBeenLastCalledWith(expect.objectContaining({ projected: true }));
    const firstEntity = store.getState().entities.get("entity-1");
    if (firstEntity?.mediaSource.type !== "image") throw new Error("Expected first image");
    const closeFirst = vi.spyOn(firstEntity.mediaSource.asset.imageBitmap, "close");

    await projection.applyRemoteEntity(hostedEntity("entity-1", secondAsset), false);
    expect(closeFirst).toHaveBeenCalledOnce();

    await expect(
      projection.applyRemoteEntity(hostedEntity("entity-2", firstAsset), false),
    ).resolves.toBeUndefined();
    expect(get.mock.calls.filter(([assetId]) => assetId === firstAsset.id)).toHaveLength(2);

    projection.removeRemoteEntities(["entity-1", "entity-2"]);
    expect(mutations).toHaveBeenLastCalledWith(expect.objectContaining({ projected: true }));
    await projection.applyRemoteEntity(hostedEntity("entity-3", firstAsset), false);
    expect(get.mock.calls.filter(([assetId]) => assetId === firstAsset.id)).toHaveLength(3);

    projection.removeRemoteEntities(["entity-3"]);
  });

  it("stages a remote workspace with bounded loading and one canvas insertion", async () => {
    const pendingLoads = new Map<string, () => void>();
    let activeLoads = 0;
    let peakActiveLoads = 0;
    const get = vi.fn<HostedAssetCache["get"]>(async (assetId, contentType) => {
      activeLoads++;
      peakActiveLoads = Math.max(peakActiveLoads, activeLoads);
      await new Promise<void>((resolve) => pendingLoads.set(assetId, resolve));
      activeLoads--;
      return new Blob([new Uint8Array([1])], { type: contentType });
    });
    const cache: HostedAssetCache = {
      delete: async () => {},
      get,
      put: async () => {},
    };
    const api = {} as HostedApiClient;
    const assets = new R2HostedAssetRegistry(
      api,
      "workspace-1",
      cache,
      vi.fn<(error: unknown) => void>(),
      vi.fn<() => void>(),
    );
    const store = new CanvasStore();
    const mutations = vi.fn<Parameters<CanvasStore["subscribeEntityMutations"]>[0]>();
    store.subscribeEntityMutations(mutations);
    const requestRender = vi.fn<() => void>();
    const projection = new HostedCanvasProjectionService({
      api,
      assets,
      cache,
      onError: (error) => {
        throw error;
      },
      requestRender,
      store,
      workspaceId: "workspace-1",
    });
    const entities = Array.from({ length: 6 }, (_, index) => {
      const remoteAsset: HostedAssetReference = {
        byteLength: 1,
        contentType: "image/png",
        id: `asset-${index}`,
        mediaType: "image",
        originalFilename: `${index}.png`,
      };
      return hostedEntity(`entity-${index}`, remoteAsset);
    });

    const loading = projection.applyRemoteEntities(
      entities.map((entity) => ({ applyPlayback: false, entity })),
    );
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    expect(store.getState().entities).toHaveLength(0);
    for (let index = 0; index < 4; index++) pendingLoads.get(`asset-${index}`)!();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(6));
    expect(store.getState().entities).toHaveLength(0);
    for (let index = 4; index < 6; index++) pendingLoads.get(`asset-${index}`)!();
    await loading;

    expect(peakActiveLoads).toBe(4);
    expect(store.getState().entities).toHaveLength(6);
    expect(mutations).toHaveBeenCalledOnce();
    expect(mutations).toHaveBeenCalledWith({
      entities: expect.arrayContaining(
        entities.map((entity) => expect.objectContaining({ id: entity.id })),
      ),
      projected: true,
      type: "add",
    });
    expect(requestRender).toHaveBeenCalledOnce();

    projection.removeRemoteEntities(entities.map((entity) => entity.id));
  });

  it("downloads identical hosted content once across distinct asset IDs", async () => {
    const contentHash = "a".repeat(64);
    const firstAsset: HostedAssetReference = {
      byteLength: 1,
      contentHash,
      contentType: "image/png",
      id: "asset-copy-1",
      mediaType: "image",
      originalFilename: "copy-1.png",
    };
    const secondAsset: HostedAssetReference = {
      ...firstAsset,
      id: "asset-copy-2",
      originalFilename: "copy-2.png",
    };
    const get = vi.fn<HostedAssetCache["get"]>(async (_assetId, contentType) =>
      Promise.resolve(new Blob([new Uint8Array([1])], { type: contentType })),
    );
    const cache: HostedAssetCache = {
      delete: async () => {},
      get,
      put: async () => {},
    };
    const api = {} as HostedApiClient;
    const assets = new R2HostedAssetRegistry(
      api,
      "workspace-1",
      cache,
      vi.fn<(error: unknown) => void>(),
      vi.fn<() => void>(),
    );
    const store = new CanvasStore();
    const projection = new HostedCanvasProjectionService({
      api,
      assets,
      cache,
      onError: (error) => {
        throw error;
      },
      requestRender: () => {},
      store,
      workspaceId: "workspace-1",
    });

    await projection.applyRemoteEntities([
      { applyPlayback: false, entity: hostedEntity("entity-copy-1", firstAsset) },
      { applyPlayback: false, entity: hostedEntity("entity-copy-2", secondAsset) },
    ]);

    expect(get).toHaveBeenCalledOnce();
    projection.removeRemoteEntities(["entity-copy-1", "entity-copy-2"]);
  });

  it("reports one aggregate error for a failed workspace batch", async () => {
    const cache: HostedAssetCache = {
      delete: async () => {},
      get: async (assetId) => {
        throw new Error(`failed ${assetId}`);
      },
      put: async () => {},
    };
    const api = {
      createAssetContent: vi.fn<HostedApiClient["createAssetContent"]>(async () => {
        throw new Error("download unavailable");
      }),
    } as unknown as HostedApiClient;
    const assets = new R2HostedAssetRegistry(
      api,
      "workspace-1",
      cache,
      vi.fn<(error: unknown) => void>(),
      vi.fn<() => void>(),
    );
    const onError = vi.fn<(error: unknown) => void>();
    const projection = new HostedCanvasProjectionService({
      api,
      assets,
      cache,
      onCacheError: () => {},
      onError,
      requestRender: () => {},
      store: new CanvasStore(),
      workspaceId: "workspace-1",
    });
    const entries = ["first", "second"].map((id) => ({
      applyPlayback: false,
      entity: hostedEntity(`entity-${id}`, {
        byteLength: 1,
        contentType: "image/png",
        id: `asset-${id}`,
        mediaType: "image",
        originalFilename: `${id}.png`,
      }),
    }));

    await projection.applyRemoteEntities(entries);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        errors: expect.arrayContaining([expect.any(Error), expect.any(Error)]),
        message: "2 hosted media items could not be loaded",
      }),
    );
  });
});
