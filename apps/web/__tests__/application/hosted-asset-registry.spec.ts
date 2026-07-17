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
import { ShaderType } from "#types/canvas.ts";

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
});
