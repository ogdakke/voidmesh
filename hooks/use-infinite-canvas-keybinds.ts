import { config } from "#config";
import { isUserTypingInInput, useKeybinds, useRegisterKeybinds } from "#context/keybind-context.ts";
import {
  DebugType,
  useCanvasCommands,
  useCanvasInteraction,
  useCanvasPreferences,
  useSelectedEntity,
  useSelectedEntityIds,
} from "#context/use-canvas.ts";
import { useLayout } from "#context/use-layout.ts";
import { undo } from "#lib/undo.ts";
import { useEffect, type RefObject } from "react";
import { useEntityCycling } from "./use-entity-cycling.ts";
import { useIsMobile } from "./use-is-mobile.ts";
import { useMediaControlsActions } from "./use-media-controls.ts";
import { useStudioFile } from "./use-studio-file.ts";

export function useInfiniteCanvasKeybinds(containerRef: RefObject<HTMLDivElement | null>) {
  const {
    setDebugType,
    deleteSelection,
    toggleShowOriginal,
    togglePreserveColors,
    toggleReversePalette,
    duplicateEntities,
    copySelectionImage,
    copySelectionEffects,
    setSnapToGrid,
  } = useCanvasCommands();
  const interaction = useCanvasInteraction();
  const { snapToGrid } = useCanvasPreferences();
  const selectedEntity = useSelectedEntity();
  const selectedEntityIds = useSelectedEntityIds();
  const mediaActions = useMediaControlsActions(selectedEntity);
  const keybindStore = useKeybinds();
  const { handleCycleNext, handleCyclePrevious } = useEntityCycling(containerRef);
  const { exportStudioFile, saveAsStudioFile, importStudioFile } = useStudioFile();
  const { isFullscreen, toggleFullscreen } = useLayout();
  const isMobile = useIsMobile();
  const bottomInset = isMobile ? config.canvas.mobile.bottomInset : 0;

  const getMetrics = () => {
    const container = containerRef.current;
    if (!container) return null;
    return {
      width: container.clientWidth,
      height: container.clientHeight,
      dpr: window.devicePixelRatio,
    };
  };

  const resetZoom = () => {
    const metrics = getMetrics();
    if (metrics) interaction.resetZoom(metrics);
  };

  const centerSelection = () => {
    const metrics = getMetrics();
    if (!metrics) return;
    interaction.fitSelection(metrics, {
      padding: 0.1,
      bottomInset: isFullscreen ? 0 : bottomInset,
    });
  };

  const fitSelection = () => {
    const metrics = getMetrics();
    if (!metrics) return false;
    return interaction.fitSelection(metrics, {
      padding: config.canvas.fitToViewPadding,
      bottomInset,
    });
  };

  const playPause = async (_event: KeyboardEvent) => {
    if (isUserTypingInInput() || mediaActions.isIdle()) return;
    if (
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== containerRef.current
    ) {
      document.activeElement.blur();
    }
    await mediaActions.togglePlayback();
  };

  useEffect(() => {
    if (selectedEntityIds.size > 0) {
      keybindStore.setActiveContext("selection");
    } else if (document.activeElement === containerRef.current) {
      keybindStore.setActiveContext("canvas");
    }
  }, [containerRef, keybindStore, selectedEntityIds]);

  useRegisterKeybinds("global", [
    {
      id: "save_studio",
      bind: (bind) => bind.withMod().and.key("s"),
      group: "global",
      label: "Save workspace",
      action: (event) => {
        event.preventDefault();
        exportStudioFile();
      },
    },
    {
      id: "save_as_studio",
      bind: (bind) => bind.withShift().and.withMod().and.key("s"),
      group: "global",
      label: "Save workspace as...",
      action: (event) => {
        event.preventDefault();
        saveAsStudioFile();
      },
    },
    {
      id: "open_studio",
      bind: (bind) => bind.withMod().and.key("o"),
      group: "global",
      label: "Open workspace",
      action: (event) => {
        event.preventDefault();
        importStudioFile();
      },
    },
    {
      id: "toggle_fullscreen",
      bind: "\\",
      group: "global",
      label: "Toggle fullscreen",
      action: (event) => {
        event.preventDefault();
        toggleFullscreen();
      },
    },
    {
      bind: (bind) => bind.withMod().key("z"),
      group: "global",
      label: "Undo",
      action: () => undo.undo(),
    },
    {
      bind: (bind) => bind.withShift().and.withMod().and.key("z"),
      group: "global",
      platform: "macos",
      label: "Redo",
      action: () => undo.redo(),
    },
    {
      bind: (bind) => bind.withCtrl().key("y"),
      group: "global",
      platform: "other",
      label: "Redo",
      action: () => undo.redo(),
    },
    {
      bind: (bind) => bind.withBind("d").withSensitive(false),
      group: "debug",
      label: "Toggle debug mode",
      action: async () => setDebugType((previous) => (!previous ? DebugType.default : null)),
    },
  ]);

  useRegisterKeybinds("canvas", [
    {
      bind: " ",
      group: "canvas",
      label: "Hold and drag to pan canvas",
      action: () => {},
    },
    {
      bind: (bind) => bind.withBind("h").withSensitive(false),
      group: "canvas",
      label: "Center canvas to origin",
      action: (event) => {
        event.preventDefault();
        centerSelection();
      },
    },
    {
      id: "toggle_snap_to_grid",
      bind: (bind) => bind.withBind("g").withSensitive(false),
      group: "canvas",
      label: "Toggle snap to grid",
      action: () => setSnapToGrid(!snapToGrid),
    },
    {
      bind: (bind) => bind.withMod().and.key("0"),
      group: "canvas",
      label: "Zoom to 100%",
      action: (event) => {
        event.preventDefault();
        resetZoom();
      },
    },
    {
      id: "paste_canvas",
      bind: (bind) => bind.withMod().and.key("v"),
      group: "canvas",
      label: "Paste image or video, or a link to an image",
      action: () => {},
    },
    {
      id: "select_all",
      bind: (bind) => bind.withMod().and.key("a"),
      group: "canvas",
      label: "Select all",
      action: (event) => {
        event.preventDefault();
        interaction.selectAll();
      },
    },
    {
      id: "cycle_next_entity",
      bind: (bind) => bind.key("ArrowUp"),
      group: "canvas",
      label: "Select next",
      action: handleCycleNext,
    },
    {
      id: "cycle_previous_entity",
      bind: (bind) => bind.key("ArrowDown"),
      group: "canvas",
      label: "Select previous",
      action: handleCyclePrevious,
    },
  ]);

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
      bind: (bind) => bind.withBind("f").withSensitive(false),
      group: "selection",
      label: "Fit selected to view",
      action: (event) => {
        if (!fitSelection()) return;
        event.preventDefault();
      },
    },
    {
      bind: (bind) => bind.key("ArrowLeft"),
      group: "video",
      label: "Scrub media backwards",
      action: (event) => {
        if (mediaActions.isIdle()) return;
        event.preventDefault();
        mediaActions.seekRelative(event.shiftKey ? -1 : -0.1);
      },
    },
    {
      bind: (bind) => bind.key("ArrowRight"),
      group: "video",
      label: "Scrub media forwards",
      action: (event) => {
        if (mediaActions.isIdle()) return;
        event.preventDefault();
        mediaActions.seekRelative(event.shiftKey ? 1 : 0.1);
      },
    },
    {
      id: "delete_entity",
      bind: (bind) => bind.key("Delete"),
      platform: "other",
      group: "selection",
      label: "Delete selected",
      action: deleteSelection,
    },
    {
      id: "delete_entity",
      bind: (bind) => bind.key("Backspace"),
      platform: "macos",
      group: "selection",
      label: "Delete selected",
      action: deleteSelection,
    },
    {
      bind: " ",
      group: "video",
      label: "Play/Pause media",
      action: () => {},
    },
    {
      id: "toggle_media_mute",
      bind: (bind) => bind.withBind("m").withSensitive(false),
      group: "video",
      label: "Mute/Unmute media",
      action: (event) => {
        if (!mediaActions.canToggleMuted()) return;
        event.preventDefault();
        mediaActions.toggleMuted();
      },
    },
    {
      id: "copy_selection",
      bind: (bind) => bind.withMod().and.key("c"),
      group: "selection",
      label: "Copy selected",
      action: (event) => {
        event.preventDefault();
        copySelectionImage(event);
      },
    },
    {
      id: "paste_selection",
      bind: (bind) => bind.withMod().and.key("v"),
      group: "selection",
      label: "Paste a shared link to copy parameters from another image",
      action: () => {},
    },
    {
      id: "copy_effects",
      bind: (bind) => bind.withMeta().and.withCtrl().and.key("c"),
      platform: "macos",
      group: "selection",
      label: "Copy effects",
      action: (event) => {
        event.preventDefault();
        copySelectionEffects();
      },
    },
    {
      id: "copy_effects",
      bind: (bind) => bind.withCtrl().and.withAlt().and.key("c"),
      platform: "other",
      group: "selection",
      label: "Copy effects",
      action: (event) => {
        event.preventDefault();
        copySelectionEffects();
      },
    },
    {
      id: "duplicate_entity",
      bind: (bind) => bind.withMod().and.key("d"),
      group: "selection",
      label: "Duplicate selected",
      action: (event) => {
        event.preventDefault();
        duplicateEntities();
      },
    },
    {
      id: "select_all",
      bind: (bind) => bind.withMod().and.key("a"),
      group: "selection",
      label: "Select all",
      action: (event) => {
        event.preventDefault();
        interaction.selectAll();
      },
    },
    {
      id: "clear_selection",
      bind: "Escape",
      group: "selection",
      label: "Clear selection",
      action: () => interaction.clearSelection(),
    },
    {
      id: "clear_selection",
      bind: "Escape",
      group: "canvas",
      label: "Clear selection",
      action: () => interaction.clearSelection(),
    },
  ]);

  return { playPause, centerSelection, resetZoom };
}
