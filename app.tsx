import {
  ColorFilter,
  Component,
  ControlSlider,
  Download,
  IconoirProvider,
  Palette,
} from "iconoir-react";
import { NuqsAdapter } from "nuqs/adapters/react";
import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { Canvas } from "./components/canvas";
import { Drawer } from "./components/ui/drawer";
import { BottomBarItem, MobileBottomBar } from "./components/mobile-bottom/mobile-bottom-bar.tsx";
import { MobileControls } from "./components/mobile-controls.tsx";
import { SidebarLeft } from "./components/sidebar-left";
import { SidebarRight } from "./components/sidebar-right";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";
import { ToastProvider } from "./components/ui/toast/toast.tsx";
import { CanvasProvider } from "./context/canvas-context.tsx";
import { useCanvas } from "./context/use-canvas.ts";
import { ExportQueueProvider } from "./context/export-queue-context.tsx";
import { KeybindProvider } from "./context/keybind-provider.tsx";
import { LayoutProvider } from "./context/layout-context.tsx";
import { useLayout } from "./context/use-layout.ts";
import { VideoExportProvider } from "./context/video-export-context.tsx";
import { useIsMobile, useIsTouch } from "./hooks/use-is-mobile.ts";
import useMediaQuery from "./hooks/use-media-query";
import "./styles/app.css";
import { MediaControls } from "./components/infinite-canvas/media-controls.tsx";
import { useParamValue } from "./hooks/use-param-value.ts";

function DesktopLayout() {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "studio-panels",
    storage: localStorage,
  });

  const { isFullscreen, setFullscreen } = useLayout();
  const leftPanelRef = usePanelRef();
  const rightPanelRef = usePanelRef();
  const leftCollapsedRef = useRef(false);
  const rightCollapsedRef = useRef(false);

  // Sync fullscreen state when panels are restored from localStorage on mount
  const hasInitRef = useRef(false);
  useEffect(() => {
    if (hasInitRef.current) return;
    hasInitRef.current = true;
    const bothCollapsed =
      leftPanelRef.current?.isCollapsed() && rightPanelRef.current?.isCollapsed();
    if (bothCollapsed) {
      setFullscreen(true);
    }
  }, [leftPanelRef, rightPanelRef, setFullscreen]);

  // Collapse/expand panels when fullscreen state changes
  useEffect(() => {
    if (isFullscreen) {
      leftPanelRef.current?.collapse();
      rightPanelRef.current?.collapse();
    } else {
      leftPanelRef.current?.expand();
      rightPanelRef.current?.expand();
    }
  }, [isFullscreen, leftPanelRef, rightPanelRef]);

  // Track panel collapse state via onResize — exit fullscreen if user manually expands a panel
  const handleLeftResize = (size: { inPixels: number }) => {
    const wasCollapsed = leftCollapsedRef.current;
    const isCollapsed = size.inPixels <= 8;
    leftCollapsedRef.current = isCollapsed;

    if (wasCollapsed && !isCollapsed && isFullscreen) {
      setFullscreen(false);
    }
  };

  const handleRightResize = (size: { inPixels: number }) => {
    const wasCollapsed = rightCollapsedRef.current;
    const isCollapsed = size.inPixels === 0;
    rightCollapsedRef.current = isCollapsed;

    if (wasCollapsed && !isCollapsed && isFullscreen) {
      setFullscreen(false);
    }
  };

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        panelRef={leftPanelRef}
        collapsible
        collapsedSize={8}
        minSize={200}
        maxSize={300}
        onResize={handleLeftResize}
      >
        <SidebarLeft />
      </ResizablePanel>
      <ResizableHandle className="handle resize-handle--left" />

      <ResizablePanel>
        <div className="content">
          <Canvas />
          <MediaControls />
        </div>
      </ResizablePanel>
      <ResizableHandle className="handle resize-handle--right" />

      <ResizablePanel
        panelRef={rightPanelRef}
        collapsible
        collapsedSize={8}
        minSize={280}
        maxSize={320}
        defaultSize={320}
        onResize={handleRightResize}
      >
        <SidebarRight />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

const items = [
  "style",
  "colors",
  "parameters",
  "adjustments and post-processing",
  "export",
] as const;
export type BarItem = (typeof items)[number];

function MobileLayout() {
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

export default function App() {
  const isTouch = useIsTouch();
  const isMobile = useIsMobile();
  const isPrettyLargeScreen = useMediaQuery("(min-width: 830px)");
  const isSmallScreen = useMediaQuery("(max-width: 1100px)");

  const isMostProbablyTablet = isTouch && isPrettyLargeScreen;

  // small(ish) screen + not touch = desktop layout
  // probably tablet or mobile = mobile layout
  const showMobileLayout = (isSmallScreen && !isTouch) || isMostProbablyTablet || isMobile;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = () => setIsFullscreen((prev) => !prev);
  const setFullscreen = (value: boolean) => setIsFullscreen(value);

  return (
    <IconoirProvider
      iconProps={{ color: "currentColor", strokeWidth: 1.5, width: "1em", height: "1em" }}
    >
      <ToastProvider>
        <CanvasProvider>
          <VideoExportProvider>
            <ExportQueueProvider>
              <LayoutProvider value={{ isFullscreen, toggleFullscreen, setFullscreen }}>
                {showMobileLayout ? <MobileLayout /> : <DesktopLayout />}
              </LayoutProvider>
            </ExportQueueProvider>
          </VideoExportProvider>
        </CanvasProvider>
      </ToastProvider>
    </IconoirProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <NuqsAdapter>
      <KeybindProvider>
        <App />
      </KeybindProvider>
    </NuqsAdapter>
  </React.StrictMode>,
);
