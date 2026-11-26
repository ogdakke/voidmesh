import { useState } from "react";
import {
  useDebugMode,
  useMultiSelectMode,
  useSelectedEntityIds,
  useSelectionChangeListener,
} from "#context/use-canvas.ts";
import { useLayout } from "#context/use-layout.ts";
import { useParamValue } from "#hooks/use-param-value.ts";
import { debugBarItem, items, type BarItem, type DebugBarItem } from "./bar-items.ts";
import { resolveActiveBarItem } from "./mobile-bottom-bar.lib.ts";

export type MobileBarItem = BarItem | DebugBarItem;

/**
 * Active mobile bar item and per-item disabled state. When the active item becomes disabled
 * from outside the bar (selection or effect change), the first enabled item is shown instead,
 * and that fallback sticks once the selection changes again.
 */
export function useMobileBarItems() {
  const [selectedItem, setSelectedItem] = useState<MobileBarItem | null>(items[0]);
  const multiSelectMode = useMultiSelectMode();
  const selectedEntityIds = useSelectedEntityIds();
  const { isFullscreen } = useLayout();
  const debugMode = useDebugMode();
  const palette = useParamValue("palette", null);
  const barDisabled = multiSelectMode || selectedEntityIds.size === 0 || isFullscreen;

  const disabledByItem: Record<MobileBarItem, boolean> = {
    style: barDisabled,
    colors: barDisabled || !palette.isSupported,
    parameters: barDisabled,
    "adjustments and post-processing": barDisabled,
    [debugBarItem]: !debugMode || isFullscreen,
  };

  const activeItem = resolveActiveBarItem<MobileBarItem>(
    selectedItem,
    debugMode ? [...items, debugBarItem] : items,
    (item) => disabledByItem[item],
  );
  // Adopt the shown item before the next selection change renders, so re-enabling the
  // originally picked item does not jump back to it.
  useSelectionChangeListener(() => setSelectedItem(activeItem));

  return { activeItem, disabledByItem, setActiveItem: setSelectedItem };
}
