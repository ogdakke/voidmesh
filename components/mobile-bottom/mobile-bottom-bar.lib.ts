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

/**
 * Bar item whose panel should be shown: the active item, or the first enabled item when
 * the active one has become disabled (e.g. the selection changed to entities without
 * palette support). When every item is disabled the active item is kept, so the choice
 * survives a deselect and reselect.
 */
export function resolveActiveBarItem<T extends string>(
  active: T | null,
  items: readonly T[],
  isDisabled: (item: T) => boolean,
): T | null {
  if (active === null || !isDisabled(active)) return active;
  return items.find((item) => !isDisabled(item)) ?? active;
}
