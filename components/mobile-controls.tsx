import { useMultiSelectMode, useSelectedEntityIds } from "#context/use-canvas.ts";
import type { BarItem } from "./mobile-bottom/bar-items.ts";
import { MobileStyleKnobs } from "./knobs/style-knobs";
import { ParamsKnobs } from "./knobs/params-knobs";
import { PostProcessMobileKnobs } from "./knobs/post-process-knobs";
import { MobileColorKnobs } from "./knobs/mobile-color-knobs";
import { MultiSelectionControls } from "./multi-selection-controls";
import { UploadControls } from "./upload-button-controls";
import { MobileExportKnobs } from "./export-knobs/export-knobs.mobile.tsx";

interface MobileControlsProps {
  activeItem: BarItem | null;
}

export function MobileControls({ activeItem }: MobileControlsProps) {
  const selectedEntityIds = useSelectedEntityIds();
  const multiSelectMode = useMultiSelectMode();
  const hasSelection = selectedEntityIds.size > 0;

  if (multiSelectMode) {
    return <MultiSelectionControls />;
  }

  if (!hasSelection) {
    return <UploadControls />;
  }

  if (activeItem === "export") {
    return <MobileExportKnobs />;
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
