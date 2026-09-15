import { useState } from "react";
import {
  ColorFilter,
  Component,
  ControlSlider,
  Copy,
  Download,
  Palette,
  Settings,
} from "iconoir-react";
import { Canvas } from "./canvas";
import { MediaControls } from "./media-controls/media-controls.tsx";
import { MobileControls } from "./mobile-controls.tsx";
import { BottomBarItem, MobileBottomBar } from "./mobile-bottom/mobile-bottom-bar.tsx";
import { debugBarItem, items, type BarItem, type DebugBarItem } from "./mobile-bottom/bar-items.ts";
import { DeleteDropZone } from "./delete-drop-zone/delete-drop-zone.tsx";
import { ActionLayer } from "./action-layer/action-layer.tsx";
import { CopyPasteDrawer } from "./action-layer/copy-paste-drawer.tsx";
import { IonDuplicateOutline } from "./icons/duplicate.tsx";
import { MaterialSymbolsResetImage } from "./icons/reset-image.tsx";
import { MobileExportDrawer } from "./export-knobs/export-knobs.mobile.tsx";
import {
  useCanvasCommands,
  useDebugMode,
  useMultiSelectMode,
  useSelectedEntityIds,
} from "#context/use-canvas.ts";
import { useActionLayer } from "#hooks/use-action-layer.ts";
import { useLayout } from "#context/use-layout.ts";
import { useParamValue } from "#hooks/use-param-value.ts";
import { useEntityDrag } from "#hooks/use-entity-drag.ts";

function MobileActionLayer() {
  const { duplicateEntities, resetSelectionToDefaults } = useCanvasCommands();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [exportDrawerOpen, setExportDrawerOpen] = useState(false);

  return (
    <>
      <ActionLayer.Root>
        <ActionLayer.Item order={0} onAction={() => setDrawerOpen(true)} label="Copy/Paste Effects">
          <Copy />
        </ActionLayer.Item>
        <ActionLayer.Item order={1} onAction={duplicateEntities} label="Duplicate">
          <IonDuplicateOutline />
        </ActionLayer.Item>
        <ActionLayer.Item order={2} onAction={resetSelectionToDefaults} label="Reset">
          <MaterialSymbolsResetImage />
        </ActionLayer.Item>
        <ActionLayer.Item order={3} onAction={() => setExportDrawerOpen(true)} label="Export">
          <Download />
        </ActionLayer.Item>
      </ActionLayer.Root>
      <CopyPasteDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
      <MobileExportDrawer
        open={exportDrawerOpen}
        onOpenChange={setExportDrawerOpen}
        trigger={false}
      />
    </>
  );
}

function MobileFloat() {
  const [activeItem, setActiveItem] = useState<BarItem | DebugBarItem | null>(items.at(0)!);
  const multiSelectMode = useMultiSelectMode();
  const selectedEntityIds = useSelectedEntityIds();
  const { entityDragActive } = useEntityDrag();
  const { isFullscreen } = useLayout();
  const { active: actionLayerActive } = useActionLayer();
  const debugMode = useDebugMode();
  const palette = useParamValue("palette", null);
  const bottomBarDisabled = multiSelectMode || selectedEntityIds.size === 0 || isFullscreen;
  const hideMobileControls = isFullscreen || actionLayerActive || entityDragActive;
  const hideMediaControls = hideMobileControls || multiSelectMode;

  const propsMapByItem: Record<BarItem, { disabled: boolean }> = {
    "adjustments and post-processing": {
      disabled: bottomBarDisabled,
    },
    colors: {
      disabled: bottomBarDisabled || !palette.isSupported,
    },
    parameters: {
      disabled: bottomBarDisabled,
    },
    style: {
      disabled: bottomBarDisabled,
    },
  };

  return (
    <div className="mobile-float" data-fullscreen={isFullscreen || undefined}>
      <MobileActionLayer />
      <DeleteDropZone />
      <MediaControls hidden={hideMediaControls} />
      <div className="mobile-controls-container" hidden={hideMobileControls}>
        <MobileControls activeItem={activeItem} />
      </div>

      <MobileBottomBar
        items={items}
        onChange={(item) => setActiveItem(item as BarItem | DebugBarItem | null)}
        value={activeItem}
      >
        <BottomBarItem label="style" {...propsMapByItem["style"]}>
          <Component />
        </BottomBarItem>
        <BottomBarItem label="parameters" {...propsMapByItem["parameters"]}>
          <ControlSlider style={{ marginInline: "1px -1px" }} />
        </BottomBarItem>
        <BottomBarItem label="colors" {...propsMapByItem["colors"]}>
          <Palette />
        </BottomBarItem>
        <BottomBarItem
          label="adjustments and post-processing"
          {...propsMapByItem["adjustments and post-processing"]}
        >
          <ColorFilter />
        </BottomBarItem>
        {debugMode && (
          <BottomBarItem label={debugBarItem} disabled={isFullscreen}>
            <Settings />
          </BottomBarItem>
        )}
      </MobileBottomBar>
    </div>
  );
}

export default function MobileLayout() {
  return (
    <div className="mobile-layout">
      <div className="content mobile-content">
        <Canvas />
      </div>
      <MobileFloat />
    </div>
  );
}
