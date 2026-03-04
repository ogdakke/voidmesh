import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { CanvasContext, DebugType, type CanvasContextValue } from "./use-canvas.ts";
import {
  useQueryState,
  parseAsBoolean,
  parseAsString,
  parseAsInteger,
  parseAsFloat,
  useQueryStates,
  parseAsStringLiteral,
  parseAsStringEnum,
} from "nuqs";
import {
  type Viewport,
  type ShaderCanvasEntity,
  type Point,
  type ShaderParams,
  type ColorPalette,
  type PostProcessParams,
  ShaderType,
  Shape,
  DitheringKind,
  AsciiKind,
  GlassKind,
  MediaType,
  isGifEntity,
} from "#types/canvas.ts";
import { getPalettePreset, isAsyncPalette } from "#components/palette-preset/palette-presets.ts";
import type { InfiniteCanvasRenderer } from "#renderer/canvas-renderer.ts";
import type { DeserializeResult } from "#lib/serialization/types.ts";
import { type ImageExportOptions, getImageExtension } from "#renderer/export-formats.ts";
import { canvasStore, gameLoop } from "#engine";

import { toastManager } from "#components/ui/toast/toast-manager.ts";
import { hints } from "#components/ui/hint/hint-manager.ts";
import {
  extractOriginalPalette8,
  extractOriginalPalette16,
  cloneMediaSource,
} from "#lib/media-loader.ts";
import { Command, undo } from "#lib/undo.ts";
import { config } from "#config";
import { preferences } from "#lib/storage.ts";
import { paletteStore } from "#lib/palette-store.ts";
import { logger } from "#lib/client.logger.ts";
import { deepMerge } from "#lib/deep-merge.ts";
import { applyShaderDefaults } from "#lib/shader-defaults.ts";
import { ColorSpace } from "#types/enums.ts";
import type { PartialDeep } from "type-fest";

// --- Resource ownership for undo/redo cleanup ---
// Tracks which undo command "owns" cleanup rights for each entity's media resources.
// When multiple commands reference the same entity (e.g., addEntityCmd and removeEntityCmd),
// only the most recent owner may destroy resources on eviction.
let nextOwnerToken = 0;
const resourceOwners = new Map<string, number>();

function claimResourceOwnership(entityId: string): number {
  const token = ++nextOwnerToken;
  resourceOwners.set(entityId, token);
  return token;
}

function tryCleanupEntityResources(entity: ShaderCanvasEntity, ownerToken: number): void {
  if (resourceOwners.get(entity.id) !== ownerToken) return;
  if (canvasStore.getState().entities.has(entity.id)) {
    // Entity is alive — no cleanup needed, but discard stale ownership entry
    resourceOwners.delete(entity.id);
    return;
  }

  if (entity.mediaSource.type === MediaType.video) {
    const video = entity.mediaSource.videoElement;
    const videoSrc = video.src;
    video.src = "";
    video.load();
    URL.revokeObjectURL(videoSrc);
  } else if (isGifEntity(entity)) {
    for (const frame of entity.mediaSource.frames) {
      frame.bitmap.close();
    }
  } else if (entity.mediaSource.type === "svg") {
    entity.imageBitmap.close();
  } else if (entity.mediaSource.type === "image") {
    entity.imageBitmap.close();
  }

  resourceOwners.delete(entity.id);
}

const shaderUrlParams = {
  shader: parseAsStringLiteral(Object.values(ShaderType)).withDefault(config.defaults.shader),
  size: parseAsInteger.withDefault(config.defaults.shaderParams.size),
  shape: parseAsStringLiteral(Object.values(Shape)).withDefault(config.defaults.shaderParams.shape),
  preserveColors: parseAsBoolean.withDefault(config.defaults.shaderParams.preserveColors),
  reversePalette: parseAsBoolean.withDefault(config.defaults.shaderParams.reversePalette),
  showOriginal: parseAsBoolean.withDefault(config.defaults.shaderParams.showOriginal),
  eagerness: parseAsFloat.withDefault(config.defaults.shaderParams.blobs.eagerness),
  scale: parseAsFloat.withDefault(config.defaults.shaderParams.scale),
  intensity: parseAsFloat.withDefault(config.defaults.shaderParams.intensity),
  ditheringKind: parseAsStringLiteral(Object.values(DitheringKind)).withDefault(
    config.defaults.shaderParams.dithering.kind,
  ),
  // Palette support: preset ID or comma-separated hex colors
  preset: parseAsString.withDefault(config.asyncPalettes[0]), // Preset ID (e.g., "gameboy", "cga")
  // Post-processing params
  ppEnabled: parseAsBoolean.withDefault(config.defaults.shaderParams.postProcess.enabled),
  ppGrainEnabled: parseAsBoolean.withDefault(
    config.defaults.shaderParams.postProcess.grain.enabled,
  ),
  ppGrainSize: parseAsFloat.withDefault(config.defaults.shaderParams.postProcess.grain.size),
  ppGrainIntensity: parseAsFloat.withDefault(
    config.defaults.shaderParams.postProcess.grain.intensity,
  ),
  ppBloomEnabled: parseAsBoolean.withDefault(
    config.defaults.shaderParams.postProcess.bloom.enabled,
  ),
  ppBloomThreshold: parseAsFloat.withDefault(
    config.defaults.shaderParams.postProcess.bloom.threshold,
  ),
  ppBloomIntensity: parseAsFloat.withDefault(
    config.defaults.shaderParams.postProcess.bloom.intensity,
  ),
  ppBloomFilterRadius: parseAsInteger.withDefault(
    config.defaults.shaderParams.postProcess.bloom.filterRadius,
  ),
  ppChromaticEnabled: parseAsBoolean.withDefault(
    config.defaults.shaderParams.postProcess.chromaticAberration.enabled,
  ),
  ppChromaticOffset: parseAsFloat.withDefault(
    config.defaults.shaderParams.postProcess.chromaticAberration.offset,
  ),
  ppBloomSoftness: parseAsFloat.withDefault(
    config.defaults.shaderParams.postProcess.bloom.softness,
  ),
  // ASCII shader params
  asciiKind: parseAsStringLiteral(Object.values(AsciiKind)).withDefault(
    config.defaults.shaderParams.ascii.kind,
  ),
  asciiInvert: parseAsBoolean.withDefault(config.defaults.shaderParams.ascii.invert),
  // Glass shader params
  glassKind: parseAsStringLiteral(Object.values(GlassKind)).withDefault(
    config.defaults.shaderParams.glass.kind,
  ),
  angle: parseAsFloat.withDefault(config.defaults.shaderParams.glass.angle),
  caustic: parseAsFloat.withDefault(config.defaults.shaderParams.glass.caustic),
  frostiness: parseAsFloat.withDefault(config.defaults.shaderParams.glass.frostiness),
  highlight: parseAsFloat.withDefault(config.defaults.shaderParams.glass.highlight),
  dispersion: parseAsFloat.withDefault(config.defaults.shaderParams.glass.dispersion),
  flow: parseAsFloat.withDefault(config.defaults.shaderParams.glass.flow),
};

/**
 * Convert comma-separated hex colors to ColorPalette
 */
function parsePaletteFromUrl(presetId: string | null): ColorPalette | undefined {
  // First check if a preset is specified
  if (presetId) {
    const preset = getPalettePreset(presetId);
    if (preset) return preset;
  }

  return undefined;
}

/**
 * Convert ColorPalette to URL params (preset and/or palette string)
 */
function paletteToUrlParams(palette: ColorPalette | undefined): {
  preset: string | null;
  palette: string | null;
} {
  if (!palette) {
    return { preset: null, palette: null };
  }

  // If it's a preset and not custom palette, just use the preset ID
  if (palette.id && palette.id !== config.customPaletteId) {
    return { preset: palette.id, palette: null };
  }

  return { preset: null, palette: null };
}

export type { CanvasContextValue } from "./use-canvas.ts";

export function CanvasProvider({ children }: { children: ReactNode }) {
  // Debug mode URL param
  const [debugType, setDebugType] = useQueryState(
    "debug",
    parseAsStringEnum(Object.values(DebugType)),
  );
  const debug = debugType !== null;
  // URL params for selected entity shader settings (for shareable configurations)
  const [renderState, setRenderState] = useQueryStates(shaderUrlParams);
  // NOTE: URL param keys were previously used for URL→entity sync
  // Now we update entities directly, so these are no longer needed

  // Subscribe React to store changes (only for UI-relevant state)
  const state = useSyncExternalStore(
    canvasStore.subscribe.bind(canvasStore),
    canvasStore.getSelectionSnapshot.bind(canvasStore),
  );

  // Initialize debug mode with test image when ?debug=true
  useEffect(() => {
    if (debugType === DebugType.load && import.meta.env.DEV) {
      import("../engine/debug-script.ts")
        .then(({ debugCanvas }) => debugCanvas(canvasStore))
        .catch(console.error);
    }
    canvasStore.setDebugMode(debug);
  }, [debugType, debug]);

  // Hydrate persisted preferences on mount
  useEffect(() => {
    preferences.getSnapToGrid().then((v) => canvasStore.setSnapToGrid(v));
    preferences.getFancyDelete().then((v) => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      canvasStore.setFancyDelete(v ?? !reduced);
    });
    preferences.getHaptics().then((v) => canvasStore.setHaptics(v));
    preferences.getCustomPalettes().then((palettes) => paletteStore.setPalettes(palettes));
  }, []);

  // Helper: Build shader params from URL state
  const buildShaderParamsFromUrl = (): ShaderParams => {
    // Parse palette from URL params (now at root level)
    const palette = parsePaletteFromUrl(renderState.preset);

    // Build post-process params
    const postProcess: PostProcessParams = {
      enabled: renderState.ppEnabled,
      grain: {
        enabled: renderState.ppGrainEnabled,
        size: renderState.ppGrainSize,
        intensity: renderState.ppGrainIntensity,
      },
      bloom: {
        enabled: renderState.ppBloomEnabled,
        threshold: renderState.ppBloomThreshold,
        intensity: renderState.ppBloomIntensity,
        filterRadius: renderState.ppBloomFilterRadius,
        softness: renderState.ppBloomSoftness,
      },
      chromaticAberration: {
        enabled: renderState.ppChromaticEnabled,
        offset: renderState.ppChromaticOffset,
      },
    };

    return {
      size: renderState.size,
      shape: renderState.shape,
      preserveColors: renderState.preserveColors,
      reversePalette: renderState.reversePalette,
      showOriginal: renderState.showOriginal,
      background: config.defaults.shaderParams.background,
      color: config.defaults.shaderParams.color,
      scale: renderState.scale,
      intensity: renderState.intensity,
      blobs: {
        eagerness: renderState.eagerness,
      },
      dithering: {
        kind: renderState.ditheringKind,
      },
      ascii: {
        kind: renderState.asciiKind,
        invert: renderState.asciiInvert,
      },
      glass: {
        kind: renderState.glassKind,
        angle: renderState.angle,
        caustic: renderState.caustic,
        frostiness: renderState.frostiness,
        highlight: renderState.highlight,
        dispersion: renderState.dispersion,
        flow: renderState.flow,
      },
      palette: palette ?? config.defaults.shaderParams.palette,
      postProcess,
    };
  };

  // NOTE: URL→entity sync effect REMOVED
  // The old effect had a race condition where `previousSelectedIdRef` was updated async
  // causing param changes to be skipped. Now we update entities directly in the handlers.

  // Push entity params to URL on selection change OR entity param change
  // Clear URL state on multi-select - only sync when single entity selected
  useEffect(() => {
    const selectedEntities = canvasStore.getSelectedEntities();

    // Multi-select or no selection: clear URL params for sharing
    if (selectedEntities.length !== 1) {
      // Clear URL params when multi-selecting
      if (selectedEntities.length > 1) {
        setRenderState({
          shader: null,
          size: null,
          shape: null,
          preserveColors: null,
          reversePalette: null,
          showOriginal: null,
          eagerness: null,
          scale: null,
          intensity: null,
          ditheringKind: null,
          preset: null,
          ppEnabled: null,
          angle: null,
          caustic: null,
          glassKind: null,
          frostiness: null,
          highlight: null,
          dispersion: null,
          flow: null,
          ppGrainEnabled: null,
          ppGrainSize: null,
          ppGrainIntensity: null,
          ppBloomEnabled: null,
          ppBloomThreshold: null,
          ppBloomIntensity: null,
          ppBloomFilterRadius: null,
          ppBloomSoftness: null,
          ppChromaticEnabled: null,
          ppChromaticOffset: null,
          asciiKind: null,
          asciiInvert: null,
        }).catch((e) => logger.error(e));
      }
      return;
    }

    const entity = selectedEntities[0]!;

    // Convert palette to URL params (now at root level)
    let paletteParams = paletteToUrlParams(entity.shaderParams.palette);

    // Only preserve async palette preset if:
    // 1. The entity actually has the async palette extracted
    // 2. The entity's current palette matches the async preset (not a custom palette)
    // This prevents custom palettes from being overwritten when the URL's preset param
    // is missing and defaults to "original-8"
    if (isAsyncPalette(renderState.preset)) {
      const hasAsyncPalette =
        (renderState.preset === "original-8" && entity.originalPalettes?.palette8) ||
        (renderState.preset === "original-16" && entity.originalPalettes?.palette16);

      // Only apply async preset if entity palette actually uses it (has matching ID)
      // Skip if entity has a custom palette (id: undefined)
      const entityPaletteMatchesAsync = entity.shaderParams.palette?.id === renderState.preset;

      if (hasAsyncPalette && entityPaletteMatchesAsync) {
        paletteParams = { preset: renderState.preset, palette: null };
      }
    }

    // Get post-process params with defaults
    const ppDefaults = config.defaults.shaderParams.postProcess!;
    const pp = entity.shaderParams.postProcess;

    setRenderState({
      shader: entity.shaderType,
      size: entity.shaderParams.size,
      shape: entity.shaderParams.shape,
      preserveColors: entity.shaderParams.preserveColors,
      reversePalette: entity.shaderParams.reversePalette,
      showOriginal: entity.shaderParams.showOriginal,
      eagerness:
        entity.shaderParams.blobs?.eagerness ?? config.defaults.shaderParams.blobs!.eagerness,
      scale: entity.shaderParams.scale,
      intensity: entity.shaderParams.intensity,
      angle: entity.shaderParams.glass?.angle,
      caustic: entity.shaderParams.glass?.caustic,
      glassKind: entity.shaderParams.glass?.kind,
      frostiness: entity.shaderParams.glass?.frostiness,
      highlight: entity.shaderParams.glass?.highlight,
      dispersion: entity.shaderParams.glass?.dispersion,
      flow: entity.shaderParams.glass?.flow,
      ditheringKind:
        entity.shaderParams.dithering?.kind ?? config.defaults.shaderParams.dithering!.kind,
      asciiKind: entity.shaderParams.ascii?.kind ?? config.defaults.shaderParams.ascii.kind,
      asciiInvert: entity.shaderParams.ascii?.invert ?? config.defaults.shaderParams.ascii.invert,
      preset: paletteParams.preset,
      ppEnabled: pp?.enabled ?? ppDefaults.enabled,
      ppGrainEnabled: pp?.grain?.enabled ?? ppDefaults.grain!.enabled,
      ppGrainSize: pp?.grain?.size ?? ppDefaults.grain!.size,
      ppGrainIntensity: pp?.grain?.intensity ?? ppDefaults.grain!.intensity,
      ppBloomEnabled: pp?.bloom?.enabled ?? ppDefaults.bloom!.enabled,
      ppBloomThreshold: pp?.bloom?.threshold ?? ppDefaults.bloom!.threshold,
      ppBloomIntensity: pp?.bloom?.intensity ?? ppDefaults.bloom!.intensity,
      ppBloomFilterRadius: pp?.bloom?.filterRadius ?? ppDefaults.bloom!.filterRadius,
      ppBloomSoftness: pp?.bloom?.softness ?? ppDefaults.bloom!.softness,
      ppChromaticEnabled:
        pp?.chromaticAberration?.enabled ?? ppDefaults.chromaticAberration!.enabled,
      ppChromaticOffset: pp?.chromaticAberration?.offset ?? ppDefaults.chromaticAberration!.offset,
    }).catch((e) => logger.error(e));
    // Include state.version to re-run when entity params change (not just selection)
  }, [state.selectedEntityIds, state.entities, state.version, renderState.preset, setRenderState]);

  /** how many updates the user has done in this session */
  const updatesCount = useRef(0);
  /** has the user been shown the hint yet */
  const hintShownRef = useRef(false);

  // Counters for generating unique IDs, z-indices, and image names
  const nextIdRef = useRef(1);
  const nextZIndexRef = useRef(1);
  const nextImageNumberRef = useRef(1);

  // Renderer reference for cleanup
  const rendererRef = useRef<InfiniteCanvasRenderer | null>(null);
  const [rendererState, setRendererState] = useState<InfiniteCanvasRenderer | null>(null);
  const [colorSpace, setColorSpace] = useState<ColorSpace>(ColorSpace.srgb);

  // Viewport operations - delegate to store
  const setViewport = (newViewport: Viewport) => {
    canvasStore.setViewport(newViewport);
  };

  const panBy = (delta: Point) => {
    canvasStore.panBy(delta);
  };

  const resetViewport = () => {
    canvasStore.setViewport(config.defaults.viewport);
  };

  // Entity operations - delegate to store
  const addEntity = (
    entity: Omit<ShaderCanvasEntity, "id" | "zIndex" | "name">,
    filename?: string,
  ): string => {
    const id = `entity-${nextIdRef.current++}`;
    const zIndex = nextZIndexRef.current++;
    const name = filename || `Image ${nextImageNumberRef.current++}`;

    // Apply URL params to new entity (for sharing feature)
    let shaderParams = buildShaderParamsFromUrl();

    // Handle async palette presets: use fallback since original palettes
    // are extracted asynchronously (images) or not at all (videos)
    if (isAsyncPalette(renderState.preset)) {
      const fallbackPalette: ColorPalette = config.defaults.shaderParams.palette;
      shaderParams = {
        ...shaderParams,
        palette: fallbackPalette,
      };
    }

    const newEntity: ShaderCanvasEntity = {
      ...entity,
      id,
      name,
      zIndex,
      shaderType: renderState.shader as ShaderType,
      shaderParams,
      mediaSource: entity.mediaSource as any,
      textureDirty: true,
      edited: false,
    };

    canvasStore.addEntity(newEntity);

    // Add undo support for entity creation
    const ownerToken = claimResourceOwnership(newEntity.id);
    undo.add(
      Command.create({
        undo: () => {
          // Pause playback if playing
          if (newEntity.mediaSource.type === MediaType.video) {
            newEntity.mediaSource.videoElement.pause();
          } else if (isGifEntity(newEntity) && newEntity.playback) {
            newEntity.playback.isPlaying = false;
          }
          rendererRef.current?.removeEntityTexture(newEntity.id);
          canvasStore.removeEntity(newEntity.id);
        },
        execute: () => {
          canvasStore.addEntity(newEntity);
        },
        onEvict: () => tryCleanupEntityResources(newEntity, ownerToken),
        description: `Add entity ${newEntity.name}`,
      }),
    );

    // Async palette extraction for images, GIFs, and SVGs (use first frame for GIFs)
    if (
      entity.mediaSource.type === MediaType.image ||
      entity.mediaSource.type === MediaType.gif ||
      entity.mediaSource.type === MediaType.svg
    ) {
      // Capture the preset at add-time (in case URL changes before extraction completes)
      const targetPreset = renderState.preset;

      // Extract 8-color palette first (fast)
      extractOriginalPalette8(entity.imageBitmap, colorSpace)
        .then((palette8) => {
          const currentEntity = canvasStore.getState().entities.get(id);
          if (!currentEntity) return; // Entity was deleted

          // Update originalPalettes
          canvasStore.updateEntity(id, {
            originalPalettes: { ...currentEntity.originalPalettes, palette8 },
          });

          // If this entity should use original-8, apply it to shaderParams now
          if (targetPreset === "original-8") {
            canvasStore.updateEntity(id, {
              shaderParams: {
                ...currentEntity.shaderParams,
                palette: palette8,
              },
              textureDirty: true,
            });
          }
        })
        .catch((err) => logger.warn("Failed to extract 8-color palette:", err));

      // Extract 16-color palette in background (slower)
      extractOriginalPalette16(entity.imageBitmap, colorSpace)
        .then((palette16) => {
          const currentEntity = canvasStore.getState().entities.get(id);
          if (!currentEntity) return; // Entity was deleted

          // Update originalPalettes
          canvasStore.updateEntity(id, {
            originalPalettes: {
              ...currentEntity.originalPalettes,
              palette16,
            },
          });

          // If this entity should use original-16, apply it to shaderParams now
          if (targetPreset === "original-16") {
            canvasStore.updateEntity(id, {
              shaderParams: {
                ...currentEntity.shaderParams,
                palette: palette16,
              },
              textureDirty: true,
            });
          }
        })
        .catch((err) => logger.warn("Failed to extract 16-color palette:", err));
    }

    return id;
  };

  const updateEntity = (id: string, updates: Partial<ShaderCanvasEntity>) => {
    const entity = state.entities.get(id);
    if (!entity) return;

    // Capture only the fields being changed (before mutation)
    const previousValues: Partial<ShaderCanvasEntity> = {};
    for (const key of Object.keys(updates) as (keyof ShaderCanvasEntity)[]) {
      // Deep clone to avoid reference issues
      const value = entity[key];
      // Use type assertion since we know we're copying valid entity fields
      (previousValues as any)[key] =
        typeof value === "object" && value !== null ? structuredClone(value) : value;
    }

    // Ensure undo also triggers re-render when the original update marked texture dirty
    if ("textureDirty" in updates && updates.textureDirty) {
      previousValues.textureDirty = true;
    }

    canvasStore.updateEntity(id, updates);

    undo.add(
      Command.create({
        undo: () => canvasStore.updateEntity(id, previousValues),
        execute: () => canvasStore.updateEntity(id, updates),
        description: `Update entity ${id}`,
      }),
    );
  };

  const removeEntity = (id: string) => {
    // Get entity before removal - deep clone to preserve all data including video element reference
    const entity = state.entities.get(id);
    if (!entity) return;

    // Clone the entity but keep the video element reference (we need it for restore)
    const entityCopy: ShaderCanvasEntity = {
      ...entity,
      position: { ...entity.position },
      size: { ...entity.size },
      shaderParams: structuredClone(entity.shaderParams),
      originalPalettes: entity.originalPalettes
        ? structuredClone(entity.originalPalettes)
        : undefined,
      // Keep mediaSource as-is (references to videoElement/imageBitmap are needed for restore)
      mediaSource: entity.mediaSource as any,
    };

    // Capture playback state before pausing (entityCopy.playback is a shared reference)
    const wasPlaying = entity.playback?.isPlaying ?? false;

    // For animated entities, pause but DON'T destroy resources yet
    if (entity.mediaSource.type === MediaType.video) {
      entity.mediaSource.videoElement.pause();
    } else if (isGifEntity(entity) && entity.playback) {
      entity.playback.isPlaying = false;
    }

    // Snapshot the entity's rendered texture and start dust animation overlay.
    // This copies the GPU texture so the entity can be removed immediately.
    if (canvasStore.getState().fancyDelete) {
      rendererRef.current?.startDisintegration(entity);
    }

    // Clean up renderer texture cache and remove from store immediately
    rendererRef.current?.removeEntityTexture(id);
    canvasStore.removeEntity(id);

    const ownerToken = claimResourceOwnership(entityCopy.id);
    undo.add(
      Command.create({
        undo: () => {
          // Cancel any still-playing disintegration overlay
          rendererRef.current?.cancelDisintegration(entityCopy.id);
          // Restore the entity with all its resources
          canvasStore.addEntity(entityCopy);
          // Resume playback if entity was playing when deleted
          if (wasPlaying) {
            if (entityCopy.mediaSource.type === MediaType.video) {
              entityCopy.mediaSource.videoElement.play().catch((e) => logger.error(e));
            }
            if (entityCopy.playback) {
              entityCopy.playback.isPlaying = true;
            }
          }
        },
        execute: () => {
          // Re-delete the entity (no animation on redo)
          if (entityCopy.mediaSource.type === MediaType.video) {
            entityCopy.mediaSource.videoElement.pause();
          } else if (isGifEntity(entityCopy) && entityCopy.playback) {
            entityCopy.playback.isPlaying = false;
          }
          rendererRef.current?.removeEntityTexture(entityCopy.id);
          canvasStore.removeEntity(entityCopy.id);
        },
        onEvict: () => tryCleanupEntityResources(entityCopy, ownerToken),
        description: `Delete entity ${entity.name}`,
      }),
    );
  };

  const selectEntity = (id: string | null) => {
    canvasStore.setSelectedEntity(id);
  };

  const moveEntity = (id: string, delta: Point) => {
    const entity = canvasStore.getState().entities.get(id);
    if (!entity) return;

    const previousPosition = { ...entity.position };
    canvasStore.moveEntity(id, delta);
    const newPosition = { ...canvasStore.getState().entities.get(id)!.position };

    undo.add(
      Command.create({
        undo: () => canvasStore.updateEntity(id, { position: previousPosition }),
        execute: () => canvasStore.updateEntity(id, { position: newPosition }),
        description: `Move entity ${id}`,
      }),
    );
  };

  const bringToFront = (id: string) => {
    const entity = canvasStore.getState().entities.get(id);
    if (!entity) return;

    const previousZIndex = entity.zIndex;
    const newZIndex = nextZIndexRef.current++;
    canvasStore.updateEntity(id, { zIndex: newZIndex });

    undo.add(
      Command.create({
        undo: () => canvasStore.updateEntity(id, { zIndex: previousZIndex }),
        execute: () => canvasStore.updateEntity(id, { zIndex: newZIndex }),
        description: `Bring to front ${id}`,
      }),
    );
  };

  const sendToBack = (id: string) => {
    const entity = canvasStore.getState().entities.get(id);
    if (!entity) return;

    const previousZIndex = entity.zIndex;
    const entities = Array.from(state.entities.values());
    const minZIndex = Math.min(...entities.map((e) => e.zIndex), 0);
    const newZIndex = minZIndex - 1;
    canvasStore.updateEntity(id, { zIndex: newZIndex });

    undo.add(
      Command.create({
        undo: () => canvasStore.updateEntity(id, { zIndex: previousZIndex }),
        execute: () => canvasStore.updateEntity(id, { zIndex: newZIndex }),
        description: `Send to back ${id}`,
      }),
    );
  };

  const duplicateEntities = async (): Promise<string[]> => {
    const selected = canvasStore.getSelectedEntities();
    if (selected.length === 0) return [];

    // Clone all media sources in parallel (async: creates independent video elements, bitmaps, etc.)
    const clones = await Promise.all(
      selected.map(async (entity) => {
        const { mediaSource, imageBitmap } = await cloneMediaSource(
          entity.mediaSource,
          entity.imageBitmap,
        );
        return { entity, mediaSource, imageBitmap };
      }),
    );

    const newIds: string[] = [];
    const useTransaction = clones.length > 1;
    if (useTransaction) undo.beginTransaction();

    for (const { entity, mediaSource, imageBitmap } of clones) {
      const id = `entity-${nextIdRef.current++}`;
      const zIndex = nextZIndexRef.current++;
      const baseName = entity.name;
      const entities = canvasStore.getState().entities;
      let n = 1;
      while (entities.values().some((e) => e.name === `${baseName} (${n})`)) n++;
      const name = `${baseName} (${n})`;

      const clone: ShaderCanvasEntity = {
        ...entity,
        id,
        zIndex,
        name,
        position: { x: entity.position.x + 30, y: entity.position.y + 30 },
        size: { ...entity.size },
        originalSize: { ...entity.originalSize },
        mediaSource: mediaSource as any,
        imageBitmap,
        shaderParams: structuredClone(entity.shaderParams),
        originalPalettes: entity.originalPalettes
          ? structuredClone(entity.originalPalettes)
          : undefined,
        playback: entity.playback ? { ...entity.playback, isPlaying: false } : undefined,
        texture: undefined,
        textureDirty: true,
        selected: false,
        edited: false,
      };

      canvasStore.addEntity(clone);
      newIds.push(id);

      const ownerToken = claimResourceOwnership(clone.id);
      undo.add(
        Command.create({
          undo: () => {
            if (clone.mediaSource.type === MediaType.video) {
              clone.mediaSource.videoElement.pause();
            } else if (isGifEntity(clone) && clone.playback) {
              clone.playback.isPlaying = false;
            }
            rendererRef.current?.removeEntityTexture(clone.id);
            canvasStore.removeEntity(clone.id);
          },
          execute: () => {
            canvasStore.addEntity(clone);
          },
          onEvict: () => tryCleanupEntityResources(clone, ownerToken),
          description: `Duplicate entity ${entity.name}`,
        }),
      );
    }

    if (useTransaction) undo.commitTransaction(`Duplicate ${selected.length} entities`);

    canvasStore.replaceSelection(newIds);
    return newIds;
  };

  const getContextOpenEntity = () => {
    return state.contextOpenEntityId ? state.entities.get(state.contextOpenEntityId) : undefined;
  };

  // Shader type for selected entity (first entity's type when multi-select)
  const selectedShaderType = (() => {
    if (state.selectedEntityIds.size === 0) return renderState.shader;
    const firstId = state.selectedEntityIds.values().next().value;
    const entity = firstId ? state.entities.get(firstId) : undefined;
    // Return first entity's type (UI uses selectionState for mixed detection)
    return entity?.shaderType ?? renderState.shader;
  })();

  // Shader params for selected entity (first entity's params when multi-select)
  const selectedEntityParams = (() => {
    if (state.selectedEntityIds.size === 0) return null;
    const firstId = state.selectedEntityIds.values().next().value;
    const entity = firstId ? state.entities.get(firstId) : undefined;
    // Return first entity's params (UI uses selectionState for mixed detection)
    return entity?.shaderParams ?? null;
  })();

  // Helper to sync entity params to URL (for sharing feature)
  const syncEntityToUrl = (entity: ShaderCanvasEntity) => {
    const paletteParams = paletteToUrlParams(entity.shaderParams.palette);
    const ppDefaults = config.defaults.shaderParams.postProcess!;
    const pp = entity.shaderParams.postProcess;

    setRenderState({
      shader: entity.shaderType,
      size: entity.shaderParams.size,
      shape: entity.shaderParams.shape,
      preserveColors: entity.shaderParams.preserveColors,
      reversePalette: entity.shaderParams.reversePalette,
      showOriginal: entity.shaderParams.showOriginal,
      eagerness:
        entity.shaderParams.blobs?.eagerness ?? config.defaults.shaderParams.blobs!.eagerness,
      scale: entity.shaderParams.scale,
      intensity: entity.shaderParams.intensity,
      ditheringKind:
        entity.shaderParams.dithering?.kind ?? config.defaults.shaderParams.dithering!.kind,
      asciiKind: entity.shaderParams.ascii?.kind ?? config.defaults.shaderParams.ascii.kind,
      asciiInvert: entity.shaderParams.ascii?.invert ?? config.defaults.shaderParams.ascii.invert,
      angle: entity.shaderParams.glass?.angle ?? config.defaults.shaderParams.glass!.angle,
      caustic: entity.shaderParams.glass?.caustic ?? config.defaults.shaderParams.glass!.caustic,
      glassKind: entity.shaderParams.glass?.kind ?? config.defaults.shaderParams.glass!.kind,
      frostiness:
        entity.shaderParams.glass?.frostiness ?? config.defaults.shaderParams.glass!.frostiness,
      highlight:
        entity.shaderParams.glass?.highlight ?? config.defaults.shaderParams.glass!.highlight,
      dispersion:
        entity.shaderParams.glass?.dispersion ?? config.defaults.shaderParams.glass!.dispersion,
      flow: entity.shaderParams.glass?.flow ?? config.defaults.shaderParams.glass!.flow,
      preset: paletteParams.preset,
      ppEnabled: pp?.enabled ?? ppDefaults.enabled,
      ppGrainEnabled: pp?.grain?.enabled ?? ppDefaults.grain!.enabled,
      ppGrainSize: pp?.grain?.size ?? ppDefaults.grain!.size,
      ppGrainIntensity: pp?.grain?.intensity ?? ppDefaults.grain!.intensity,
      ppBloomEnabled: pp?.bloom?.enabled ?? ppDefaults.bloom!.enabled,
      ppBloomThreshold: pp?.bloom?.threshold ?? ppDefaults.bloom!.threshold,
      ppBloomIntensity: pp?.bloom?.intensity ?? ppDefaults.bloom!.intensity,
      ppBloomFilterRadius: pp?.bloom?.filterRadius ?? ppDefaults.bloom!.filterRadius,
      ppBloomSoftness: pp?.bloom?.softness ?? ppDefaults.bloom!.softness,
      ppChromaticEnabled:
        pp?.chromaticAberration?.enabled ?? ppDefaults.chromaticAberration!.enabled,
      ppChromaticOffset: pp?.chromaticAberration?.offset ?? ppDefaults.chromaticAberration!.offset,
    }).catch((e) => logger.error(e));
  };

  // Update shader type - DIRECT entity update (no URL race condition)
  // Applies shader-specific defaults via applyShaderDefaults
  const updateSelectedShaderType = (shaderType: ShaderType) => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    if (entities.length === 1) {
      // Single selection: update entity directly
      const entity = entities[0]!;
      const previousShaderType = entity.shaderType;
      const previousParams = structuredClone(entity.shaderParams);

      // Skip if already using this shader (no changes needed)
      if (entity.shaderType === shaderType) {
        canvasStore.updateEntity(entity.id, { textureDirty: true });
        return;
      }

      // Apply sensible defaults for the new shader
      const newParams = applyShaderDefaults(entity.shaderParams, entity.shaderType, shaderType);

      canvasStore.updateEntity(entity.id, {
        shaderType,
        shaderParams: newParams,
        textureDirty: true,
      });

      // Sync to URL for sharing
      syncEntityToUrl({ ...entity, shaderType, shaderParams: newParams });

      undo.add(
        Command.create({
          undo: () => {
            canvasStore.updateEntity(entity.id, {
              shaderType: previousShaderType,
              shaderParams: previousParams,
              textureDirty: true,
            });
            syncEntityToUrl({
              ...entity,
              shaderType: previousShaderType,
              shaderParams: previousParams,
            });
          },
          execute: () => {
            canvasStore.updateEntity(entity.id, {
              shaderType,
              shaderParams: newParams,
              textureDirty: true,
            });
            syncEntityToUrl({ ...entity, shaderType, shaderParams: newParams });
          },
          description: `Change shader type to ${shaderType}`,
        }),
      );
    } else {
      // Multi-select: update all with transaction
      undo.beginTransaction();
      for (const entity of entities) {
        const prevShaderType = entity.shaderType;
        const previousParams = structuredClone(entity.shaderParams);

        // Skip param changes if already using this shader
        if (entity.shaderType === shaderType) {
          canvasStore.updateEntity(entity.id, { textureDirty: true });
          continue;
        }

        // Apply sensible defaults for the new shader
        const newParams = applyShaderDefaults(entity.shaderParams, entity.shaderType, shaderType);

        canvasStore.updateEntity(entity.id, {
          shaderType,
          shaderParams: newParams,
          textureDirty: true,
        });

        undo.add(
          Command.create({
            undo: () =>
              canvasStore.updateEntity(entity.id, {
                shaderType: prevShaderType,
                shaderParams: previousParams,
                textureDirty: true,
              }),
            execute: () =>
              canvasStore.updateEntity(entity.id, {
                shaderType,
                shaderParams: newParams,
                textureDirty: true,
              }),
            description: `Change shader for ${entity.id}`,
          }),
        );
      }
      undo.commitTransaction(`Change shader type for ${entities.length} entities`);
    }
  };

  // Update shader params - DIRECT entity update (no URL race condition)
  const updateSelectedEntityParams = (
    params: PartialDeep<ShaderParams>,
    options?: { skipUndo?: boolean },
  ) => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    updatesCount.current += 1;
    const skipUndo = options?.skipUndo ?? false;

    if (entities.length === 1) {
      // Single selection: update entity directly
      const entity = entities[0]!;
      const previousParams = skipUndo ? null : structuredClone(entity.shaderParams);

      // Deep merge params (handles nested objects at any depth)
      const newParams = deepMerge(entity.shaderParams, params);

      canvasStore.updateEntity(entity.id, {
        shaderParams: newParams,
        textureDirty: true,
      });

      // Sync to URL for sharing
      syncEntityToUrl({ ...entity, shaderParams: newParams });

      if (!skipUndo) {
        undo.add(
          Command.create({
            undo: () => {
              canvasStore.updateEntity(entity.id, {
                shaderParams: previousParams!,
                textureDirty: true,
              });
              syncEntityToUrl({ ...entity, shaderParams: previousParams! });
            },
            execute: () => {
              canvasStore.updateEntity(entity.id, {
                shaderParams: newParams,
                textureDirty: true,
              });
              syncEntityToUrl({ ...entity, shaderParams: newParams });
            },
            description: "Update shader params",
          }),
        );
      }
    } else {
      // Multi-select: update all with transaction
      if (!skipUndo) undo.beginTransaction();
      for (const entity of entities) {
        const previousParams = skipUndo ? null : structuredClone(entity.shaderParams);

        // Deep merge params (handles nested objects at any depth)
        const newParams: ShaderParams = deepMerge(entity.shaderParams, params);

        canvasStore.updateEntity(entity.id, {
          shaderParams: newParams,
          textureDirty: true,
        });

        if (!skipUndo) {
          undo.add(
            Command.create({
              undo: () =>
                canvasStore.updateEntity(entity.id, {
                  shaderParams: previousParams!,
                  textureDirty: true,
                }),
              execute: () =>
                canvasStore.updateEntity(entity.id, {
                  shaderParams: newParams,
                  textureDirty: true,
                }),
              description: `Update params for ${entity.id}`,
            }),
          );
        }
      }
      if (!skipUndo) undo.commitTransaction(`Update ${entities.length} entities`);
    }

    // Show a hint to share the URL at ~100 changes mark (single selection only)
    if (
      entities.length === 1 &&
      !hintShownRef.current &&
      updatesCount.current < 130 &&
      updatesCount.current > 100
    ) {
      hintShownRef.current = true;
      window.setTimeout(() => {
        hints.show({
          id: "share-and-paste",
          title: "Hint:",
          description: "Share this URL and paste it on an image to set its parameters",
          action: {
            label: "Copy Link",
            onPress: () => {
              navigator.clipboard.writeText(window.location.href).catch((e) => logger.error(e));
            },
          },
        });
      }, 2000);
    }
  };

  // Set render state from pasted URL - applies to selected entities directly
  const setRenderStateFromURL = (params: URLSearchParams) => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    // Parse all params from URL
    const parsedParams = Object.fromEntries(params);

    // Build shader params from URL
    const shaderType =
      shaderUrlParams.shader.parse(parsedParams.shader ?? "") ?? config.defaults.shader;
    const palette = parsePaletteFromUrl(shaderUrlParams.preset.parse(parsedParams.preset ?? ""));

    // Parse post-process params
    const ppDefaults = config.defaults.shaderParams.postProcess!;
    const postProcess: PostProcessParams = {
      enabled: shaderUrlParams.ppEnabled.parse(parsedParams.ppEnabled ?? "") ?? ppDefaults.enabled,
      grain: {
        enabled:
          shaderUrlParams.ppGrainEnabled.parse(parsedParams.ppGrainEnabled ?? "") ??
          ppDefaults.grain.enabled,
        size:
          shaderUrlParams.ppGrainSize.parse(parsedParams.ppGrainSize ?? "") ??
          ppDefaults.grain.size,
        intensity:
          shaderUrlParams.ppGrainIntensity.parse(parsedParams.ppGrainIntensity ?? "") ??
          ppDefaults.grain.intensity,
      },
      bloom: {
        enabled:
          shaderUrlParams.ppBloomEnabled.parse(parsedParams.ppBloomEnabled ?? "") ??
          ppDefaults.bloom.enabled,
        threshold:
          shaderUrlParams.ppBloomThreshold.parse(parsedParams.ppBloomThreshold ?? "") ??
          ppDefaults.bloom.threshold,
        intensity:
          shaderUrlParams.ppBloomIntensity.parse(parsedParams.ppBloomIntensity ?? "") ??
          ppDefaults.bloom.intensity,
        filterRadius:
          shaderUrlParams.ppBloomFilterRadius.parse(parsedParams.ppBloomFilterRadius ?? "") ??
          ppDefaults.bloom.filterRadius,
        softness:
          shaderUrlParams.ppBloomSoftness.parse(parsedParams.ppBloomSoftness ?? "") ??
          ppDefaults.bloom.softness,
      },
      chromaticAberration: {
        enabled:
          shaderUrlParams.ppChromaticEnabled.parse(parsedParams.ppChromaticEnabled ?? "") ??
          ppDefaults.chromaticAberration.enabled,
        offset:
          shaderUrlParams.ppChromaticOffset.parse(parsedParams.ppChromaticOffset ?? "") ??
          ppDefaults.chromaticAberration.offset,
      },
    };

    const shaderParams: ShaderParams = {
      size:
        shaderUrlParams.size.parse(parsedParams.size ?? "") ?? config.defaults.shaderParams.size,
      shape:
        shaderUrlParams.shape.parse(parsedParams.shape ?? "") ?? config.defaults.shaderParams.shape,
      preserveColors:
        shaderUrlParams.preserveColors.parse(parsedParams.preserveColors ?? "") ??
        config.defaults.shaderParams.preserveColors,
      reversePalette:
        shaderUrlParams.reversePalette.parse(parsedParams.reversePalette ?? "") ??
        config.defaults.shaderParams.reversePalette,
      showOriginal:
        shaderUrlParams.showOriginal.parse(parsedParams.showOriginal ?? "") ??
        config.defaults.shaderParams.showOriginal,
      background: config.defaults.shaderParams.background,
      color: config.defaults.shaderParams.color,
      scale:
        shaderUrlParams.scale.parse(parsedParams.scale ?? "") ?? config.defaults.shaderParams.scale,
      intensity:
        shaderUrlParams.intensity.parse(parsedParams.intensity ?? "") ??
        config.defaults.shaderParams.intensity,
      blobs: {
        eagerness:
          shaderUrlParams.eagerness.parse(parsedParams.eagerness ?? "") ??
          config.defaults.shaderParams.blobs.eagerness,
      },
      dithering: {
        kind:
          shaderUrlParams.ditheringKind.parse(parsedParams.ditheringKind ?? "") ??
          config.defaults.shaderParams.dithering.kind,
      },
      ascii: {
        kind:
          shaderUrlParams.asciiKind.parse(parsedParams.asciiKind ?? "") ??
          config.defaults.shaderParams.ascii.kind,
        invert:
          shaderUrlParams.asciiInvert.parse(parsedParams.asciiInvert ?? "") ??
          config.defaults.shaderParams.ascii.invert,
      },
      glass: {
        kind:
          shaderUrlParams.glassKind.parse(parsedParams.glassKind ?? "") ??
          config.defaults.shaderParams.glass.kind,
        angle:
          shaderUrlParams.angle.parse(parsedParams.angle ?? "") ??
          config.defaults.shaderParams.glass.angle,
        caustic:
          shaderUrlParams.caustic.parse(parsedParams.caustic ?? "") ??
          config.defaults.shaderParams.glass.caustic,
        frostiness:
          shaderUrlParams.frostiness.parse(parsedParams.frostiness ?? "") ??
          config.defaults.shaderParams.glass.frostiness,
        highlight:
          shaderUrlParams.highlight.parse(parsedParams.highlight ?? "") ??
          config.defaults.shaderParams.glass.highlight,
        dispersion:
          shaderUrlParams.dispersion.parse(parsedParams.dispersion ?? "") ??
          config.defaults.shaderParams.glass.dispersion,
        flow:
          shaderUrlParams.flow.parse(parsedParams.flow ?? "") ??
          config.defaults.shaderParams.glass.flow,
      },
      palette: palette ?? config.defaults.shaderParams.palette,
      postProcess,
    };

    // Apply to all selected entities
    if (entities.length === 1) {
      const entity = entities[0]!;
      const previousShaderType = entity.shaderType;
      const previousParams = structuredClone(entity.shaderParams);

      canvasStore.updateEntity(entity.id, {
        shaderType,
        shaderParams,
        textureDirty: true,
      });

      // Sync to URL for sharing
      syncEntityToUrl({ ...entity, shaderType, shaderParams });

      undo.add(
        Command.create({
          undo: () => {
            canvasStore.updateEntity(entity.id, {
              shaderType: previousShaderType,
              shaderParams: previousParams,
              textureDirty: true,
            });
            syncEntityToUrl({
              ...entity,
              shaderType: previousShaderType,
              shaderParams: previousParams,
            });
          },
          execute: () => {
            canvasStore.updateEntity(entity.id, {
              shaderType,
              shaderParams,
              textureDirty: true,
            });
            syncEntityToUrl({ ...entity, shaderType, shaderParams });
          },
          description: "Paste URL params",
        }),
      );
    } else {
      // Multi-select: update all with transaction
      undo.beginTransaction();
      for (const entity of entities) {
        const previousShaderType = entity.shaderType;
        const previousParams = structuredClone(entity.shaderParams);

        canvasStore.updateEntity(entity.id, {
          shaderType,
          shaderParams,
          textureDirty: true,
        });

        undo.add(
          Command.create({
            undo: () =>
              canvasStore.updateEntity(entity.id, {
                shaderType: previousShaderType,
                shaderParams: previousParams,
                textureDirty: true,
              }),
            execute: () =>
              canvasStore.updateEntity(entity.id, {
                shaderType,
                shaderParams,
                textureDirty: true,
              }),
            description: `Paste params to ${entity.id}`,
          }),
        );
      }
      undo.commitTransaction(`Paste params to ${entities.length} entities`);
    }
  };

  // Renderer registration
  const registerRenderer = (renderer: InfiniteCanvasRenderer) => {
    rendererRef.current = renderer;
    setRendererState(renderer);
    setColorSpace(renderer.colorConfig.supportsP3 ? ColorSpace.displayP3 : ColorSpace.srgb);
    gameLoop.setRenderer(renderer);
  };

  // Export functions
  // Copy to clipboard: single-selection only (clipboard API limitation)
  const copySelectedEntityToClipboard = async (): Promise<boolean> => {
    const selectedEntities = canvasStore.getSelectedEntities();
    const renderer = rendererRef.current;
    // Only works for single selection
    if (selectedEntities.length !== 1 || !renderer) return false;

    const entity = selectedEntities[0]!;

    try {
      // Safari-compatible: create ClipboardItem synchronously with async blob promise
      const clipboardItem = new ClipboardItem({
        "image/png": renderer.renderEntityToBlob(entity).then((blob) => {
          if (!blob) throw new Error("Failed to render entity");
          return blob;
        }),
      });
      await navigator.clipboard.write([clipboardItem]);
      toastManager.add({ title: "Image copied to clipboard" });
      return true;
    } catch (err) {
      logger.error("Failed to copy to clipboard:", err);
      return false;
    }
  };

  // Save to file: supports multi-selection and format options (PNG default, JPEG for compression)
  const saveSelectedEntityToFile = async (options?: ImageExportOptions): Promise<void> => {
    const selectedEntities = canvasStore.getSelectedEntities();
    const renderer = rendererRef.current;
    if (selectedEntities.length === 0 || !renderer) return;

    const extension = options ? getImageExtension(options.format) : "png";

    // Save all selected entities
    for (const entity of selectedEntities) {
      try {
        const blob = await renderer.renderEntityToBlob(entity, options);
        if (!blob) continue;

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const hash = Date.now().toString(32);
        const name = entity.name.includes(".") // probably a file with a name already
          ? `${hash}-${entity.name.substring(0, entity.name.lastIndexOf("."))}`
          : `${hash}-${entity.name.replaceAll(" ", "-")}`;
        link.download = `${name}.${extension}`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        logger.error("Failed to save entity:", err);
      }
    }
  };

  // Serialization API — lazy-loads the serialization module
  const serializeCanvas = async (): Promise<Blob> => {
    const { serialize } = await import("#lib/serialization/index.ts");
    return serialize();
  };

  const deserializeCanvas = async (source: Blob | ArrayBuffer): Promise<DeserializeResult> => {
    const { deserialize, getMaxCounters } = await import("#lib/serialization/index.ts");
    const result = await deserialize(source);

    // Update ID counters to avoid collisions with future entities
    const { maxId, maxZIndex } = getMaxCounters(result);
    nextIdRef.current = maxId + 1;
    nextZIndexRef.current = maxZIndex + 1;
    nextImageNumberRef.current = result.entityCount + 1;

    return result;
  };

  // Convert Map to Array for React components
  const entities = Array.from(state.entities.values());

  const value: CanvasContextValue = {
    contextOpenEntityId: state.contextOpenEntityId,
    setViewport,
    panBy,
    resetViewport,
    entities,
    selectedEntityIds: state.selectedEntityIds,
    multiSelectMode: state.multiSelectMode,
    hoveredEntityId: state.hoveredEntityId,
    addEntity,
    updateEntity,
    removeEntity,
    selectEntity,
    moveEntity,
    bringToFront,
    sendToBack,
    duplicateEntities,
    selectedShaderType,
    selectedEntityParams,
    updateSelectedShaderType,
    updateSelectedEntityParams,
    registerRenderer,
    renderer: rendererState,
    colorSpace,
    copySelectedEntityToClipboard,
    saveSelectedEntityToFile,
    serializeCanvas,
    deserializeCanvas,
    getContextOpenEntity,
    setRenderState,
    setRenderStateFromURL,
    setDebugType,
  };

  // Expose canvas context to window for dev console debugging
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (import.meta.env.PROD) return;
    if (typeof window !== "undefined") {
      const ctx = valueRef;
      (window as any).__CANVAS__ = {};
      (window as any).__CANVAS__.store = canvasStore;
      (window as any).__CANVAS__.config = config;
      Object.defineProperty((window as any).__CANVAS__, "context", {
        get: () => ctx.current,
        configurable: true,
      });

      // Serialization API — delegates to context methods via ref for fresh access
      (window as any).__CANVAS__.serialize = async () => {
        const blob = await ctx.current.serializeCanvas();
        const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
        const entityCount = canvasStore.getState().entities.size;
        console.log(`[Canvas] Serialized ${entityCount} entities → ${sizeMB} MB`);
        return blob;
      };

      (window as any).__CANVAS__.deserialize = async (source: Blob | ArrayBuffer) => {
        const result = await ctx.current.deserializeCanvas(source);

        if (result.warnings.length > 0) {
          console.warn("[Canvas] Deserialize warnings:", result.warnings);
        }
        if (result.errors.length > 0) {
          console.error("[Canvas] Deserialize errors:", result.errors);
        }
        console.log(
          `[Canvas] Deserialized ${result.entityCount} entities | success: ${result.success}`,
        );
        return result;
      };

      (window as any).__CANVAS__.save = async (filename = "canvas.vdmsh") => {
        const blob = await ctx.current.serializeCanvas();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        console.log(`[Canvas] Saved as ${filename}`);
      };

      (window as any).__CANVAS__.load = async () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".studio,.zip,.vdmsh";
        return new Promise<void>((resolve) => {
          input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) {
              resolve();
              return;
            }
            await ctx.current.deserializeCanvas(file);
            resolve();
          };
          input.click();
        });
      };
    }
    return () => {
      if (typeof window !== "undefined" && !import.meta.env.PROD) {
        delete (window as any)?.__CANVAS__;
      }
    };
  }, []);

  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}
