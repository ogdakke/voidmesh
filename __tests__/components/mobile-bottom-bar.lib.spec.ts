import { describe, expect, test } from "vitest";
import {
  getBottomBarCellAt,
  getBottomBarPillOffset,
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
