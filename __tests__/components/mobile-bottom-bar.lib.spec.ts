import { describe, expect, test } from "vitest";
import {
  getBottomBarCellAt,
  getBottomBarPillOffset,
  resolveActiveBarItem,
} from "#components/mobile-bottom/mobile-bottom-bar.lib.ts";

describe("bottom bar pill drag geometry", () => {
  const starts = [0, 74, 148, 222];
  const cellSize = 70;

  test("centres the pill under the pointer within the first and last cells", () => {
    expect(getBottomBarPillOffset(110, starts, cellSize)).toBe(75);
    expect(getBottomBarPillOffset(-40, starts, cellSize)).toBe(0);
    expect(getBottomBarPillOffset(400, starts, cellSize)).toBe(222);
  });

  test("picks the cell nearest the pill", () => {
    expect(getBottomBarCellAt(0, starts)).toBe(0);
    expect(getBottomBarCellAt(36, starts)).toBe(0);
    expect(getBottomBarCellAt(38, starts)).toBe(1);
    expect(getBottomBarCellAt(200, starts)).toBe(3);
  });
});

describe("resolveActiveBarItem", () => {
  const items = ["style", "colors", "parameters"] as const;
  type Item = (typeof items)[number];
  const disabledSet =
    (...disabled: Item[]) =>
    (item: Item) =>
      disabled.includes(item);

  test("keeps an enabled active item", () => {
    expect(resolveActiveBarItem<Item>("colors", items, disabledSet())).toBe("colors");
  });

  test("falls back to the first enabled item when the active one becomes disabled", () => {
    expect(resolveActiveBarItem<Item>("colors", items, disabledSet("colors"))).toBe("style");
    expect(resolveActiveBarItem<Item>("colors", items, disabledSet("style", "colors"))).toBe(
      "parameters",
    );
  });

  test("keeps the active item when every item is disabled", () => {
    expect(
      resolveActiveBarItem<Item>("colors", items, disabledSet("style", "colors", "parameters")),
    ).toBe("colors");
  });

  test("keeps no selection", () => {
    expect(resolveActiveBarItem<Item>(null, items, disabledSet("style"))).toBeNull();
  });
});
