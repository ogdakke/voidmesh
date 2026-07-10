import { config } from "#config";
import type { ActionLayerRenderState, DragVisualRenderState } from "#engine";
import { boundsIntersect, getRotatedAABB, getViewportWorldBounds } from "#lib/canvas-math.ts";
import type { Bounds, ShaderCanvasEntity, Viewport } from "#types/canvas.ts";
import type {
  CompositionDrawItem,
  CompositionPass,
  PrepareCompositionItemOptions,
} from "./composition-pass.ts";
import type { EntityTexturePipeline } from "./entity-texture-pipeline.ts";
import { getEntityRenderSize } from "./entity-render-size.ts";

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
}

export class EntityDrawItemPreparer {
  readonly #texturePipeline: EntityTexturePipeline;
  readonly #compositionPass: CompositionPass;
  readonly #desiredRenderSize = { width: 0, height: 0 };
  readonly #resolvedRenderSize = { width: 0, height: 0 };
  readonly #viewportBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly #entityBounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly #entityDrawItems: CompositionDrawItem[] = [];
  readonly #actionLayerDrawItems: CompositionDrawItem[] = [];
  readonly #prepared: PreparedEntityDrawItems = {
    entityDrawItems: this.#entityDrawItems,
    actionLayerDrawItems: this.#actionLayerDrawItems,
    hasAnimatingContent: false,
  };
  #compositionOptions: PrepareCompositionItemOptions | null = null;

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

    const entityDrawItems = this.#entityDrawItems;
    const actionLayerDrawItems = this.#actionLayerDrawItems;
    entityDrawItems.length = 0;
    actionLayerDrawItems.length = 0;
    let hasAnimatingContent = false;

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
      this.#viewportBounds,
    );

    for (const entity of entities) {
      // Viewport culling: skip all GPU work for entities entirely outside the viewport.
      // textureDirty is intentionally NOT cleared here — it stays true so the entity
      // re-renders correctly when it scrolls back into view.
      const entityAABB = getRotatedAABB(
        entity.position,
        entity.size,
        entity.rotation,
        this.#entityBounds,
      );
      if (!boundsIntersect(entityAABB, viewportBounds)) {
        continue;
      }

      // Check if texture needs regeneration. Animated media is marked dirty by the
      // game loop only when the decoded frame changes.
      const textureWasDirty = !!entity.textureDirty;
      if (textureWasDirty || this.#texturePipeline.needsContinuousRenderForEntity(entity)) {
        hasAnimatingContent = true;
      }

      const desiredRenderSize = getEntityRenderSize(
        entity,
        viewport,
        devicePixelRatio,
        this.#desiredRenderSize,
      );
      const renderSize = this.#texturePipeline.resolveRenderSize(
        entity,
        desiredRenderSize,
        this.#resolvedRenderSize,
      );
      if (!renderSize) continue;
      const compositionSource = this.#texturePipeline.renderEntityToTexture(
        entity,
        encoder,
        renderSize,
      );
      if (!compositionSource) continue;

      // Clear dirty flag
      entity.textureDirty = false;

      // Determine if this entity is hovered or selected
      const isHovered = entity.id === hoveredEntityId;
      const isSelected = selectedEntityIds.has(entity.id);

      // Action layer entities are drawn AFTER blur (not in main pass) to avoid halo
      const isActionLayerEntity = actionLayerActive && actionLayer.entityIds.has(entity.id);
      const positionOffsetX = isActionLayerEntity ? actionLayerOffsetX : 0;
      const positionOffsetY = isActionLayerEntity ? actionLayerOffsetY : 0;
      const visualScale =
        dragVisual.active && dragVisual.entityIds.has(entity.id) ? dragVisual.scale : 1;
      let compositionOptions = this.#compositionOptions;
      if (!compositionOptions) {
        compositionOptions = {
          entity,
          source: compositionSource,
          isHovered,
          isSelected,
          debugMode,
          positionOffsetX,
          positionOffsetY,
          visualScale,
        };
        this.#compositionOptions = compositionOptions;
      } else {
        compositionOptions.entity = entity;
        compositionOptions.source = compositionSource;
        compositionOptions.isHovered = isHovered;
        compositionOptions.isSelected = isSelected;
        compositionOptions.debugMode = debugMode;
        compositionOptions.positionOffsetX = positionOffsetX;
        compositionOptions.positionOffsetY = positionOffsetY;
        compositionOptions.visualScale = visualScale;
      }
      const drawItem = this.#compositionPass.prepareDrawItem(compositionOptions);

      if (isActionLayerEntity) {
        actionLayerDrawItems.push(drawItem);
      } else {
        entityDrawItems.push(drawItem);
      }
    }

    this.#prepared.hasAnimatingContent = hasAnimatingContent;
    return this.#prepared;
  }
}
