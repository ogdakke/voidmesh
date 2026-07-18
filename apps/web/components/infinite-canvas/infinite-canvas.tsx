import { useKeybinds } from "#context/keybind-context.ts";
import { useCanvasAccess, useCanvasPreferences } from "#context/use-canvas.ts";
import { useHostedWorkspaceRuntime } from "#context/use-hosted-workspace-runtime.ts";
import { useLayout } from "#context/use-layout.ts";
import { useCanvasContainerResize } from "#hooks/use-canvas-container-resize.ts";
import { useCanvasRendererRuntime } from "#hooks/use-canvas-renderer-runtime.ts";
import { useCanvasSurfaceEvents } from "#hooks/use-canvas-surface-events.ts";
import { useImageInput } from "#hooks/use-image-input.ts";
import { useInfiniteCanvasKeybinds } from "#hooks/use-infinite-canvas-keybinds.ts";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import useMediaQuery from "#hooks/use-media-query.ts";
import { useOnboarding } from "#hooks/use-onboarding.ts";
import { lazy, Suspense, useRef, type PropsWithChildren } from "react";
import { DropZone } from "../ui/dropzone/index.tsx";
import { CanvasOverlay } from "./canvas-overlay.tsx";
import "./infinite-canvas.css";

const CanvasContextMenu = lazy(() => import("./canvas-context-menu.tsx"));

export function InfiniteCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const perfRef = useRef<HTMLDivElement>(null);
  const { canvasLensing } = useCanvasPreferences();
  const access = useCanvasAccess();
  const keybindStore = useKeybinds();
  const isMobile = useIsMobile();
  const darkTheme = useMediaQuery("(prefers-color-scheme: dark)");
  const { isFullscreen } = useLayout();
  const hostedWorkspace = useHostedWorkspaceRuntime();

  const { isReady, isSupported, error } = useCanvasRendererRuntime({
    canvasRef,
    containerRef,
    perfRef,
    darkTheme,
    canvasLensing,
    isMobile,
    isFullscreen,
  });
  const keybinds = useInfiniteCanvasKeybinds(containerRef);
  const surface = useCanvasSurfaceEvents({
    canvasRef,
    containerRef,
    isMobile,
    isReady,
    onCursor: hostedWorkspace?.publishCursor,
    onSpaceTap: access.canEdit ? keybinds.playPause : () => undefined,
  });
  const { handleDrop } = useImageInput({ containerRef, multipleFiles: true });
  const onboarding = useOnboarding({ containerRef, ready: isReady });
  useCanvasContainerResize(containerRef);

  return (
    <DropZone onDrop={access.canEdit ? handleDrop : undefined} className="infinite-canvas-dropzone">
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={containerRef}
        className={`infinite-canvas${surface.isSpaceHeld ? " infinite-canvas--space" : ""}`}
        role="application"
        data-ready={isReady || undefined}
        tabIndex={0}
        onFocus={() => keybindStore.setActiveContext("canvas")}
        onBlur={() => keybindStore.setActiveContext("global")}
      >
        {isSupported ? (
          <CanvasWrapper
            onOpenChange={surface.handleContextMenuOpenChange}
            containerRef={containerRef}
          >
            <canvas
              ref={canvasRef}
              onPointerDown={surface.handlePointerDown}
              onPointerMove={surface.handlePointerMove}
              onPointerLeave={surface.handlePointerLeave}
              onPointerUp={surface.handlePointerUp}
              onPointerCancel={surface.handlePointerUp}
              onTouchStart={surface.handleTouchStart}
              onTouchMove={surface.handleTouchMove}
              onTouchEnd={surface.handleTouchEnd}
              onTouchCancel={surface.handleTouchCancel}
              onContextMenu={
                access.canEdit ? surface.handleContextMenu : (event) => event.preventDefault()
              }
              className="infinite-canvas__canvas"
            />
          </CanvasWrapper>
        ) : (
          <div className="infinite-canvas-error">
            <p>WebGPU is not supported in your browser.</p>
            {error && <p className="error-message">{error.message}</p>}
          </div>
        )}
        <CanvasOverlay
          perfRef={perfRef}
          onboarding={onboarding}
          centerSelection={keybinds.centerSelection}
          resetZoom={keybinds.resetZoom}
        />
      </div>
    </DropZone>
  );
}

function CanvasWrapper({
  children,
  containerRef,
  onOpenChange,
}: PropsWithChildren<{
  containerRef: React.RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
}>) {
  const isMobile = useIsMobile();
  return isMobile ? (
    children
  ) : (
    <Suspense>
      <CanvasContextMenu onOpenChange={onOpenChange} containerRef={containerRef}>
        {children}
      </CanvasContextMenu>
    </Suspense>
  );
}
