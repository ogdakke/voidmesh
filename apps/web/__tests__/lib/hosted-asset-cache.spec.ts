import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserHostedAssetCache } from "#lib/hosted-asset-cache.ts";

describe("BrowserHostedAssetCache", () => {
  afterEach(() => vi.restoreAllMocks());

  it("persists hosted originals in a workspace-scoped OPFS directory", async () => {
    const files = new Map<string, Blob>();
    const workspaceDirectory = {
      async removeEntry(name: string) {
        files.delete(name);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!files.has(name) && !options?.create) {
          throw new DOMException("Missing", "NotFoundError");
        }
        return {
          async createWritable() {
            return {
              async abort() {},
              async close() {},
              async write(blob: Blob) {
                files.set(name, blob);
              },
            };
          },
          async getFile() {
            return files.get(name)!;
          },
        };
      },
    };
    const assetsDirectory = {
      async getDirectoryHandle(name: string) {
        expect(name).toBe("workspace-1");
        return workspaceDirectory;
      },
    };
    const rootDirectory = {
      async getDirectoryHandle(name: string) {
        expect(name).toBe("voidmesh-hosted-assets");
        return assetsDirectory;
      },
    };
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { getDirectory: vi.fn(async () => rootDirectory) },
    });
    const cache = new BrowserHostedAssetCache("workspace-1");
    const original = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

    await cache.put("asset-1", original);
    const restored = await cache.get("asset-1", "image/png");

    expect(new Uint8Array(await restored!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(restored?.type).toBe("image/png");
    await cache.delete("asset-1");
    expect(await cache.get("asset-1", "image/png")).toBeNull();
  });
});
