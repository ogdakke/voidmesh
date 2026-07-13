import { describe, expect, it, vi } from "vitest";
import { AssetTransferLimiter } from "#lib/collaboration/asset-transfer-limiter.ts";

describe("AssetTransferLimiter", () => {
  it("allows bounded concurrent payloads within the byte budget", async () => {
    const limiter = new AssetTransferLimiter(4, 10);
    const releases = await Promise.all([
      limiter.acquire(2),
      limiter.acquire(3),
      limiter.acquire(5),
    ]);
    const fourth = vi.fn<(release: () => void) => void>();
    void limiter.acquire(1).then(fourth);

    await Promise.resolve();
    expect(fourth).not.toHaveBeenCalled();

    releases[0]!();
    await Promise.resolve();
    expect(fourth).toHaveBeenCalledOnce();
  });

  it("runs one payload larger than the byte budget by itself", async () => {
    const limiter = new AssetTransferLimiter(4, 10);
    const releaseSmall = await limiter.acquire(2);
    const large = vi.fn<(release: () => void) => void>();
    void limiter.acquire(20).then(large);

    await Promise.resolve();
    expect(large).not.toHaveBeenCalled();

    releaseSmall();
    await Promise.resolve();
    expect(large).toHaveBeenCalledOnce();
  });

  it("rejects queued payloads when cancelled", async () => {
    const limiter = new AssetTransferLimiter(1, 10);
    await limiter.acquire(1);
    const queued = limiter.acquire(1);
    limiter.cancel(new Error("peer left"));

    await expect(queued).rejects.toThrow("peer left");
  });
});
