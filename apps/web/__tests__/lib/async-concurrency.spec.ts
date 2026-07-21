import { describe, expect, test } from "vitest";
import { mapSettledWithConcurrency } from "#lib/async-concurrency.ts";

describe("mapSettledWithConcurrency", () => {
  test("preserves input order and settles mapper failures", async () => {
    const results = await mapSettledWithConcurrency([3, 1, 2], 2, async (value) => {
      await Promise.resolve();
      if (value === 1) throw new Error("failed");
      return value * 2;
    });

    expect(results[0]).toEqual({ status: "fulfilled", value: 6 });
    expect(results[1]).toEqual({ status: "rejected", reason: new Error("failed") });
    expect(results[2]).toEqual({ status: "fulfilled", value: 4 });
  });

  test("rejects invalid concurrency", async () => {
    await expect(mapSettledWithConcurrency([1], 0, async (value) => value)).rejects.toThrow(
      "Concurrency must be a positive integer",
    );
  });
});
