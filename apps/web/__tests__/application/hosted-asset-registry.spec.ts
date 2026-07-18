import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { R2HostedAssetRegistry } from "#application/canvas/hosted-asset-registry.ts";
import { config } from "#config";
import type { HostedApiClient } from "#lib/hosted-api-client.ts";
import type { HostedAssetCache } from "#lib/hosted-asset-cache.ts";
import {
  HostedWorkspaceDocument,
  type HostedAssetReference,
  type HostedWorkspaceEntity,
} from "#lib/hosted-workspace-document.ts";
import { MediaType, ShaderType, type ShaderCanvasEntity } from "#types/canvas.ts";

class MemoryAssetCache implements HostedAssetCache {
  readonly values = new Map<string, Blob>();

  async delete(assetId: string): Promise<void> {
    this.values.delete(assetId);
  }

  async get(assetId: string, contentType: string): Promise<Blob | null> {
    const value = this.values.get(assetId);
    return value ? new Blob([value], { type: contentType }) : null;
  }

  async put(assetId: string, blob: Blob): Promise<void> {
    this.values.set(assetId, blob);
  }
}

function hostedEntity(asset: HostedAssetReference): HostedWorkspaceEntity {
  return {
    asset,
    edited: false,
    id: "entity-1",
    locked: false,
    name: "Offline source",
    originalSize: { height: 10, width: 10 },
    position: { x: 0, y: 0 },
    rotation: 0,
    shaderParams: structuredClone(config.defaults.shaderParams),
    shaderType: ShaderType.halftone,
    size: { height: 10, width: 10 },
    zIndex: 1,
  };
}

function runtimeEntity(blob: Blob, name: string): ShaderCanvasEntity {
  const imageBitmap = {} as ImageBitmap;
  return {
    edited: false,
    id: "entity-1",
    imageBitmap,
    locked: false,
    mediaSource: {
      asset: {
        alphaMode: "supported",
        blob,
        id: `local-${name}`,
        imageBitmap,
        revision: 0,
      },
      type: MediaType.image,
    },
    name,
    originalSize: { height: 10, width: 10 },
    position: { x: 0, y: 0 },
    rotation: 0,
    shaderParams: structuredClone(config.defaults.shaderParams),
    shaderType: ShaderType.halftone,
    size: { height: 10, width: 10 },
    zIndex: 1,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("R2HostedAssetRegistry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uploads cached offline originals before replacing provisional document references", async () => {
    const provisional: HostedAssetReference = {
      byteLength: 3,
      contentType: "image/png",
      id: "local_123",
      mediaType: "image",
      originalFilename: "offline.png",
    };
    const cache = new MemoryAssetCache();
    await cache.put(provisional.id, new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    const uploaded = {
      ...provisional,
      contentHash: null,
      id: "asset-remote",
      workspaceId: "workspace-1",
    };
    const api = {
      finalizeAssetUpload: vi.fn<HostedApiClient["finalizeAssetUpload"]>(async () => ({
        asset: uploaded,
      })),
      reserveAssetUpload: vi.fn<HostedApiClient["reserveAssetUpload"]>(async () => ({
        assetId: uploaded.id,
        expiresAt: Date.now() + 1_000,
        headers: { "content-type": "image/png" },
        reservationId: "reservation-1",
        uploadUrl: "https://uploads.example.test/object",
      })),
    } as unknown as HostedApiClient;
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
        Promise.resolve(new Response(null, { status: 204 })),
      ),
    );
    const registry = new R2HostedAssetRegistry(
      api,
      "workspace-1",
      cache,
      vi.fn<(error: unknown) => void>(),
      vi.fn<() => void>(),
    );
    const document = new HostedWorkspaceDocument({ document: new Y.Doc() });
    document.addEntity(hostedEntity(provisional));

    await registry.flushPending(document);

    expect(document.getEntity("entity-1")?.asset).toEqual(uploaded);
    expect(cache.values.has(provisional.id)).toBe(false);
    expect(cache.values.has(uploaded.id)).toBe(true);
    expect(api.reserveAssetUpload).toHaveBeenCalledOnce();
    expect(api.reserveAssetUpload).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        contentHash: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      }),
      expect.any(String),
    );
    expect(api.finalizeAssetUpload).toHaveBeenCalledOnce();
  });

  it("does not fail synchronization when an uploaded offline original cannot be evicted", async () => {
    const provisional: HostedAssetReference = {
      byteLength: 3,
      contentType: "image/png",
      id: "local_123",
      mediaType: "image",
      originalFilename: "offline.png",
    };
    const cache = new MemoryAssetCache();
    await cache.put(provisional.id, new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    const cacheError = new DOMException("The object can not be found here.", "NotFoundError");
    vi.spyOn(cache, "delete").mockRejectedValue(cacheError);
    const uploaded = {
      ...provisional,
      contentHash: null,
      id: "asset-remote",
      workspaceId: "workspace-1",
    };
    const api = {
      finalizeAssetUpload: vi.fn<HostedApiClient["finalizeAssetUpload"]>(async () => ({
        asset: uploaded,
      })),
      reserveAssetUpload: vi.fn<HostedApiClient["reserveAssetUpload"]>(async () => ({
        assetId: uploaded.id,
        expiresAt: Date.now() + 1_000,
        headers: { "content-type": "image/png" },
        reservationId: "reservation-1",
        uploadUrl: "https://uploads.example.test/object",
      })),
    } as unknown as HostedApiClient;
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
        Promise.resolve(new Response(null, { status: 204 })),
      ),
    );
    const onCacheError = vi.fn<(error: unknown) => void>();
    const registry = new R2HostedAssetRegistry(
      api,
      "workspace-1",
      cache,
      onCacheError,
      vi.fn<() => void>(),
    );
    const document = new HostedWorkspaceDocument({ document: new Y.Doc() });
    document.addEntity(hostedEntity(provisional));

    await expect(registry.flushPending(document)).resolves.toBeUndefined();

    expect(document.getEntity("entity-1")?.asset).toEqual(uploaded);
    expect(onCacheError).toHaveBeenCalledWith(cacheError);
  });

  it("binds references to media identity and ignores stale upload completion", async () => {
    const cache = new MemoryAssetCache();
    const firstBlob = new Blob([new Uint8Array([1])], { type: "image/png" });
    const secondBlob = new Blob([new Uint8Array([2])], { type: "image/png" });
    const adoptedBlob = new Blob([new Uint8Array([0])], { type: "image/png" });
    const adopted = {
      byteLength: adoptedBlob.size,
      contentType: adoptedBlob.type,
      id: "asset-adopted",
      mediaType: "image",
      originalFilename: "adopted.png",
    };
    type FinalizeResult = Awaited<ReturnType<HostedApiClient["finalizeAssetUpload"]>>;
    const firstFinalized = deferred<FinalizeResult>();
    const secondFinalized = deferred<FinalizeResult>();
    const uploaded = (id: string, filename: string): FinalizeResult["asset"] => ({
      byteLength: 1,
      contentHash: null,
      contentType: "image/png",
      id,
      mediaType: "image",
      originalFilename: filename,
      workspaceId: "workspace-1",
    });
    const api = {
      finalizeAssetUpload: vi.fn<HostedApiClient["finalizeAssetUpload"]>((_workspaceId, id) =>
        id === "reservation-first" ? firstFinalized.promise : secondFinalized.promise,
      ),
      reserveAssetUpload: vi.fn<HostedApiClient["reserveAssetUpload"]>(
        async (_workspaceId, request) => ({
          assetId: `asset-${request.originalFilename}`,
          expiresAt: Date.now() + 1_000,
          headers: { "content-type": "image/png" },
          reservationId: `reservation-${request.originalFilename.replace(".png", "")}`,
          uploadUrl: `https://uploads.example.test/${request.originalFilename}`,
        }),
      ),
    } as unknown as HostedApiClient;
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
        Promise.resolve(new Response(null, { status: 204 })),
      ),
    );
    const registry = new R2HostedAssetRegistry(
      api,
      "workspace-1",
      cache,
      vi.fn<(error: unknown) => void>(),
      vi.fn<() => void>(),
    );
    registry.adopt("entity-1", adopted, adoptedBlob);

    expect(
      await registry.register(
        runtimeEntity(adoptedBlob, "adopted.png"),
        new AbortController().signal,
      ),
    ).toBe(adopted);

    const firstRegistration = registry.register(
      runtimeEntity(firstBlob, "first.png"),
      new AbortController().signal,
    );
    const secondRegistration = registry.register(
      runtimeEntity(secondBlob, "second.png"),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(api.finalizeAssetUpload).toHaveBeenCalledTimes(2));

    const secondAsset = uploaded("asset-second", "second.png");
    secondFinalized.resolve({ asset: secondAsset });
    await expect(secondRegistration).resolves.toEqual(secondAsset);
    expect(registry.getReference("entity-1")).toEqual(secondAsset);

    firstFinalized.resolve({ asset: uploaded("asset-first", "first.png") });
    await firstRegistration;
    expect(registry.getReference("entity-1")).toEqual(secondAsset);

    registry.release("entity-1");
    expect(registry.getReference("entity-1")).toBeUndefined();
  });
});
