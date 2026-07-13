import { describe, expect, it } from "vitest";
import { calculatePeerClockSample } from "#lib/collaboration/clock.ts";

describe("collaboration clock", () => {
  it("estimates remote clock offset without counting receiver processing as latency", () => {
    expect(calculatePeerClockSample(1_000, 1_110, 1_115, 1_025)).toEqual({
      offsetMs: 100,
      roundTripMs: 20,
    });
  });

  it("rejects timestamps that move backwards", () => {
    expect(() => calculatePeerClockSample(10, 20, 19, 30)).toThrow(/out of order/);
  });
});
