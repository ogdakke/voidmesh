import { describe, expect, it } from "vitest";
import { isIdentifier } from "../src/index.ts";

describe("API contract validation", () => {
  it("accepts bounded opaque identifiers", () => {
    expect(isIdentifier("workspace_01JABC-def")).toBe(true);
  });

  it("rejects paths and oversized identifiers", () => {
    expect(isIdentifier("../workspace")).toBe(false);
    expect(isIdentifier("x".repeat(129))).toBe(false);
  });
});
