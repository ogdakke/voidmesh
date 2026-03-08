import { useState } from "react";
import {
  ColorFilter,
  Component,
  ControlSlider,
  Copy,
  Download,
  MediaVideo,
  Palette,
  ScaleFrameEnlarge,
} from "iconoir-react";
import { Canvas } from "./canvas";
import { MediaControls } from "./infinite-canvas/media-controls.tsx";
import { MobileControls } from "./mobile-controls.tsx";
import { BottomBarItem, MobileBottomBar } from "./mobile-bottom/mobile-bottom-bar.tsx";
import { items, type BarItem } from "./mobile-bottom/bar-items.ts";
import { DeleteDropZone } from "./delete-drop-zone/delete-drop-zone.tsx";
import { ActionLayer } from "./action-layer/action-layer.tsx";
import { CopyPasteDrawer } from "./action-layer/copy-paste-drawer.tsx";
import { IonDuplicateOutline } from "./icons/duplicate.tsx";
import { Drawer } from "#ui/drawer/index.tsx";
import { useCanvas } from "#context/use-canvas.ts";
import { useCanvasActions } from "#hooks/use-canvas-actions.ts";
import { useExportQueue } from "#context/use-export-queue.ts";
import { useUpscaleQueue } from "#context/use-upscale-queue.ts";
import { useActionLayer } from "#hooks/use-action-layer.ts";
import { useLayout } from "#context/use-layout.ts";
import { useParamValue } from "#hooks/use-param-value.ts";
import { isAnimatedEntity } from "#types/canvas.ts";
import { canvasStore } from "#engine";
import { useEntityDrag } from "#hooks/use-entity-drag.ts";
import { toastManager } from "#ui/toast/toast-manager.ts";

function MobileActionLayer() {
  const { saveSelectedEntityToFile, renderer } = useCanvas();
  const { duplicateEntities } = useCanvasActions();
  const { addToQueue } = useExportQueue();
  const { addToUpscaleQueue } = useUpscaleQueue();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleUpscale = () => {
    const selectedIds = canvasStore.getSelectedEntities().map((e) => e.id);
    if (selectedIds.length > 0) {
      addToUpscaleQueue(selectedIds);
      const n = selectedIds.length;
      toastManager.add({
        title: `Upscaling ${n === 1 ? "file" : `${n} files`}`,
        description: "The upscaled version will appear on the canvas",
      });
    }
  };

  const handleSave = () => {
    // Check if the selected entity is animated — export instead of save
    const selectedEntities = canvasStore.getSelectedEntities();
    const animated = selectedEntities.filter(isAnimatedEntity);
    if (animated.length > 0 && renderer) {
      for (const entity of animated) {
        addToQueue(entity, renderer);
      }
      const n = animated.length;
      const count = `${n} ${n === 1 ? "file" : "files"}`;
      toastManager.add({
        title: `Exporting ${count}`,
        description: "See progress in exports tab",
      });
    } else {
      saveSelectedEntityToFile();
    }
  };

  // Determine label based on selection type
  const selectedEntities = canvasStore.getSelectedEntities();
  const hasAnimated = selectedEntities.some(isAnimatedEntity);

  return (
    <>
      <ActionLayer.Root>
        <ActionLayer.Item onAction={() => setDrawerOpen(true)} label="Copy/Paste Effects">
          <Copy />
        </ActionLayer.Item>
        <ActionLayer.Item onAction={duplicateEntities} label="Duplicate">
          <IonDuplicateOutline />
        </ActionLayer.Item>
        <ActionLayer.Item onAction={handleUpscale} label="Upscale 2×">
          <ScaleFrameEnlarge />
        </ActionLayer.Item>
        <ActionLayer.Item onAction={handleSave} label={hasAnimated ? "Export" : "Save"}>
          {hasAnimated ? <MediaVideo /> : <Download />}
        </ActionLayer.Item>
      </ActionLayer.Root>
      <CopyPasteDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
    </>
  );
}

function MobileFloat() {
  const [activeItem, setActiveItem] = useState<BarItem | null>(items.at(0)!);
  const { multiSelectMode, selectedEntityIds } = useCanvas();
  const { entityDragActive } = useEntityDrag();
  const { isFullscreen } = useLayout();
  const { active: actionLayerActive } = useActionLayer();
  const palette = useParamValue("palette", null);
  const bottomBarDisabled = multiSelectMode || selectedEntityIds.size === 0 || isFullscreen;

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
    export: {
      // TODO: maybe show exports button and commit multi-selection if user clicks on it?
      disabled: bottomBarDisabled,
    },
  };

  return (
    <div className="mobile-float">
      <MobileActionLayer />
      <DeleteDropZone />
      {!isFullscreen && !multiSelectMode && !actionLayerActive && !entityDragActive && (
        <MediaControls />
      )}
      {!isFullscreen && (
        <div className="mobile-controls-container">
          <MobileControls activeItem={activeItem} />
        </div>
      )}

      <MobileBottomBar items={items} onChange={setActiveItem} value={activeItem}>
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
        <BottomBarItem label="export" {...propsMapByItem["export"]}>
          <Download />
        </BottomBarItem>
      </MobileBottomBar>
    </div>
  );
}

export default function MobileLayout() {
  return (
    <Drawer.Provider>
      <div className="drawer-indent-root">
        <Drawer.IndentBackground className="drawer-indent-bg" />
        <Drawer.Indent className="drawer-indent">
          <div className="mobile-layout">
            <div className="content mobile-content">
              <Canvas />
            </div>
            <MobileFloat />
          </div>
        </Drawer.Indent>
      </div>
    </Drawer.Provider>
  );
}
