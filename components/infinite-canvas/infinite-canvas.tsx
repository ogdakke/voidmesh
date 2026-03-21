import { appLoader } from "#lib/app-loader.ts";
import { config } from "#config";
import { useKeybinds, useRegisterKeybinds } from "#context/keybind-context.ts";
import { DebugType, useCanvas, useViewport } from "#context/use-canvas.ts";
import { useLayout } from "#context/use-layout.ts";
import { canvasStore, gameLoop, SpacePanMode, viewportAnimation } from "#engine";
import { useCanvasActions } from "#hooks/use-canvas-actions.ts";
import { useCanvasContainerResize } from "#hooks/use-canvas-container-resize.ts";
import { useCanvasRenderer } from "#hooks/use-canvas-renderer.ts";
import { useEntityCycling } from "#hooks/use-entity-cycling.ts";
import { useImageInput } from "#hooks/use-image-input.ts";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { useMediaControlsActions } from "#hooks/use-media-controls.ts";
import useMediaQuery from "#hooks/use-media-query.ts";
import { useStudioFile } from "#hooks/use-studio-file.ts";
import {
  calculateCenteredOffset,
  calculateFitToView,
  easings,
  zoomToPoint,
} from "#lib/canvas-math.ts";
import { undo } from "#lib/undo.ts";
import { Check, Enlarge, Reduce, Square3dFromCenter } from "iconoir-react";
import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { Button } from "../ui/button/index.tsx";
import { DropZone } from "../ui/dropzone/index.tsx";
import { UndoRedoButtons } from "./undo-redo.tsx";
import "./infinite-canvas.css";

import DesktopSettings from "#components/settings/settings.desktop.tsx";
import SettingsDrawer from "../settings/settings.mobile.tsx";
import About from "../about/index.tsx";

const CanvasContextMenu = lazy(() => import("./canvas-context-menu.tsx"));

function CenterCanvasControl({
  onCenterCanvas,
  hasSelection,
  isMobile,
}: {
  onCenterCanvas: () => void;
  hasSelection: boolean;
  isMobile: boolean;
}) {
  return (
    <Button
      className="infinite-canvas__center"
      onClick={onCenterCanvas}
      type="button"
      aria-label={hasSelection ? "Center selection in view" : "Center canvas"}
      variant="secondary"
      size={isMobile ? "md" : "sm"}
      disabled={!hasSelection}
    >
      <Square3dFromCenter />
    </Button>
  );
}

function ViewportZoom({ onZoomReset }: { onZoomReset: () => void }) {
  const viewport = useViewport();

  return (
    <Button
      className="infinite-canvas__zoom-indicator"
      onClick={onZoomReset}
      type="button"
      aria-label="Reset zoom to 100%"
      size={"sm"}
      variant="secondary"
    >
      {Math.round(viewport.zoom * 100)}%
    </Button>
  );
}

export function InfiniteCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const perfRef = useRef<HTMLDivElement>(null);

  const { registerRenderer, selectedEntityIds, multiSelectMode, setViewport, setDebugType } =
    useCanvas();
  const {
    deleteEntity,
    toggleShowOriginal,
    togglePreserveColors,
    toggleReversePalette,
    handleBringToFront,
    handleSendToBack,
    duplicateEntities,
    copyEntity,
    copyEntityParams,
    selectedEntity,
    resetEntityToDefaults,
    snapToGrid,
    handleSnapToGridChange,
  } = useCanvasActions();
  const mediaActions = useMediaControlsActions(selectedEntity);
  const keybindStore = useKeybinds();

  // Entity cycling (ArrowUp/Down navigation)
  const { handleCycleNext, handleCyclePrevious } = useEntityCycling(containerRef);

  // Initialize WebGPU renderer
  const { renderer, isReady, isSupported, error } = useCanvasRenderer(canvasRef);

  const [isSpaceHeld, setIsSpaceHeld] = useState(false);

  const isMobile = useIsMobile();
  const bottomInset = isMobile ? config.canvas.mobile.bottomInset : 0;
  const darkTheme = useMediaQuery("(prefers-color-scheme: dark)");
  const { isFullscreen, toggleFullscreen } = useLayout();

  // Update app loader text while canvas initializes
  useEffect(() => {
    appLoader.setText("Initializing canvas...");
  }, []);

  // Dismiss the app loader once the canvas is ready (or unsupported)
  useEffect(() => {
    if (isReady || !isSupported) {
      appLoader.dismiss();
      console.info(`canvas ready`, {
        durationMs: new Date().getTime() - appLoader.startTime,
        p3: renderer?.colorConfig.supportsP3,
      });
    }
  }, [isReady, isSupported, renderer?.colorConfig.supportsP3]);

  // Initialize game loop
  useEffect(() => {
    if (!containerRef.current || !perfRef.current) return;
    gameLoop.setContainer(containerRef.current);
    gameLoop.setPerfElement(perfRef.current);
  }, []);

  useEffect(() => {
    if (renderer && isReady) {
      if (darkTheme) {
        renderer?.setGridConfig(config.rendering.grid.dark);
      } else {
        renderer?.setGridConfig(config.rendering.grid.default);
      }
      renderer.setActionLayerTint(
        darkTheme ? config.actionLayer.dimColor.dark : config.actionLayer.dimColor.light,
      );
      renderer.setSelectionRectConfig(
        darkTheme ? config.selectionRectangle.dark : config.selectionRectangle.light,
        darkTheme ? config.multiSelectBoundingBox.dark : config.multiSelectBoundingBox.light,
      );
      registerRenderer(renderer);
      gameLoop.start();
    }
    return () => gameLoop.stop();
  }, [renderer, isReady, registerRenderer, darkTheme]);

  // Image input handlers (paste, drop, file upload)
  const { handleDrop } = useImageInput({ containerRef, multipleFiles: true });

  // Studio file save/load
  const { exportStudioFile, saveAsStudioFile, importStudioFile } = useStudioFile();

  // Observe container size changes and trigger re-render
  useCanvasContainerResize(containerRef);

  // doesn't capture pointer to keep base-ui native context menu behavior on macos (two-finger tap, hold and drag over menu item)
  const handlePointerDown = (e: React.PointerEvent) => {
    // Skip pointer events for touch - we handle touch separately
    if (e.pointerType === "touch") return;

    containerRef.current?.focus();
    gameLoop.handlePointerDown({ x: e.clientX, y: e.clientY }, e.shiftKey);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    // Skip pointer events for touch
    if (e.pointerType === "touch") return;

    gameLoop.handlePointerMove({ x: e.clientX, y: e.clientY });
  };

  // doesn't release pointer capture to keep base-ui native context menu behavior on macos (two-finger tap, hold and drag over menu item)
  const handlePointerUp = (e: React.PointerEvent) => {
    // Skip pointer events for touch
    if (e.pointerType === "touch") return;

    gameLoop.handlePointerUp({ x: e.clientX, y: e.clientY });
  };

  // Touch event handlers for mobile
  const handleTouchStart = (e: React.TouchEvent) => {
    containerRef.current?.focus();
    const touches = Array.from(e.touches).map((t) => ({ x: t.clientX, y: t.clientY }));
    gameLoop.handleTouchStart(touches);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const touches = Array.from(e.touches).map((t) => ({ x: t.clientX, y: t.clientY }));
    gameLoop.handleTouchMove(touches);
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const remainingTouches = Array.from(e.touches).map((t) => ({ x: t.clientX, y: t.clientY }));
    gameLoop.handleTouchEnd(remainingTouches);
  };

  const handleTouchCancel = (e: React.TouchEvent) => {
    const remainingTouches = Array.from(e.touches).map((t) => ({ x: t.clientX, y: t.clientY }));
    gameLoop.handleTouchEnd(remainingTouches, true);
  };

  // handle context menu
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (isMobile) {
      // don't do anything on mobile
      return;
    }
    gameLoop.handleContextMenu({ x: e.clientX, y: e.clientY });
  };

  // Attach wheel event with passive: false for preventDefault
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const isZoomModifier = e.ctrlKey || e.metaKey;
      gameLoop.handleWheel(e.deltaX, e.deltaY, { x: e.clientX, y: e.clientY }, isZoomModifier);
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      canvas.removeEventListener("wheel", handleWheel);
    };
    // Re-run when canvas mounts (delayed by Suspense around CanvasContextMenu on desktop)
  }, [isReady]);

  // Reset zoom to 100% while keeping the viewport center fixed
  const handleZoomReset = () => {
    const container = containerRef.current;
    if (!container) return;

    const currentViewport = canvasStore.getViewport();
    // Calculate the viewport center in container-relative device pixels
    const dpr = window.devicePixelRatio;
    const centerPoint = {
      x: (container.clientWidth * dpr) / 2,
      y: (container.clientHeight * dpr) / 2,
    };

    // Zoom to 100% keeping the center point fixed
    const targetViewport = zoomToPoint(currentViewport, centerPoint, 1);
    viewportAnimation.animateTo(targetViewport, {
      duration: config.canvas.animation.zoomResetDuration,
      easing: easings[config.canvas.animation.easing],
    });
  };

  // Center selection in view (fit to view when entities selected)
  const handleCenterCanvas = () => {
    const container = containerRef.current;
    const entities = canvasStore.getSelectedEntities();
    if (!container || entities.length === 0) return;
    gameLoop.stopMomentum();

    // Compute bounding box of all selected entities
    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const entity of entities) {
      minX = Math.min(minX, entity.position.x);
      minY = Math.min(minY, entity.position.y);
      maxX = Math.max(maxX, entity.position.x + entity.size.width);
      maxY = Math.max(maxY, entity.position.y + entity.size.height);
    }

    const boundsPosition = { x: minX, y: minY };
    const boundsSize = { width: maxX - minX, height: maxY - minY };

    const targetViewport = calculateFitToView({
      entityPosition: boundsPosition,
      entitySize: boundsSize,
      containerWidth: container.clientWidth,
      containerHeight: container.clientHeight,
      dpr: window.devicePixelRatio,
      padding: 0.1,
      minZoom: undefined,
      maxZoom: undefined,
      bottomInset: isFullscreen ? 0 : bottomInset,
    });

    viewportAnimation.animateTo(targetViewport, {
      duration: config.canvas.animation.fitToViewDuration,
      easing: easings[config.canvas.animation.easing],
    });
  };

  // Center viewport on initial mount so world (0,0) is at screen center
  const hasInitializedRef = useRef(false);
  useEffect(() => {
    if (hasInitializedRef.current) return;
    const container = containerRef.current;
    if (!container) return;

    hasInitializedRef.current = true;
    const initialOffset = calculateCenteredOffset(
      container.clientWidth,
      container.clientHeight,
      1, // Initial zoom is 1
      window.devicePixelRatio,
    );
    setViewport({ offset: initialOffset, zoom: 1 });
  }, [setViewport]);

  // Media scrub handlers - works for both video and GIF
  const scrubMediaBackwardShortcutHandler = (e: KeyboardEvent) => {
    if (mediaActions.isIdle()) return;
    e.preventDefault();
    const delta = e.shiftKey ? -1 : -0.1;
    mediaActions.seekRelative(delta);
  };

  const scrubMediaForwardShortcutHandler = (e: KeyboardEvent) => {
    if (mediaActions.isIdle()) return;
    e.preventDefault();
    const delta = e.shiftKey ? 1 : 0.1;
    mediaActions.seekRelative(delta);
  };

  // Play/pause media - works for both video and GIF
  const playPauseShortcutHandler = async (_e: KeyboardEvent) => {
    if (mediaActions.isIdle()) return;
    // Blur DropZone button to prevent it capturing spacebar, but not the canvas container
    if (
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== containerRef.current
    ) {
      document.activeElement.blur();
    }
    await mediaActions.togglePlayback();
  };
  const playPauseRef = useRef(playPauseShortcutHandler);
  useLayoutEffect(() => {
    playPauseRef.current = playPauseShortcutHandler;
  });

  // Space+drag canvas panning: intercept space before the keybind system (capture phase,
  // registered first due to React's child-before-parent effect ordering).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== " " || e.repeat) return;
      gameLoop.setSpaceHeld(true);
      setIsSpaceHeld(true);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      const wasReady = gameLoop.spacePanMode === SpacePanMode.ready;
      gameLoop.setSpaceHeld(false);
      setIsSpaceHeld(false);
      if (wasReady) {
        void playPauseRef.current(e);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const zoomTo100PercentShortcutHandler = (e: KeyboardEvent) => {
    e.preventDefault();
    handleZoomReset();
  };

  const copyEntityShortcutHandler = (e: KeyboardEvent) => {
    e.preventDefault();
    copyEntity(e);
  };

  const toggleDebugModeShortcutHandler = async function toggleDebugModeShortcutHandler() {
    await setDebugType((prev) => (!prev ? DebugType.default : null));
  };

  const toggleSnapToGridHandler = function toggleSnapToGridHandler() {
    handleSnapToGridChange(!snapToGrid);
  };

  const centerCanvasShortcutHandler = (e: KeyboardEvent) => {
    e.preventDefault();
    handleCenterCanvas();
  };

  // Fit selected entities to view with padding - supports single and multi-selection
  const handleFitToView = () => {
    const container = containerRef.current;
    const entities = canvasStore.getSelectedEntities();
    if (!container || entities.length === 0) return;
    gameLoop.stopMomentum();

    // Compute bounding box of all selected entities
    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const entity of entities) {
      minX = Math.min(minX, entity.position.x);
      minY = Math.min(minY, entity.position.y);
      maxX = Math.max(maxX, entity.position.x + entity.size.width);
      maxY = Math.max(maxY, entity.position.y + entity.size.height);
    }

    const boundsPosition = { x: minX, y: minY };
    const boundsSize = { width: maxX - minX, height: maxY - minY };

    const targetViewport = calculateFitToView({
      entityPosition: boundsPosition,
      entitySize: boundsSize,
      containerWidth: container.clientWidth,
      containerHeight: container.clientHeight,
      dpr: window.devicePixelRatio,
      padding: config.canvas.fitToViewPadding,
      minZoom: undefined,
      maxZoom: undefined,
      bottomInset,
    });

    viewportAnimation.animateTo(targetViewport, {
      duration: config.canvas.animation.fitToViewDuration,
      easing: easings[config.canvas.animation.easing],
    });
  };

  const fitToViewShortcutHandler = (e: KeyboardEvent) => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return; // Only trigger when something is selected

    e.preventDefault();
    handleFitToView();
  };

  const handleContextMenuOpenChange = (open: boolean) => {
    if (!open) {
      canvasStore.setContextMenuClosed();
      gameLoop.handleContextMenuClose();
    }
  };

  const undoShortcutHandler = (_e: KeyboardEvent) => {
    undo.undo();
  };

  const redoShortcutHandler = (_e: KeyboardEvent) => {
    undo.redo();
  };

  const bringToFrontShortcutHandler = (_e: KeyboardEvent) => {
    handleBringToFront();
  };

  const sendToBackShortcutHandler = (_e: KeyboardEvent) => {
    handleSendToBack();
  };

  const duplicateShortcutHandler = (e: KeyboardEvent) => {
    e.preventDefault();
    duplicateEntities();
  };

  // Select all entities
  const selectAllShortcutHandler = (e: KeyboardEvent) => {
    e.preventDefault();
    const allIds = [...canvasStore.getState().entities.keys()];
    if (allIds.length > 0) {
      canvasStore.replaceSelection(allIds);
    }
  };

  // Clear selection
  const clearSelectionShortcutHandler = () => {
    canvasStore.clearSelection();
  };

  const toggleFullscreenShortcutHandler = (e: KeyboardEvent) => {
    e.preventDefault();
    toggleFullscreen();
  };

  const handleExportStudio = (e: KeyboardEvent) => {
    e.preventDefault();
    exportStudioFile();
  };

  const handleSaveAsStudio = (e: KeyboardEvent) => {
    e.preventDefault();
    saveAsStudioFile();
  };

  const handleImportStudio = (e: KeyboardEvent) => {
    e.preventDefault();
    importStudioFile();
  };

  // Set active keybind context based on selection state
  useEffect(() => {
    if (selectedEntityIds.size > 0) {
      keybindStore.setActiveContext("selection");
    } else if (document.activeElement === containerRef.current) {
      keybindStore.setActiveContext("canvas");
    }
  }, [selectedEntityIds, keybindStore]);

  useRegisterKeybinds("global", [
    {
      id: "save_studio",
      bind: (bb) => bb.withMeta().and.key("s"),
      platform: "macos",
      group: "global",
      label: "Save workspace",
      action: handleExportStudio,
    },
    {
      id: "save_studio",
      bind: (bb) => bb.withCtrl().and.key("s"),
      platform: "other",
      group: "global",
      label: "Save workspace",
      action: handleExportStudio,
    },
    {
      id: "save_as_studio",
      bind: (bb) => bb.withShift().and.withMeta().and.key("s"),
      platform: "macos",
      group: "global",
      label: "Save workspace as...",
      action: handleSaveAsStudio,
    },
    {
      id: "save_as_studio",
      bind: (bb) => bb.withShift().and.withCtrl().and.key("s"),
      platform: "other",
      group: "global",
      label: "Save workspace as...",
      action: handleSaveAsStudio,
    },
    {
      id: "open_studio",
      bind: (bb) => bb.withMeta().and.key("o"),
      platform: "macos",
      group: "global",
      label: "Open workspace",
      action: handleImportStudio,
    },
    {
      id: "open_studio",
      bind: (bb) => bb.withCtrl().and.key("o"),
      platform: "other",
      group: "global",
      label: "Open workspace",
      action: handleImportStudio,
    },
    {
      id: "toggle_fullscreen",
      bind: "\\",
      group: "global",
      label: "Toggle fullscreen",
      action: toggleFullscreenShortcutHandler,
    },
    {
      bind: (bb) => bb.withMeta().key("z"),
      group: "global",
      platform: "macos",
      label: "Undo",
      action: undoShortcutHandler,
    },
    {
      bind: (bb) => bb.withCtrl().key("z"),
      group: "global",
      platform: "other",
      label: "Undo",
      action: undoShortcutHandler,
    },
    {
      bind: (bb) => bb.withShift().and.withMeta().and.key("z"),
      group: "global",
      platform: "macos",
      label: "Redo",
      action: redoShortcutHandler,
    },
    {
      bind: (bb) => bb.withCtrl().key("y"),
      group: "global",
      platform: "other",
      label: "Redo",
      action: redoShortcutHandler,
    },
    {
      id: "toggle_fullscreen",
      bind: "\\",
      group: "global",
      label: "Toggle fullscreen",
      action: toggleFullscreenShortcutHandler,
    },
    {
      bind: (bb) => bb.withBind("d").withSensitive(false),
      group: "debug",
      label: "Toggle debug mode",
      action: toggleDebugModeShortcutHandler,
    },
  ]);

  // Canvas context keybinds (active when no entity is selected)
  useRegisterKeybinds("canvas", [
    {
      bind: " ",
      group: "canvas",
      label: "Hold and drag to pan canvas",
      action: () => {}, // Handled by space+drag keyup handler to distinguish tap vs hold
    },
    {
      bind: (bb) => bb.withBind("h").withSensitive(false),
      group: "canvas",
      label: "Center canvas to origin",
      action: centerCanvasShortcutHandler,
    },
    {
      id: "toggle_snap_to_grid",
      bind: (bb) => bb.withBind("g").withSensitive(false),
      group: "canvas",
      label: "Toggle snap to grid",
      action: toggleSnapToGridHandler,
    },
    {
      bind: (bb) => bb.withMeta().and.key("0"),
      platform: "macos",
      group: "canvas",
      label: "Zoom to 100%",
      action: zoomTo100PercentShortcutHandler,
    },
    {
      bind: (bb) => bb.withCtrl().and.key("0"),
      platform: "other",
      group: "canvas",
      label: "Zoom to 100%",
      action: zoomTo100PercentShortcutHandler,
    },
    {
      id: "paste_canvas",
      bind: (bb) => bb.withMeta().and.key("v"),
      platform: "macos",
      group: "canvas",
      label: "Paste image or video, or a link to an image",
      action: () => {},
    },
    {
      id: "paste_canvas",
      bind: (bb) => bb.withCtrl().and.key("v"),
      platform: "other",
      group: "canvas",
      label: "Paste image or video, or a link to an image",
      action: () => {},
    },
    {
      id: "select_all",
      bind: (bb) => bb.withMeta().and.key("a"),
      platform: "macos",
      group: "canvas",
      label: "Select all",
      action: selectAllShortcutHandler,
    },
    {
      id: "select_all",
      bind: (bb) => bb.withCtrl().and.key("a"),
      platform: "other",
      group: "canvas",
      label: "Select all",
      action: selectAllShortcutHandler,
    },
    {
      id: "cycle_next_entity",
      bind: (bb) => bb.key("ArrowUp"),
      group: "canvas",
      label: "Select next",
      action: handleCycleNext,
    },
    {
      id: "cycle_previous_entity",
      bind: (bb) => bb.key("ArrowDown"),
      group: "canvas",
      label: "Select previous",
      action: handleCyclePrevious,
    },
  ]);

  // Selection context keybinds (active when an entity is selected)
  useRegisterKeybinds("selection", [
    {
      id: "toggle_show_original",
      bind: "o",
      group: "selection",
      action: toggleShowOriginal,
      label: "Toggle showing original image",
    },
    {
      id: "toggle_preserve_colors",
      bind: "p",
      group: "selection",
      action: togglePreserveColors,
      label: "Toggle preserve colors",
    },
    {
      id: "toggle_reverse_palette",
      bind: "r",
      group: "selection",
      action: toggleReversePalette,
      label: "Toggle reverse palette",
    },
    {
      bind: (bb) => bb.withBind("f").withSensitive(false),
      group: "selection",
      label: "Fit selected to view",
      action: fitToViewShortcutHandler,
    },
    {
      bind: (bb) => bb.key("ArrowLeft"),
      group: "video",
      label: "Scrub media backwards",
      action: scrubMediaBackwardShortcutHandler,
    },
    {
      bind: (bb) => bb.key("ArrowRight"),
      group: "video",
      label: "Scrub media forwards",
      action: scrubMediaForwardShortcutHandler,
    },
    {
      id: "delete_entity",
      bind: (bb) => bb.key("Delete"),
      platform: "other",
      group: "selection",
      label: "Delete selected",
      action: deleteEntity,
    },
    {
      id: "delete_entity",
      bind: (bb) => bb.key("Backspace"),
      platform: "macos",
      group: "selection",
      label: "Delete selected",
      action: deleteEntity,
    },
    {
      bind: " ",
      group: "video",
      label: "Play/Pause media",
      action: () => {}, // Handled by space+drag keyup handler to distinguish tap vs hold
    },
    {
      id: "copy_selection",
      bind: (bb) => bb.withMeta().and.key("c"),
      platform: "macos",
      group: "selection",
      label: "Copy selected",
      action: copyEntityShortcutHandler,
    },
    {
      id: "copy_selection",
      bind: (bb) => bb.withCtrl().and.key("c"),
      platform: "other",
      group: "selection",
      label: "Copy selected",
      action: copyEntityShortcutHandler,
    },

    {
      id: "paste_selection",
      bind: (bb) => bb.withMeta().and.key("v"),
      platform: "macos",
      group: "selection",
      label: "Paste a shared link to copy parameters from another image",
      action: () => {},
    },
    {
      id: "paste_selection",
      bind: (bb) => bb.withCtrl().and.key("v"),
      platform: "other",
      group: "selection",
      label: "Paste a shared link to copy parameters from another image",
      action: () => {},
    },
    {
      id: "copy_effects",
      bind: (bb) => bb.withMeta().and.withCtrl().and.key("c"),
      platform: "macos",
      group: "selection",
      label: "Copy effects",
      action: (e: KeyboardEvent) => {
        e.preventDefault();
        copyEntityParams();
      },
    },
    {
      id: "copy_effects",
      bind: (bb) => bb.withCtrl().and.withAlt().and.key("c"),
      platform: "other",
      group: "selection",
      label: "Copy effects",
      action: (e: KeyboardEvent) => {
        e.preventDefault();
        copyEntityParams();
      },
    },
    {
      id: "bring_to_front",
      bind: "]",
      group: "selection",
      label: "Bring to front",
      action: bringToFrontShortcutHandler,
    },
    {
      id: "send_to_back",
      bind: "[",
      group: "selection",
      label: "Send to back",
      action: sendToBackShortcutHandler,
    },
    {
      id: "duplicate_entity",
      bind: (bb) => bb.withMeta().and.key("d"),
      platform: "macos",
      group: "selection",
      label: "Duplicate selected",
      action: duplicateShortcutHandler,
    },
    {
      id: "duplicate_entity",
      bind: (bb) => bb.withCtrl().and.key("d"),
      platform: "other",
      group: "selection",
      label: "Duplicate selected",
      action: duplicateShortcutHandler,
    },
    {
      id: "select_all",
      bind: (bb) => bb.withMeta().and.key("a"),
      platform: "macos",
      group: "selection",
      label: "Select all",
      action: selectAllShortcutHandler,
    },
    {
      id: "select_all",
      bind: (bb) => bb.withCtrl().and.key("a"),
      platform: "other",
      group: "selection",
      label: "Select all",
      action: selectAllShortcutHandler,
    },
    {
      id: "clear_selection",
      bind: "Escape",
      group: "selection",
      label: "Clear selection",
      action: clearSelectionShortcutHandler,
    },
    {
      id: "clear_selection",
      bind: "Escape",
      group: "canvas",
      label: "Clear selection",
      action: clearSelectionShortcutHandler,
    },
  ]);

  const handleEnterMultiSelect = () => {
    canvasStore.setMultiSelectMode(true);
  };

  const handleExitMultiSelect = () => {
    canvasStore.setMultiSelectMode(false);
  };

  const handleContainerFocus = () => {
    keybindStore.setActiveContext("canvas");
  };

  const handleContainerBlur = () => {
    keybindStore.setActiveContext("global");
  };

  return (
    <DropZone onDrop={handleDrop} className="infinite-canvas-dropzone">
      <div
        ref={containerRef}
        className={`infinite-canvas${isSpaceHeld ? " infinite-canvas--space" : ""}`}
        data-ready={isReady || undefined}
        tabIndex={0}
        onFocus={handleContainerFocus}
        onBlur={handleContainerBlur}
      >
        {isSupported ? (
          <CanvasWrapper onOpenChange={handleContextMenuOpenChange} containerRef={containerRef}>
            <canvas
              ref={canvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchCancel}
              onContextMenu={handleContextMenu}
              className="infinite-canvas__canvas"
            />
          </CanvasWrapper>
        ) : (
          <div className="infinite-canvas-error">
            <p>WebGPU is not supported in your browser.</p>
            {error && <p className="error-message">{error.message}</p>}
          </div>
        )}
        <div className="infinite-canvas__overlay">
          <div
            ref={perfRef}
            className="infinite-canvas__perf-overlay"
            style={{ display: "none" }}
          />

          {!isMobile && (
            <>
              <div className="infinite-canvas__top-left">
                <DesktopSettings />
              </div>
              <div className="infinite-canvas__top-right">
                <Button
                  onClick={toggleFullscreen}
                  type="button"
                  aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                  title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                  variant="secondary"
                  size="sm"
                >
                  {isFullscreen ? <Reduce /> : <Enlarge />}
                </Button>
              </div>
            </>
          )}
          {!(isMobile && isFullscreen) && (
            <InfiniteCanvasToolRow>
              <div className="left-controls">
                <About className="infinite-canvas__keyboard-shortcuts" />
                <UndoRedoButtons />
              </div>
              <div className="infinite-canvas__controls">
                {isMobile ? (
                  multiSelectMode ? (
                    <Button
                      className="infinite-canvas__confirm"
                      onClick={handleExitMultiSelect}
                      type="button"
                      aria-label="Confirm selection"
                      variant="primary"
                      size="sm"
                    >
                      <Check />
                    </Button>
                  ) : selectedEntityIds.size > 0 ? (
                    <Button
                      className="infinite-canvas__reset"
                      onClick={resetEntityToDefaults}
                      type="button"
                      aria-label="Reset to defaults"
                      variant="secondary"
                      size="sm"
                    >
                      Reset
                    </Button>
                  ) : (
                    <Button
                      className="infinite-canvas__select"
                      onClick={handleEnterMultiSelect}
                      type="button"
                      aria-label="Enter selection mode"
                      variant="secondary"
                      size="sm"
                    >
                      Select
                    </Button>
                  )
                ) : (
                  <CenterCanvasControl
                    onCenterCanvas={handleCenterCanvas}
                    hasSelection={selectedEntityIds.size > 0}
                    isMobile={false}
                  />
                )}
                {isMobile && <SettingsDrawer />}
                <ViewportZoom onZoomReset={handleZoomReset} />
              </div>
            </InfiniteCanvasToolRow>
          )}
        </div>
      </div>
    </DropZone>
  );
}

const CanvasWrapper = ({
  children,
  containerRef,
  onOpenChange,
}: PropsWithChildren<{
  containerRef: React.RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
}>) => {
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
};

const InfiniteCanvasToolRow = memo(function InfiniteCanvasToolRow({ children }: PropsWithChildren) {
  return <div className="infinite-canvas-toolrow">{children}</div>;
});
