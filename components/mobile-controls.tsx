import { lazy, Suspense } from "react";
import { useDebugMode, useMultiSelectMode, useSelectedEntityIds } from "#context/use-canvas.ts";
import { debugBarItem, type BarItem, type DebugBarItem } from "./mobile-bottom/bar-items.ts";
import { MobileStyleKnobs } from "./knobs/style-knobs";
import { ParamsKnobs } from "./knobs/params-knobs";
import { PostProcessMobileKnobs } from "./knobs/post-process-knobs";
import { MobileColorKnobs } from "./knobs/mobile-color-knobs";
import { MultiSelectionControls } from "./multi-selection-controls";
import { UploadControls } from "./upload-button-controls";

interface MobileControlsProps {
  activeItem: BarItem | DebugBarItem | null;
}

const WlurDebugKnobs = lazy(() => import("./knobs/wlur-debug-knobs.tsx"));

export function MobileControls({ activeItem }: MobileControlsProps) {
  const selectedEntityIds = useSelectedEntityIds();
  const multiSelectMode = useMultiSelectMode();
  const debugMode = useDebugMode();
  const hasSelection = selectedEntityIds.size > 0;

  if (activeItem === debugBarItem && debugMode) {
    return (
      <Suspense fallback={null}>
        <WlurDebugKnobs />
      </Suspense>
    );
  }

  if (multiSelectMode) {
    return <MultiSelectionControls />;
  }

  if (!hasSelection) {
    return <UploadControls />;
  }

  if (activeItem === "style") {
    return <MobileStyleKnobs />;
  }

  if (activeItem === "parameters") {
    return <ParamsKnobs />;
  }

  if (activeItem === "adjustments and post-processing") {
    return <PostProcessMobileKnobs />;
  }
  if (activeItem === "colors") {
    return <MobileColorKnobs />;
  }

  return null;
}
