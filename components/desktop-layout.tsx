import { useEffect, useState } from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { Canvas } from "./canvas";
import { MediaControls } from "./infinite-canvas/media-controls.tsx";
import { SidebarLeft } from "./sidebar-left";
import { SidebarRight } from "./sidebar-right";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "#ui/resizable/resizable.tsx";
import { useLayout } from "#context/use-layout.ts";

export default function DesktopLayout() {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "studio-panels",
    storage: localStorage,
  });

  const { setFullscreen, registerPanelToggle } = useLayout();
  const leftPanelRef = usePanelRef();
  const rightPanelRef = usePanelRef();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // Register direct panel toggle — syncing with external imperative API
  useEffect(() => {
    registerPanelToggle(() => {
      const shouldCollapse =
        !leftPanelRef.current?.isCollapsed() || !rightPanelRef.current?.isCollapsed();
      if (shouldCollapse) {
        leftPanelRef.current?.collapse();
        rightPanelRef.current?.collapse();
      } else {
        leftPanelRef.current?.expand();
        rightPanelRef.current?.expand();
      }
    });
    return () => registerPanelToggle(null);
  }, [registerPanelToggle, leftPanelRef, rightPanelRef]);

  // Unidirectional: panel resize → fullscreen state (fires on mount too)
  const handleLeftResize = (size: { inPixels: number }) => {
    setLeftCollapsed(size.inPixels <= 8);
    setFullscreen(leftCollapsed && rightCollapsed);
  };

  const handleRightResize = (size: { inPixels: number }) => {
    setRightCollapsed(size.inPixels <= 8);
    setFullscreen(leftCollapsed && rightCollapsed);
  };

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        id="left"
        panelRef={leftPanelRef}
        collapsible
        collapsedSize={8}
        minSize={200}
        maxSize={300}
        onResize={handleLeftResize}
        data-collapsed={leftCollapsed || undefined}
      >
        <SidebarLeft />
      </ResizablePanel>
      <ResizableHandle className="handle resize-handle--left" />

      <ResizablePanel id="center">
        <div className="content">
          <Canvas />
          <MediaControls />
        </div>
      </ResizablePanel>
      <ResizableHandle className="handle resize-handle--right" />

      <ResizablePanel
        id="right"
        panelRef={rightPanelRef}
        collapsible
        collapsedSize={8}
        minSize={280}
        maxSize={320}
        defaultSize={320}
        onResize={handleRightResize}
        data-collapsed={rightCollapsed || undefined}
      >
        <SidebarRight />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
