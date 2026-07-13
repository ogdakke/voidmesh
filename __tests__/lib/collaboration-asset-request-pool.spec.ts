import { describe, expect, it } from "vitest";
import { AssetRequestPool } from "#lib/collaboration/asset-request-pool.ts";

describe("AssetRequestPool", () => {
  it("bounds concurrent unique requests", () => {
    const pool = new AssetRequestPool(2);

    expect(pool.add("asset-a", "peer-a")).toBe(true);
    expect(pool.add("asset-a", "peer-a")).toBe(false);
    expect(pool.add("asset-b", "peer-a")).toBe(true);
    expect(pool.add("asset-c", "peer-a")).toBe(false);
    expect(pool.size).toBe(2);

    pool.delete("asset-a");
    expect(pool.add("asset-c", "peer-a")).toBe(true);
  });

  it("releases every request assigned to a departed peer", () => {
    const pool = new AssetRequestPool(4);
    pool.add("asset-a", "peer-a");
    pool.add("asset-b", "peer-b");
    pool.add("asset-c", "peer-a");

    expect(pool.deletePeer("peer-a")).toBe(2);
    expect(pool.has("asset-a")).toBe(false);
    expect(pool.has("asset-b")).toBe(true);
    expect(pool.size).toBe(1);
  });

  it("rejects invalid limits", () => {
    expect(() => new AssetRequestPool(0)).toThrow(/positive integer/);
  });
});
