import { config } from "#config";
import type { ActionLayerRenderState, DragVisualRenderState } from "#engine";
import { boundsIntersect, getRotatedAABB, getViewportWorldBounds } from "#lib/canvas-math.ts";
import { MediaType, type ShaderCanvasEntity, type Viewport } from "#types/canvas.ts";
import type { CompositionDrawItem, CompositionPass } from "./composition-pass.ts";
import type { EntityTexturePipeline } from "./entity-texture-pipeline.ts";
import { getEntityRenderSize, shouldUseLiveVideo } from "./entity-render-size.ts";

interface EntityDrawItemPreparerOptions {
  texturePipeline: EntityTexturePipeline;
  compositionPass: CompositionPass;
}

interface PrepareEntityDrawItemsOptions {
  entities: ShaderCanvasEntity[];
  viewport: Viewport;
  width: number;
  height: number;
  devicePixelRatio: number;
  encoder: GPUCommandEncoder;
  hoveredEntityId: string | null;
  selectedEntityIds: ReadonlySet<string>;
  actionLayer: ActionLayerRenderState;
  dragVisual: DragVisualRenderState;
  debugMode: boolean;
}

export interface PreparedEntityDrawItems {
  entityDrawItems: CompositionDrawItem[];
  actionLayerDrawItems: CompositionDrawItem[];
  hasAnimatingContent: boolean;
  liveVideoEntityIds: Set<string>;
}

export class EntityDrawItemPreparer {
  readonly #texturePipeline: EntityTexturePipeline;
  readonly #compositionPass: CompositionPass;

  constructor(options: EntityDrawItemPreparerOptions) {
    this.#texturePipeline = options.texturePipeline;
    this.#compositionPass = options.compositionPass;
  }

  prepare(options: PrepareEntityDrawItemsOptions): PreparedEntityDrawItems {
    const {
      entities,
      viewport,
      width,
      height,
      devicePixelRatio,
      encoder,
      hoveredEntityId,
      selectedEntityIds,
      actionLayer,
      dragVisual,
      debugMode,
    } = options;

    entities.sort((a, b) => a.zIndex - b.zIndex);

    const entityDrawItems: CompositionDrawItem[] = [];
    const actionLayerDrawItems: CompositionDrawItem[] = [];
    let hasAnimatingContent = false;
    const liveVideoEntityIds = new Set<string>();

    let actionLayerOffsetX = 0;
    let actionLayerOffsetY = 0;
    const actionLayerActive = actionLayer.active;
    if (actionLayerActive) {
      const cssOffset = actionLayer.entityOffset;
      actionLayerOffsetX = (cssOffset.x * devicePixelRatio) / viewport.zoom;
      actionLayerOffsetY = (cssOffset.y * devicePixelRatio) / viewport.zoom;
    }

    const viewportBounds = getViewportWorldBounds(
      viewport,
      width,
      height,
      config.canvas.cullingBufferFraction,
    );

    for (const entity of entities) {
      // Viewport culling: skip all GPU work for entities entirely outside the viewport.
      // textureDirty is intentionally NOT cleared here — it stays true so the entity
      // re-renders correctly when it scrolls back into view.
      const entityAABB = getRotatedAABB(entity.position, entity.size, entity.rotation);
      if (!boundsIntersect(entityAABB, viewportBounds)) {
        continue;
      }

      // Check if texture needs regeneration. Animated media is marked dirty by the
      // game loop only when the decoded frame changes.
      const textureWasDirty = !!entity.textureDirty;
      if (textureWasDirty || this.#texturePipeline.needsContinuousRenderForEntity(entity)) {
        hasAnimatingContent = true;
      }

      const desiredRenderSize = getEntityRenderSize(entity, viewport, devicePixelRatio);
      const renderSize = this.#texturePipeline.resolveRenderSize(entity, desiredRenderSize);
      const useLiveVideo = shouldUseLiveVideo(entity, viewport, devicePixelRatio);
      if (entity.mediaSource.type === MediaType.video && useLiveVideo) {
        liveVideoEntityIds.add(entity.id);
      }
      const compositionSource = this.#texturePipeline.renderEntityToTexture(
        entity,
        encoder,
        renderSize,
        useLiveVideo,
      );
      if (!compositionSource) continue;

      // Clear dirty flag
      entity.textureDirty = false;

      // Determine if this entity is hovered or selected
      const isHovered = entity.id === hoveredEntityId;
      const isSelected = selectedEntityIds.has(entity.id);

      // Action layer entities are drawn AFTER blur (not in main pass) to avoid halo
      const isActionLayerEntity = actionLayerActive && actionLayer.entityIds.has(entity.id);
      const drawItem = this.#compositionPass.prepareDrawItem({
        entity,
        source: compositionSource,
        isHovered,
        isSelected,
        debugMode,
        positionOffsetX: isActionLayerEntity ? actionLayerOffsetX : 0,
        positionOffsetY: isActionLayerEntity ? actionLayerOffsetY : 0,
        visualScale:
          dragVisual.active && dragVisual.entityIds.has(entity.id) ? dragVisual.scale : 1,
      });

      if (isActionLayerEntity) {
        actionLayerDrawItems.push(drawItem);
      } else {
        entityDrawItems.push(drawItem);
      }
    }

    return { entityDrawItems, actionLayerDrawItems, hasAnimatingContent, liveVideoEntityIds };
  }
}
