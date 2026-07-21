import type { Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { getOrCreateReactRoot } from "#lib/react-root.ts";

describe("getOrCreateReactRoot", () => {
  it("reuses the root retained by Vite hot data", () => {
    const hotData: Record<string, unknown> = {};
    const root = {} as Root;
    const createRoot = vi.fn<() => Root>(() => root);

    expect(getOrCreateReactRoot(hotData, createRoot)).toBe(root);
    expect(getOrCreateReactRoot(hotData, createRoot)).toBe(root);
    expect(createRoot).toHaveBeenCalledOnce();
  });
});
