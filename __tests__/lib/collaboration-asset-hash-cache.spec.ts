import { describe, expect, it, vi } from "vitest";
import { AssetHashCache } from "#lib/collaboration/asset-hash-cache.ts";

describe("AssetHashCache", () => {
  it("shares one hash operation for duplicate Blob identities", async () => {
    const hash = vi.fn<(blob: Blob) => Promise<string>>(async (blob) => `hash-${blob.size}`);
    const cache = new AssetHashCache(hash);
    const blob = new Blob(["shared"]);

    const results = await Promise.all(Array.from({ length: 2_047 }, () => cache.get(blob)));

    expect(new Set(results)).toEqual(new Set(["hash-6"]));
    expect(hash).toHaveBeenCalledOnce();
  });

  it("hashes distinct Blob objects independently", async () => {
    const hash = vi.fn<(blob: Blob) => Promise<string>>(async (blob) => `hash-${blob.size}`);
    const cache = new AssetHashCache(hash);

    await Promise.all([cache.get(new Blob(["a"])), cache.get(new Blob(["b"]))]);

    expect(hash).toHaveBeenCalledTimes(2);
  });
});
