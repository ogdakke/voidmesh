/** Pointer movement (px) before a press on the tab bar becomes a pill drag. */
export const BOTTOM_BAR_DRAG_THRESHOLD_PX = 6;

/**
 * Pill offset from the first cell for a pointer at `pointer` (same axis and origin as
 * `cellStarts`): centred under the finger, clamped to the first and last cells.
 */
export function getBottomBarPillOffset(
  pointer: number,
  cellStarts: readonly number[],
  cellSize: number,
): number {
  const last = cellStarts.at(-1) ?? 0;
  return Math.min(Math.max(pointer - cellSize / 2, 0), last);
}

/** Index of the cell whose start is nearest the pill offset. */
export function getBottomBarCellAt(offset: number, cellStarts: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < cellStarts.length; index++) {
    if (Math.abs(cellStarts[index]! - offset) < Math.abs(cellStarts[best]! - offset)) {
      best = index;
    }
  }
  return best;
}
