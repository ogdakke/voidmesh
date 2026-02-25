import { useEffect, useRef } from "react";
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
