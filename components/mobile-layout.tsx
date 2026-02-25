import { useState } from "react";
import { ColorFilter, Component, ControlSlider, Download, Palette } from "iconoir-react";
import { Canvas } from "./canvas";
import { MediaControls } from "./infinite-canvas/media-controls.tsx";
import { MobileControls } from "./mobile-controls.tsx";
import { BottomBarItem, MobileBottomBar } from "./mobile-bottom/mobile-bottom-bar.tsx";
import { items, type BarItem } from "./mobile-bottom/bar-items.ts";
import { Drawer } from "#ui/drawer/index.tsx";
import { useCanvas } from "#context/use-canvas.ts";
import { useLayout } from "#context/use-layout.ts";
import { useParamValue } from "#hooks/use-param-value.ts";

function MobileFloat() {
  const [activeItem, setActiveItem] = useState<BarItem | null>(items.at(0)!);
  const { multiSelectMode, selectedEntityIds } = useCanvas();
  const { isFullscreen } = useLayout();
  const palette = useParamValue("palette", null);
  const bottomBarDisabled = multiSelectMode || selectedEntityIds.size === 0;

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
      {!isFullscreen && !multiSelectMode && <MediaControls />}
      {!isFullscreen && (
        <div className="mobile-controls-container">
          <MobileControls activeItem={activeItem} />
        </div>
      )}

      <MobileBottomBar
        items={items}
        onChange={setActiveItem}
        value={activeItem}
        hideItems={isFullscreen}
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
