import {
  generatePaletteId,
  generatePaletteName,
  generatePaletteShortName,
  isUserPalette,
} from "#components/palette-preset/palette-presets.ts";
import { toastManager } from "#components/ui/toast/toast-manager.ts";
import { logger } from "#lib/client.logger.ts";
import { config, getCommonFeatures, glassKindResets } from "#config";
import { paletteStore } from "#lib/palette-store.ts";
import { applyShaderDefaults } from "#lib/shader-defaults.ts";
import { preferences } from "#lib/storage.ts";
import { Command, undo } from "#lib/undo.ts";
import { extractPaletteFromImage } from "#lib/palette-extraction/index.ts";
import { useSyncExternalStore } from "react";
import { useCanvas } from "../context/use-canvas.ts";
import { canvasStore, disintegrationController } from "../engine/index.ts";
import {
  AsciiKind,
  DitheringKind,
  GlassKind,
  ShaderType,
  type ColorPalette,
  type SelectionState,
  type ShaderCanvasEntity,
} from "#types/canvas.ts";

// Re-export useParamValue for convenience
export { useParamValue, type ParamResult } from "./use-param-value.ts";

/**
 * Compute selection state from selected entities
 */
function computeSelectionState(entities: ShaderCanvasEntity[]): SelectionState {
  if (entities.length === 0) {
    return {
      entityIds: new Set(),
      count: 0,
      isEmpty: true,
      isSingle: false,
      isMultiple: false,
      shaderTypes: new Set(),
      hasUniformShader: false,
      commonParams: [],
      colorMode: "mixed",
      paramValues: {},
    };
  }

  const shaderTypes = new Set(entities.map((e) => e.shaderType));
  const { params: commonParams, colorMode } = getCommonFeatures([...shaderTypes]);

  // Compute param uniformity
  // Use a simple object type that's compatible with the interface
  const paramValues: Record<string, { isUniform: boolean; value: unknown; values: Set<unknown> }> =
    {};
  for (const param of commonParams) {
    const values = new Set(
      entities.map((e) => {
        const val = e.shaderParams[param];
        // For objects, stringify for comparison
        return typeof val === "object" ? JSON.stringify(val) : val;
      }),
    );
    const firstValue = entities[0]?.shaderParams[param];
    paramValues[param] = {
      isUniform: values.size === 1,
      value: values.size === 1 ? (firstValue ?? null) : null,
      values: new Set(entities.map((e) => e.shaderParams[param])),
    };
  }

  return {
    entityIds: new Set(entities.map((e) => e.id)),
    count: entities.length,
    isEmpty: false,
    isSingle: entities.length === 1,
    isMultiple: entities.length > 1,
    shaderTypes,
    hasUniformShader: shaderTypes.size === 1,
    commonParams,
    colorMode,
    paramValues: paramValues as SelectionState["paramValues"],
  };
}

/**
 * Shared hook for canvas actions used by both sidebar-right and canvas-context-menu.
 * Refactored for bulk operations with multi-select support.
 */
export function useCanvasActions() {
  const {
    selectedEntityParams,
    updateSelectedEntityParams,
    selectedShaderType,
    selectedEntityIds,
    updateEntity,
    removeEntity,
    renderer,
    colorSpace,
    setRenderStateFromURL,
  } = useCanvas();
  const { bringToFront, sendToBack } = useCanvas();

  // Subscribe to store for entity change detection (selectionVersion increments on entity updates)
  const storeSnapshot = useSyncExternalStore(
    canvasStore.subscribe.bind(canvasStore),
    canvasStore.getSelectionSnapshot.bind(canvasStore),
  );

  // Single selected entity (undefined if none or multi-selected)
  const selectedEntity = (() => {
    if (storeSnapshot.selectedEntityIds.size !== 1) return undefined;
    const id = storeSnapshot.selectedEntityIds.values().next().value;
    return id ? storeSnapshot.entities.get(id) : undefined;
  })();
  const hasSelection = selectedEntityIds.size > 0;
  const isMultiSelect = selectedEntityIds.size > 1;
  const isDithering = selectedShaderType === ShaderType.dithering;

  // Get all selected entities - recomputes when selectionVersion changes (entity updates)
  const selectedEntities = [...storeSnapshot.selectedEntityIds]
    .map((id) => storeSnapshot.entities.get(id))
    .filter((e): e is ShaderCanvasEntity => e !== undefined);

  // Compute selection state for UI
  const selectionState = computeSelectionState(selectedEntities);

  /**
   * Bulk update helper - applies an updater to all selected entities
   * Uses transactions for undo/redo grouping
   */
  const updateSelectedEntities = (
    updater: (entity: ShaderCanvasEntity) => Partial<ShaderCanvasEntity>,
  ) => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    if (entities.length === 1) {
      // Single entity: regular update (undo handled by updateEntity)
      const entity = entities[0]!;
      const updates = updater(entity);
      updateEntity(entity.id, updates);
      return;
    }

    // Multiple entities: use transaction for grouped undo
    undo.beginTransaction();
    for (const entity of entities) {
      const updates = updater(entity);
      updateEntity(entity.id, updates);
    }
    undo.commitTransaction(`Update ${entities.length} entities`);
  };

  // Shader type change with sensible defaults (supports multi-select)
  // Per-entity logic: applies shader-specific defaults via applyShaderDefaults
  const handleShaderTypeChange = (value: string | null) => {
    if (!value || !hasSelection) return;

    const targetShaderType = value as ShaderType;

    updateSelectedEntities((entity) => {
      // If already using this shader, just mark dirty (no param changes)
      if (entity.shaderType === targetShaderType) {
        return { shaderType: targetShaderType, textureDirty: true };
      }

      // Apply sensible defaults for the new shader
      return {
        shaderType: targetShaderType,
        shaderParams: applyShaderDefaults(entity.shaderParams, entity.shaderType, targetShaderType),
        textureDirty: true,
      };
    });
  };

  // Dithering algorithm change - uses selectionState for multi-select support
  const handleDitheringKindChange = (value: string | null) => {
    if (!value) return;

    // Only update dithering kind, palette is now at root level
    updateSelectedEntityParams({
      dithering: {
        kind: value as DitheringKind,
      },
    });
  };

  // ASCII character set change
  const handleAsciiKindChange = (value: string | null) => {
    if (!value) return;

    updateSelectedEntityParams({
      ascii: {
        kind: value as AsciiKind,
        invert: selectedEntityParams?.ascii?.invert ?? false,
      },
    });
  };

  // ASCII invert toggle
  const handleAsciiInvertChange = (e: React.ChangeEvent<HTMLInputElement> | boolean) => {
    const invert = typeof e === "boolean" ? e : e.target.checked;
    updateSelectedEntityParams({
      ascii: {
        kind: selectedEntityParams?.ascii?.kind ?? AsciiKind.standard,
        invert,
      },
    });
  };

  // Glass kind change — applies per-kind param resets from glassKindResets config
  const handleGlassKindChange = (value: string | null) => {
    if (!value) return;

    const kind = value as GlassKind;
    const resets = glassKindResets[kind];

    updateSelectedEntityParams({
      glass: { kind },
      ...resets,
    });
  };

  // Palette change - smart handling for custom palette creation and updates
  // Uses shared paletteStore instead of per-entity customPalettes
  const handlePaletteChange = (palette: ColorPalette) => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    // If editing an existing user palette, update in shared store
    if (palette.id && isUserPalette(palette.id)) {
      const oldPalette = paletteStore.getPalettes().find((p) => p.id === palette.id);

      // Don't manage transaction if one is already open (e.g. color picker drag)
      const ownTransaction = !undo.isInTransaction();
      if (ownTransaction) undo.beginTransaction();
      paletteStore.updatePalette(palette.id, palette);
      undo.add(
        Command.create({
          execute: () => paletteStore.updatePalette(palette.id!, palette),
          undo: () =>
            oldPalette ? paletteStore.updatePalette(palette.id!, oldPalette) : undefined,
          description: "Update custom palette",
        }),
      );
      for (const entity of entities) {
        updateEntity(entity.id, {
          shaderParams: { ...entity.shaderParams, palette },
          textureDirty: true,
        });
      }
      if (ownTransaction) undo.commitTransaction("Update custom palette");
      return;
    }

    // If editing a preset (ColorPalette component sends id: "custom" when colors change)
    // This creates a new custom palette in the shared store
    if (palette.id === config.customPaletteId) {
      const existingPalettes = paletteStore.getPalettes();
      const newId = generatePaletteId("custom");
      const newName = generatePaletteName("custom", existingPalettes);
      const newShortName = generatePaletteShortName("custom", existingPalettes);
      const newPalette: ColorPalette = {
        ...palette,
        id: newId,
        name: newName,
        shortName: newShortName,
      };

      // Don't manage transaction if one is already open (e.g. color picker drag)
      const ownTransaction = !undo.isInTransaction();
      if (ownTransaction) undo.beginTransaction();
      paletteStore.addPalette(newPalette);
      undo.add(
        Command.create({
          execute: () => paletteStore.addPalette(newPalette),
          undo: () => paletteStore.removePalette(newId),
          description: "Create custom palette",
        }),
      );
      for (const entity of entities) {
        updateEntity(entity.id, {
          shaderParams: { ...entity.shaderParams, palette: newPalette },
          textureDirty: true,
        });
      }
      if (ownTransaction) undo.commitTransaction("Create custom palette");
      return;
    }

    // Selecting a preset or original palette - just update active palette
    updateSelectedEntityParams({ palette });
  };

  // Palette upload from image - creates a new extracted palette in shared store
  const handlePaletteUpload = async (files: FileList | File | null) => {
    let file: File | null;
    if (files instanceof File) {
      file = files;
    } else if (files?.[0]) {
      file = files[0];
    } else return;

    try {
      const palette = await extractPaletteFromImage(file, { colorCount: 16, colorSpace });

      const entities = canvasStore.getSelectedEntities();
      if (entities.length === 0) return;

      const existingPalettes = paletteStore.getPalettes();
      const name = generatePaletteName("extracted", existingPalettes);
      const shortName = generatePaletteShortName("extracted", existingPalettes);
      const newId = generatePaletteId("extracted");

      const extractedPalette: ColorPalette = {
        ...palette,
        id: newId,
        name,
        shortName,
      };

      const ownTransaction = !undo.isInTransaction();
      if (ownTransaction) undo.beginTransaction();
      paletteStore.addPalette(extractedPalette);
      undo.add(
        Command.create({
          execute: () => paletteStore.addPalette(extractedPalette),
          undo: () => paletteStore.removePalette(newId),
          description: "Extract palette from image",
        }),
      );
      for (const entity of entities) {
        updateEntity(entity.id, {
          shaderParams: { ...entity.shaderParams, palette: extractedPalette },
          textureDirty: true,
        });
      }
      if (ownTransaction) undo.commitTransaction("Extract palette from image");
    } catch (err) {
      logger.error("Failed to extract palette:", err);
    }
  };

  // Delete a custom palette from the shared store
  const handleDeletePalette = (paletteId: string) => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    const oldPalette = paletteStore.getPalettes().find((p) => p.id === paletteId);
    if (!oldPalette) return;

    const ownTransaction = !undo.isInTransaction();
    if (ownTransaction) undo.beginTransaction();
    paletteStore.removePalette(paletteId);
    undo.add(
      Command.create({
        execute: () => paletteStore.removePalette(paletteId),
        undo: () => paletteStore.addPalette(oldPalette),
        description: "Delete custom palette",
      }),
    );

    // If any entity was using the deleted palette, switch to first preset
    const fallbackPalette = Object.values(config.palettes)[0]!;
    for (const entity of entities) {
      if (entity.shaderParams.palette?.id === paletteId) {
        updateEntity(entity.id, {
          shaderParams: { ...entity.shaderParams, palette: fallbackPalette },
          textureDirty: true,
        });
      }
    }
    if (ownTransaction) undo.commitTransaction("Delete custom palette");
  };

  // Show original toggle
  const handleShowOriginalChange = (e: React.ChangeEvent<HTMLInputElement> | boolean) => {
    updateSelectedEntityParams({
      showOriginal: typeof e === "boolean" ? e : e.target.checked,
    });
  };

  const toggleShowOriginal = () => {
    // Use selectionState for multi-select support (toggles to opposite of uniform value, or true if mixed)
    const currentValue = selectionState.paramValues.showOriginal?.isUniform
      ? (selectionState.paramValues.showOriginal.value as boolean)
      : false;
    handleShowOriginalChange(!currentValue);
  };

  // Preserve colors toggle
  const handlePreserveColorsChange = (e: React.ChangeEvent<HTMLInputElement> | boolean) => {
    updateSelectedEntityParams({
      preserveColors: typeof e === "boolean" ? e : e.target.checked,
    });
  };

  const togglePreserveColors = () => {
    // Use selectionState for multi-select support (toggles to opposite of uniform value, or true if mixed)
    const currentValue = selectionState.paramValues.preserveColors?.isUniform
      ? (selectionState.paramValues.preserveColors.value as boolean)
      : false;
    handlePreserveColorsChange(!currentValue);
  };

  // Reverse palette toggle
  const handleReversePaletteChange = (e: React.ChangeEvent<HTMLInputElement> | boolean) => {
    updateSelectedEntityParams({
      reversePalette: typeof e === "boolean" ? e : e.target.checked,
    });
  };

  const toggleReversePalette = () => {
    const currentValue = selectionState.paramValues.reversePalette?.isUniform
      ? (selectionState.paramValues.reversePalette.value as boolean)
      : false;
    handleReversePaletteChange(!currentValue);
  };

  /**
   * Delete selected entities (supports multi-select)
   */
  const deleteEntity = (e?: KeyboardEvent) => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    e?.preventDefault(); // Prevent browser back navigation

    // Reset stagger so multi-entity deletions get staggered timing
    disintegrationController.resetStagger();

    if (entities.length === 1) {
      // Single entity: use existing removeEntity (handles undo)
      removeEntity(entities[0]!.id);
      return;
    }

    // Multiple entities: use transaction for grouped undo
    undo.beginTransaction();
    for (const entity of entities) {
      removeEntity(entity.id);
    }
    undo.commitTransaction(`Delete ${entities.length} entities`);
  };

  // Copy entity to clipboard - single-selection only
  const copyEntity = async function (e?: KeyboardEvent) {
    const entities = canvasStore.getSelectedEntities();
    // Only works for single selection
    if (entities.length !== 1 || !renderer) return;

    const entity = entities[0]!;
    e?.preventDefault();

    try {
      // create clipboard item immediately to not make safari complain
      const clipboardItem = new ClipboardItem({
        "image/png": (async () => {
          const blob = await renderer.renderEntityToBlob(entity);
          if (blob) return blob;
          throw new Error("Failed to render entity to blob");
        })(),
      });
      await navigator.clipboard.write([clipboardItem]);
      toastManager.add({ title: "Image copied to clipboard" });
    } catch (err) {
      logger.error("Failed to copy to clipboard:", err);
      toastManager.add({
        title: "Failed to copy image to clipboard",
        description: "Try saving it instead",
      });
    }
  };

  /** copy entity params from the selected entity */
  const copyEntityParams = () => {
    // copy the url, as that is how users can paste params
    navigator.clipboard.writeText(window.location.href).catch((e) => {
      logger.error(e);
      toastManager.add({
        title: "Failed to copy effects",
        type: "destructive",
      });
    });
  };

  /**
   * Paste params to all selected entities (supports multi-select)
   */
  const pasteEntityParams = async () => {
    const clipboard = await navigator.clipboard.readText();
    if (URL.canParse(clipboard)) {
      const url = new URL(clipboard);
      // setRenderStateFromURL now handles both single and multi-select
      setRenderStateFromURL(url.searchParams);

      const entityCount = canvasStore.getSelectedEntities().length;
      if (entityCount > 1) {
        toastManager.add({
          title: `Applied params to ${entityCount} entities`,
        });
      }
    } else {
      toastManager.add({
        title: "Invalid URL",
        description: "Please paste a valid URL",
        type: "destructive",
      });
    }
  };

  /**
   * Reset all selected entities to default shader parameters
   * Supports multi-select with transaction for grouped undo
   */
  const resetEntityToDefaults = () => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    const defaultParams = structuredClone(config.defaults.shaderParams);
    const defaultShaderType = config.defaults.shader;

    if (entities.length === 1) {
      // Single entity - regular update with undo
      const entity = entities[0]!;
      updateEntity(entity.id, {
        shaderType: defaultShaderType,
        shaderParams: defaultParams,
        textureDirty: true,
      });
    } else {
      // Multi-select - use transaction
      undo.beginTransaction();
      for (const entity of entities) {
        updateEntity(entity.id, {
          shaderType: defaultShaderType,
          shaderParams: structuredClone(config.defaults.shaderParams),
          textureDirty: true,
        });
      }
      undo.commitTransaction(`Reset ${entities.length} entities to defaults`);
    }
  };

  /**
   * Bring all selected entities to front (supports multi-select)
   * Maintains relative z-order by sorting and applying in order
   */
  const handleBringToFront = () => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    // Sort by zIndex to maintain relative order, then bring each to front
    const sorted = [...entities].sort((a, b) => a.zIndex - b.zIndex);
    for (const entity of sorted) {
      bringToFront(entity.id);
    }
  };

  /**
   * Send all selected entities to back (supports multi-select)
   * Maintains relative z-order by sorting and applying in reverse order
   */
  const handleSendToBack = () => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    // Sort by zIndex descending to maintain relative order
    const sorted = [...entities].sort((a, b) => b.zIndex - a.zIndex);
    for (const entity of sorted) {
      sendToBack(entity.id);
    }
  };

  // Snap-to-grid toggle (persists to storage)
  const handleSnapToGridChange = (enabled: boolean) => {
    canvasStore.setSnapToGrid(enabled);
    preferences.setSnapToGrid(enabled);
  };

  // Fancy deletions toggle (persists to storage)
  const handleFancyDeleteChange = (enabled: boolean) => {
    canvasStore.setFancyDelete(enabled);
    preferences.setFancyDelete(enabled);
  };

  // Haptic feedback toggle (persists to storage)
  const handleHapticsChange = (enabled: boolean) => {
    canvasStore.setHaptics(enabled);
    preferences.setHaptics(enabled);
  };

  const handleSizeChange = (value: number | null) => {
    if (value !== null) {
      updateSelectedEntityParams({ size: value });
    }
  };

  const isAscii = selectedShaderType === ShaderType.ascii;

  return {
    // Current state (readonly)
    shaderType: selectedShaderType,
    isDithering,
    isAscii,
    ditheringKind: selectedEntityParams?.dithering?.kind,
    asciiKind: selectedEntityParams?.ascii?.kind,
    asciiInvert: selectedEntityParams?.ascii?.invert ?? false,
    currentPalette: selectedEntityParams?.palette,
    showOriginal: selectedEntityParams?.showOriginal ?? false,
    preserveColors: selectedEntityParams?.preserveColors ?? false,
    hasSelection,
    isMultiSelect,
    selectedEntity,
    selectedEntities,
    originalPalettes: selectedEntity?.originalPalettes,

    // Selection state for UI components
    selectionState,

    // Actions
    handleShaderTypeChange,
    handleDitheringKindChange,
    handleAsciiKindChange,
    handleAsciiInvertChange,
    handleGlassKindChange,
    handlePaletteChange,
    handlePaletteUpload,
    handleDeletePalette,
    handleShowOriginalChange,
    toggleShowOriginal,
    handlePreserveColorsChange,
    togglePreserveColors,
    handleReversePaletteChange,
    toggleReversePalette,
    deleteEntity,
    copyEntity,
    copyEntityParams,
    pasteEntityParams,
    handleBringToFront,
    handleSendToBack,
    resetEntityToDefaults,
    handleSizeChange,
    snapToGrid: storeSnapshot.snapToGrid,
    handleSnapToGridChange,
    fancyDelete: storeSnapshot.fancyDelete,
    handleFancyDeleteChange,
    haptics: storeSnapshot.haptics,
    handleHapticsChange,

    // Bulk update helper
    updateSelectedEntities,
  };
}
