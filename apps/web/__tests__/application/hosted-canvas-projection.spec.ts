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
});
