import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CanvasCommandsContext,
  CanvasRendererContext,
  DebugType,
  type CanvasCommands,
  type CanvasRendererService,
} from "./use-canvas.ts";
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
  GlitchKind,
  MediaType,
  isGifEntity,
} from "#types/canvas.ts";
import {
  getPalettePreset,
  isAsyncPalette,
  isUserPalette,
  generatePaletteId,
  generatePaletteName,
  generatePaletteShortName,
} from "#components/palette-preset/palette-presets.ts";
import type { InfiniteCanvasRenderer } from "#renderer/canvas-renderer.ts";
import type { DeserializeOptions, DeserializeResult } from "#lib/serialization/types.ts";
import { type ImageExportOptions, getImageExtension } from "#renderer/export-formats.ts";
import { canvasStore, disintegrationController, gameLoop } from "#engine";

import { toastManager } from "#components/ui/toast/toast-manager.ts";
import { hints } from "#components/ui/hint/hint-manager.ts";
import { extractOriginalPalette, cloneMediaSource } from "#lib/media-loader.ts";
import { Command, undo } from "#lib/undo.ts";
import { config, glassKindResets, glitchKindResets } from "#config";
import { preferences } from "#lib/storage.ts";
import { paletteStore } from "#lib/palette-store.ts";
import { analytics } from "#lib/analytics.ts";
import { logger } from "#lib/client.logger.ts";
import { downloadBlob } from "#lib/download.ts";
import { deepMerge } from "#lib/deep-merge.ts";
import { applyShaderDefaults } from "#lib/shader-defaults.ts";
import { extractPaletteFromImage } from "#lib/palette-extraction/index.ts";
import { ColorSpace } from "#types/enums.ts";
import type { PartialDeep } from "type-fest";
import {
  createDefaultWlurOverlayDebugConfig,
  type WlurOverlayDebugConfig,
} from "#renderer/wlur-debug.ts";

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
  // Glitch shader params
  glitchKind: parseAsStringLiteral(Object.values(GlitchKind)).withDefault(
    config.defaults.shaderParams.glitch.kind,
  ),
  glitchAngle: parseAsFloat.withDefault(config.defaults.shaderParams.glitch.angle),
};

/**
 * Convert comma-separated hex colors to ColorPalette
 */
function parsePaletteFromUrl(presetId: string | null): ColorPalette | undefined {
  if (presetId) {
    const preset = getPalettePreset(presetId);
    if (preset) return preset;

    // Check custom/extracted palettes in paletteStore
    const customPalette = paletteStore.getPalettes().find((p) => p.id === presetId);
    if (customPalette) return customPalette;
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

export function CanvasProvider({ children }: { children: ReactNode }) {
  // Debug mode URL param
  const [debugType, setDebugType] = useQueryState(
    "debug",
    parseAsStringEnum(Object.values(DebugType)),
  );
  const debug = debugType !== null;
  const [wlurDebugConfig, setWlurDebugConfigState] = useState<WlurOverlayDebugConfig>(() =>
    createDefaultWlurOverlayDebugConfig(),
  );
  // URL params for selected entity shader settings (for shareable configurations)
  const [renderState, setRenderState] = useQueryStates(shaderUrlParams);
  const renderStateRef = useRef(renderState);
  renderStateRef.current = renderState;
  // NOTE: URL param keys were previously used for URL→entity sync
  // Now we update entities directly, so these are no longer needed

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
    const currentRenderState = renderStateRef.current;
    // Parse palette from URL params (now at root level)
    const palette = parsePaletteFromUrl(currentRenderState.preset);

    // Build post-process params
    const postProcess: PostProcessParams = {
      enabled: currentRenderState.ppEnabled,
      grain: {
        enabled: currentRenderState.ppGrainEnabled,
        size: currentRenderState.ppGrainSize,
        intensity: currentRenderState.ppGrainIntensity,
      },
      bloom: {
        enabled: currentRenderState.ppBloomEnabled,
        threshold: currentRenderState.ppBloomThreshold,
        intensity: currentRenderState.ppBloomIntensity,
        filterRadius: currentRenderState.ppBloomFilterRadius,
        softness: currentRenderState.ppBloomSoftness,
      },
      chromaticAberration: {
        enabled: currentRenderState.ppChromaticEnabled,
        offset: currentRenderState.ppChromaticOffset,
      },
    };

    return {
      size: currentRenderState.size,
      shape: currentRenderState.shape,
      preserveColors: currentRenderState.preserveColors,
      reversePalette: currentRenderState.reversePalette,
      showOriginal: currentRenderState.showOriginal,
      background: config.defaults.shaderParams.background,
      color: config.defaults.shaderParams.color,
      scale: currentRenderState.scale,
      intensity: currentRenderState.intensity,
      blobs: {
        eagerness: currentRenderState.eagerness,
      },
      dithering: {
        kind: currentRenderState.ditheringKind,
      },
      ascii: {
        kind: currentRenderState.asciiKind,
        invert: currentRenderState.asciiInvert,
      },
      glass: {
        kind: currentRenderState.glassKind,
        angle: currentRenderState.angle,
        caustic: currentRenderState.caustic,
        frostiness: currentRenderState.frostiness,
        highlight: currentRenderState.highlight,
        dispersion: currentRenderState.dispersion,
        flow: currentRenderState.flow,
      },
      glitch: {
        kind: currentRenderState.glitchKind,
        angle: currentRenderState.glitchAngle,
      },
      palette: palette ?? config.defaults.shaderParams.palette,
      postProcess,
    };
  };

  // NOTE: URL→entity sync effect REMOVED
  // The old effect had a race condition where `previousSelectedIdRef` was updated async
  // causing param changes to be skipped. Now we update entities directly in the handlers.

  const lastSyncedRenderStateRef = useRef<string>("");

  // Push entity params to URL on selection change OR entity param change
  // Clear URL state on multi-select - only sync when single entity selected
  useEffect(() => {
    const syncSelectionToUrl = () => {
      const selectedEntities = canvasStore.getSelectedEntities();

      if (selectedEntities.length !== 1) {
        if (selectedEntities.length > 1) {
          const clearedState = {
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
            glitchKind: null,
            glitchAngle: null,
          };
          const nextKey = JSON.stringify(clearedState);
          if (nextKey !== lastSyncedRenderStateRef.current) {
            lastSyncedRenderStateRef.current = nextKey;
            setRenderState(clearedState).catch((e) => logger.error(e));
          }
        }
        return;
      }

      const entity = selectedEntities[0]!;
      let paletteParams = paletteToUrlParams(entity.shaderParams.palette);
      const currentRenderState = renderStateRef.current;

      if (isAsyncPalette(currentRenderState.preset)) {
        const hasAsyncPalette = currentRenderState.preset === "original" && entity.originalPalette;
        const entityPaletteMatchesAsync =
          entity.shaderParams.palette?.id === currentRenderState.preset;

        if (hasAsyncPalette && entityPaletteMatchesAsync) {
          paletteParams = { preset: currentRenderState.preset, palette: null };
        }
      }

      const ppDefaults = config.defaults.shaderParams.postProcess!;
      const pp = entity.shaderParams.postProcess;
      const nextState = {
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
        glitchKind: entity.shaderParams.glitch?.kind ?? config.defaults.shaderParams.glitch.kind,
        glitchAngle: entity.shaderParams.glitch?.angle ?? config.defaults.shaderParams.glitch.angle,
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
        ppChromaticOffset:
          pp?.chromaticAberration?.offset ?? ppDefaults.chromaticAberration!.offset,
      };
      const nextKey = JSON.stringify(nextState);
      if (nextKey === lastSyncedRenderStateRef.current) return;
      lastSyncedRenderStateRef.current = nextKey;
      setRenderState(nextState).catch((e) => logger.error(e));
    };

    syncSelectionToUrl();
    return canvasStore.subscribe(syncSelectionToUrl);
  }, [setRenderState]);

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
  const colorSpaceRef = useRef<ColorSpace>(ColorSpace.srgb);
  colorSpaceRef.current = colorSpace;

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
    if (isAsyncPalette(renderStateRef.current.preset)) {
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
      shaderType: renderStateRef.current.shader as ShaderType,
      shaderParams,
      mediaSource: entity.mediaSource as any,
      textureDirty: true,
      edited: false,
    };

    canvasStore.addEntity(newEntity);
    analytics.track("entity.added", {
      media_type: newEntity.mediaSource.type as string,
    });

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
      const targetPreset = renderStateRef.current.preset;

      // Defer extraction to a macrotask so the synchronous OffscreenCanvas +
      // K-means work doesn't block the microtask queue and starve the
      // fit-to-view animation that starts right after entity addition.
      setTimeout(() => {
        extractOriginalPalette(entity.imageBitmap, colorSpaceRef.current)
          .then((palette) => {
            const currentEntity = canvasStore.getState().entities.get(id);
            if (!currentEntity) return; // Entity was deleted

            canvasStore.updateEntity(id, { originalPalette: palette });

            // If this entity should use original palette, apply it to shaderParams now
            if (targetPreset === "original") {
              canvasStore.updateEntity(id, {
                shaderParams: {
                  ...currentEntity.shaderParams,
                  palette,
                },
                textureDirty: true,
              });
            }
          })
          .catch((err) => logger.warn("Failed to extract palette:", err));
      }, 0);
    }

    return id;
  };

  const updateEntity = (id: string, updates: Partial<ShaderCanvasEntity>) => {
    const entity = canvasStore.getState().entities.get(id);
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
    const entity = canvasStore.getState().entities.get(id);
    if (!entity) return;

    // Clone the entity but keep the video element reference (we need it for restore)
    const entityCopy: ShaderCanvasEntity = {
      ...entity,
      position: { ...entity.position },
      size: { ...entity.size },
      shaderParams: structuredClone(entity.shaderParams),
      originalPalette: entity.originalPalette ? structuredClone(entity.originalPalette) : undefined,
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
    const entities = Array.from(canvasStore.getState().entities.values());
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

    analytics.track("entity.duplicated", { entity_count: selected.length });

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
        originalPalette: entity.originalPalette
          ? structuredClone(entity.originalPalette)
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

  const setSelectedEntityTimeAutoPlay = (playing: boolean) => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    for (const entity of entities) {
      const currentTime = playing
        ? (entity.shaderParams.time ?? 0)
        : (rendererRef.current?.getEntityTime(entity) ?? entity.shaderParams.time ?? 0);

      rendererRef.current?.setEntityTimeAutoPlay(entity, playing);

      canvasStore.updateEntity(entity.id, {
        shaderParams: {
          ...entity.shaderParams,
          time: currentTime,
          timeAutoPlay: playing,
        },
        textureDirty: true,
      });
    }
  };

  const syncSelectedEntityTimes = () => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    const sourceEntity =
      entities.find((entity) => entity.shaderParams.timeAutoPlay !== false) ?? entities[0];
    if (!sourceEntity) return;

    const sourceTime =
      rendererRef.current?.getEntityTime(sourceEntity) ?? sourceEntity.shaderParams.time ?? 0;

    for (const entity of entities) {
      rendererRef.current?.setEntityTimeAutoPlay(entity, false);

      canvasStore.updateEntity(entity.id, {
        shaderParams: {
          ...entity.shaderParams,
          time: sourceTime,
          timeAutoPlay: false,
        },
        textureDirty: true,
      });
    }
  };

  const changeShaderType = (value: string | null) => {
    if (!value) return;

    const targetShaderType = value as ShaderType;
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    if (entities.length === 1) {
      const entity = entities[0]!;
      updateEntity(entity.id, {
        shaderType: targetShaderType,
        shaderParams:
          entity.shaderType === targetShaderType
            ? entity.shaderParams
            : applyShaderDefaults(entity.shaderParams, entity.shaderType, targetShaderType),
        textureDirty: true,
      });
      return;
    }

    undo.beginTransaction();
    for (const entity of entities) {
      updateEntity(entity.id, {
        shaderType: targetShaderType,
        shaderParams:
          entity.shaderType === targetShaderType
            ? entity.shaderParams
            : applyShaderDefaults(entity.shaderParams, entity.shaderType, targetShaderType),
        textureDirty: true,
      });
    }
    undo.commitTransaction(`Update ${entities.length} entities`);
  };

  const changeDitheringKind = (value: string | null) => {
    if (!value) return;
    updateSelectedEntityParams({ dithering: { kind: value as DitheringKind } });
  };

  const changeAsciiKind = (value: string | null) => {
    if (!value) return;
    const selectedEntityParams = canvasStore.getSelectedEntity()?.shaderParams;
    updateSelectedEntityParams({
      ascii: {
        kind: value as AsciiKind,
        invert: selectedEntityParams?.ascii?.invert ?? false,
      },
    });
  };

  const setAsciiInvert = (value: boolean) => {
    const selectedEntityParams = canvasStore.getSelectedEntity()?.shaderParams;
    updateSelectedEntityParams({
      ascii: {
        kind: selectedEntityParams?.ascii?.kind ?? AsciiKind.standard,
        invert: value,
      },
    });
  };

  const changeGlassKind = (value: string | null) => {
    if (!value) return;
    const kind = value as GlassKind;
    updateSelectedEntityParams({
      ...glassKindResets[kind],
      glass: { kind },
    });
  };

  const changeGlitchKind = (value: string | null) => {
    if (!value) return;
    const kind = value as GlitchKind;
    updateSelectedEntityParams({
      ...glitchKindResets[kind],
      glitch: { kind },
    });
  };

  const setShowOriginal = (value: boolean) => {
    updateSelectedEntityParams({ showOriginal: value });
  };

  const toggleShowOriginal = () => {
    const result = canvasStore.getParamResult(
      "showOriginal",
      config.defaults.shaderParams.showOriginal,
    );
    const currentValue = result.isMixed ? false : !!result.value;
    setShowOriginal(!currentValue);
  };

  const setPreserveColors = (value: boolean) => {
    updateSelectedEntityParams({ preserveColors: value });
  };

  const togglePreserveColors = () => {
    const result = canvasStore.getParamResult(
      "preserveColors",
      config.defaults.shaderParams.preserveColors,
    );
    const currentValue = result.isMixed ? false : !!result.value;
    setPreserveColors(!currentValue);
  };

  const setReversePalette = (value: boolean) => {
    updateSelectedEntityParams({ reversePalette: value });
  };

  const toggleReversePalette = () => {
    const result = canvasStore.getParamResult(
      "reversePalette",
      config.defaults.shaderParams.reversePalette,
    );
    const currentValue = result.isMixed ? false : !!result.value;
    setReversePalette(!currentValue);
  };

  const changeSize = (value: number | number[]) => {
    const nextValue = Array.isArray(value) ? value[0] : value;
    if (nextValue !== undefined) {
      updateSelectedEntityParams({ size: nextValue });
    }
  };

  /**
   * Clone a non-preset palette for paste, giving it a unique ID in the palette store.
   * Returns the new palette, or null if the palette is a preset (shared by design).
   */
  const clonePaletteForPaste = (palette: ColorPalette | undefined): ColorPalette | null => {
    if (!palette?.id) return null;
    // Preset palettes are shared — no cloning needed
    if (getPalettePreset(palette.id)) return null;
    // User palettes (cstm_*, ext_*) and async palettes (original)
    // must be cloned with a new unique ID
    if (!isUserPalette(palette.id) && !isAsyncPalette(palette.id)) return null;

    const existing = paletteStore.getPalettes();
    const newPalette: ColorPalette = {
      id: generatePaletteId("custom"),
      name: generatePaletteName("custom", existing),
      shortName: generatePaletteShortName("custom", existing),
      colors: structuredClone(palette.colors),
    };
    paletteStore.addPalette(newPalette);
    return newPalette;
  };

  // Apply effects data directly to selected entities (from clipboard JSON)
  const applyEffectsToSelection = (data: {
    shaderType: ShaderType;
    shaderParams: ShaderParams;
    originalPalette?: ColorPalette;
  }) => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    const { shaderType, shaderParams } = data;

    if (entities.length === 1) {
      const entity = entities[0]!;
      const previousShaderType = entity.shaderType;
      const previousParams = structuredClone(entity.shaderParams);

      // Clone non-preset palette so target gets its own independent copy
      const clonedPalette = clonePaletteForPaste(shaderParams.palette);
      const pastedParams = clonedPalette
        ? { ...shaderParams, palette: clonedPalette }
        : shaderParams;

      const updates: Partial<ShaderCanvasEntity> = {
        shaderType,
        shaderParams: pastedParams,
        textureDirty: true,
      };

      canvasStore.updateEntity(entity.id, updates);

      undo.add(
        Command.create({
          undo: () => {
            if (clonedPalette) paletteStore.removePalette(clonedPalette.id!);
            canvasStore.updateEntity(entity.id, {
              shaderType: previousShaderType,
              shaderParams: previousParams,
              textureDirty: true,
            });
          },
          execute: () => {
            if (clonedPalette) paletteStore.addPalette(clonedPalette);
            canvasStore.updateEntity(entity.id, updates);
          },
          description: "Paste effects",
        }),
      );
    } else {
      undo.beginTransaction();
      for (const entity of entities) {
        const previousShaderType = entity.shaderType;
        const previousParams = structuredClone(entity.shaderParams);

        // Each entity gets its own cloned palette to stay independent
        const clonedPalette = clonePaletteForPaste(shaderParams.palette);
        const pastedParams = clonedPalette
          ? { ...shaderParams, palette: clonedPalette }
          : shaderParams;

        const updates: Partial<ShaderCanvasEntity> = {
          shaderType,
          shaderParams: pastedParams,
          textureDirty: true,
        };

        canvasStore.updateEntity(entity.id, updates);

        undo.add(
          Command.create({
            undo: () => {
              if (clonedPalette) paletteStore.removePalette(clonedPalette.id!);
              canvasStore.updateEntity(entity.id, {
                shaderType: previousShaderType,
                shaderParams: previousParams,
                textureDirty: true,
              });
            },
            execute: () => {
              if (clonedPalette) paletteStore.addPalette(clonedPalette);
              canvasStore.updateEntity(entity.id, updates);
            },
            description: `Paste effects to ${entity.id}`,
          }),
        );
      }
      undo.commitTransaction(`Paste effects to ${entities.length} entities`);
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
      glitch: {
        kind:
          shaderUrlParams.glitchKind.parse(parsedParams.glitchKind ?? "") ??
          config.defaults.shaderParams.glitch.kind,
        angle:
          shaderUrlParams.glitchAngle.parse(parsedParams.glitchAngle ?? "") ??
          config.defaults.shaderParams.glitch.angle,
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

  const changePalette = (palette: ColorPalette) => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    if (palette.id && isUserPalette(palette.id)) {
      const oldPalette = paletteStore.getPalettes().find((current) => current.id === palette.id);
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

    updateSelectedEntityParams({ palette });
  };

  const uploadPalette = async (files: FileList | File | null) => {
    let file: File | null;
    if (files instanceof File) {
      file = files;
    } else if (files?.[0]) {
      file = files[0];
    } else {
      return;
    }

    try {
      const palette = await extractPaletteFromImage(file, {
        colorCount: 16,
        colorSpace: colorSpaceRef.current,
      });
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

  const deletePalette = (paletteId: string) => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    const oldPalette = paletteStore.getPalettes().find((palette) => palette.id === paletteId);
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

  const deleteSelection = (
    e?: KeyboardEvent,
    source: "keyboard" | "context_menu" | "drop_zone" = "keyboard",
  ) => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    analytics.track("entity.deleted", { method: source, entity_count: entities.length });
    e?.preventDefault();
    disintegrationController.resetStagger();

    if (entities.length === 1) {
      removeEntity(entities[0]!.id);
      return;
    }

    undo.beginTransaction();
    for (const entity of entities) {
      removeEntity(entity.id);
    }
    undo.commitTransaction(`Delete ${entities.length} entities`);
  };

  const copySelectionImage = async (e?: KeyboardEvent) => {
    const entities = canvasStore.getSelectedEntities();
    const renderer = rendererRef.current;
    if (entities.length !== 1 || !renderer) return;

    const entity = entities[0]!;
    e?.preventDefault();

    try {
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

  const copySelectionEffects = () => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    const entity = entities[0]!;
    const data = {
      __voidmesh: true as const,
      version: 1,
      shaderType: entity.shaderType,
      shaderParams: structuredClone(entity.shaderParams),
      originalPalette: entity.originalPalette ? structuredClone(entity.originalPalette) : undefined,
    };

    navigator.clipboard
      .writeText(JSON.stringify(data))
      .then(() => {
        toastManager.add({
          title: "Effects copied to clipboard",
          description: "Now you can paste them on other files",
        });
      })
      .catch((e) => {
        logger.error(e);
        toastManager.add({
          title: "Failed to copy effects",
          type: "destructive",
        });
      });
  };

  const pasteEffects = async () => {
    const text = await navigator.clipboard.readText();

    try {
      const parsed = JSON.parse(text);
      if (parsed?.__voidmesh === true) {
        applyEffectsToSelection(parsed);
        const entityCount = canvasStore.getSelectedEntities().length;
        if (entityCount > 1) {
          toastManager.add({ title: `Applied effects to ${entityCount} entities` });
        }
        return;
      }
    } catch {
      // Not JSON, continue to URL fallback.
    }

    if (URL.canParse(text)) {
      const url = new URL(text);
      setRenderStateFromURL(url.searchParams);
      const entityCount = canvasStore.getSelectedEntities().length;
      if (entityCount > 1) {
        toastManager.add({ title: `Applied params to ${entityCount} entities` });
      }
      return;
    }

    toastManager.add({
      title: "No effects or URL found in clipboard",
      type: "destructive",
    });
  };

  const resetSelectionToDefaults = () => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    const defaultParams = structuredClone(config.defaults.shaderParams);
    const defaultShaderType = config.defaults.shader;

    if (entities.length === 1) {
      const entity = entities[0]!;
      updateEntity(entity.id, {
        shaderType: defaultShaderType,
        shaderParams: defaultParams,
        textureDirty: true,
      });
      return;
    }

    undo.beginTransaction();
    for (const entity of entities) {
      updateEntity(entity.id, {
        shaderType: defaultShaderType,
        shaderParams: structuredClone(config.defaults.shaderParams),
        textureDirty: true,
      });
    }
    undo.commitTransaction(`Reset ${entities.length} entities to defaults`);
  };

  const bringSelectionToFront = () => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    const sorted = [...entities].sort((a, b) => a.zIndex - b.zIndex);
    for (const entity of sorted) {
      bringToFront(entity.id);
    }
  };

  const sendSelectionToBack = () => {
    const entities = canvasStore.getSelectedEntities();
    if (entities.length === 0) return;

    const sorted = [...entities].sort((a, b) => b.zIndex - a.zIndex);
    for (const entity of sorted) {
      sendToBack(entity.id);
    }
  };

  const setSnapToGridPreference = (enabled: boolean) => {
    canvasStore.setSnapToGrid(enabled);
    preferences.setSnapToGrid(enabled);
  };

  const setFancyDeletePreference = (enabled: boolean) => {
    canvasStore.setFancyDelete(enabled);
    preferences.setFancyDelete(enabled);
  };

  const setHapticsPreference = (enabled: boolean) => {
    canvasStore.setHaptics(enabled);
    preferences.setHaptics(enabled);
  };

  // Renderer registration
  const registerRenderer = (renderer: InfiniteCanvasRenderer) => {
    rendererRef.current = renderer;
    setRendererState(renderer);
    setColorSpace(renderer.colorConfig.supportsP3 ? ColorSpace.displayP3 : ColorSpace.srgb);
    gameLoop.setRenderer(renderer);
  };

  const setWlurDebugConfig = useCallback((updates: Partial<WlurOverlayDebugConfig>) => {
    setWlurDebugConfigState((prev) => ({ ...prev, ...updates }));
  }, []);

  const resetWlurDebugConfig = useCallback(() => {
    setWlurDebugConfigState(createDefaultWlurOverlayDebugConfig());
  }, []);

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

        const hash = Date.now().toString(32);
        const name = entity.name.includes(".") // probably a file with a name already
          ? `${hash}-${entity.name.substring(0, entity.name.lastIndexOf("."))}`
          : `${hash}-${entity.name.replaceAll(" ", "-")}`;
        downloadBlob(blob, `${name}.${extension}`);
      } catch (err) {
        logger.error("Failed to save entity:", err);
      }
    }
  };

  // Serialization API — lazy-loads the serialization module
  const serializeCanvas = async (): Promise<Blob | null> => {
    const { serialize } = await import("#lib/serialization/index.ts");
    return serialize();
  };

  const deserializeCanvas = async (
    source: Blob | ArrayBuffer,
    options?: DeserializeOptions,
  ): Promise<DeserializeResult> => {
    const { deserialize, getMaxCounters } = await import("#lib/serialization/index.ts");
    const result = await deserialize(source, options);

    // Update ID counters to avoid collisions with future entities
    const { maxId, maxZIndex } = getMaxCounters(result);
    nextIdRef.current = maxId + 1;
    nextZIndexRef.current = maxZIndex + 1;
    nextImageNumberRef.current = result.entityCount + 1;

    // Re-extract original palettes for entities that don't have them (legacy v3 files)
    for (const entity of canvasStore.getState().entities.values()) {
      if (entity.originalPalette) continue;
      extractOriginalPalette(entity.imageBitmap, colorSpaceRef.current)
        .then((palette) => {
          const current = canvasStore.getState().entities.get(entity.id);
          if (!current) return;
          canvasStore.updateEntity(entity.id, { originalPalette: palette });
        })
        .catch((err) => logger.warn("Failed to extract palette on deserialize:", err));
    }

    return result;
  };

  const commandsRef = useRef<CanvasCommands | null>(null);
  if (!commandsRef.current) {
    commandsRef.current = {
      setViewport,
      panBy,
      resetViewport,
      addEntity,
      updateEntity,
      removeEntity,
      selectEntity,
      moveEntity,
      bringToFront,
      sendToBack,
      duplicateEntities,
      updateSelectedEntityParams,
      setSelectedEntityTimeAutoPlay,
      syncSelectedEntityTimes,
      changeShaderType,
      changeDitheringKind,
      changeAsciiKind,
      setAsciiInvert,
      changeGlassKind,
      changeGlitchKind,
      changePalette,
      uploadPalette,
      deletePalette,
      setShowOriginal,
      toggleShowOriginal,
      setPreserveColors,
      togglePreserveColors,
      setReversePalette,
      toggleReversePalette,
      deleteSelection,
      copySelectionImage,
      copySelectionEffects,
      pasteEffects,
      bringSelectionToFront,
      sendSelectionToBack,
      resetSelectionToDefaults,
      setSnapToGrid: setSnapToGridPreference,
      setFancyDelete: setFancyDeletePreference,
      setHaptics: setHapticsPreference,
      changeSize,
      copySelectedEntityToClipboard,
      saveSelectedEntityToFile,
      serializeCanvas,
      deserializeCanvas,
      applyUrlState: setRenderStateFromURL,
      applyEffectsToSelection,
      setDebugType,
    };
  }
  const commands = commandsRef.current;

  const rendererService = useMemo<CanvasRendererService>(
    () => ({
      registerRenderer,
      renderer: rendererState,
      colorSpace,
      debugMode: debug,
      wlurDebugConfig,
      setWlurDebugConfig,
      resetWlurDebugConfig,
    }),
    [rendererState, colorSpace, debug, wlurDebugConfig, setWlurDebugConfig, resetWlurDebugConfig],
  );

  // Expose canvas context to window for dev console debugging
  const valueRef = useRef(commands);
  valueRef.current = commands;
  useEffect(() => {
    if (import.meta.env.PROD) return;
    if (typeof window !== "undefined") {
      const ctx = valueRef;
      (window as any).__CANVAS__ = {};
      (window as any).__CANVAS__.store = canvasStore;
      (window as any).__CANVAS__.config = config;
      Object.defineProperty((window as any).__CANVAS__, "commands", {
        get: () => ctx.current,
        configurable: true,
      });

      // Serialization API — delegates to context methods via ref for fresh access
      (window as any).__CANVAS__.serialize = async () => {
        const blob = await ctx.current.serializeCanvas();
        if (!blob) {
          console.log("[Canvas] Save already in progress, skipped");
          return null;
        }
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
        if (!blob) {
          console.log("[Canvas] Save already in progress, skipped");
          return;
        }
        downloadBlob(blob, filename);
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

  return (
    <CanvasCommandsContext.Provider value={commands}>
      <CanvasRendererContext.Provider value={rendererService}>
        {children}
      </CanvasRendererContext.Provider>
    </CanvasCommandsContext.Provider>
  );
}
