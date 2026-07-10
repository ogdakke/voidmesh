import { config } from "#config";
import type { ActionLayerRenderState, DragVisualRenderState } from "#engine";
import { getViewportWorldBounds } from "#lib/canvas-math.ts";
import type { EntitySpatialIndex } from "#lib/entity-spatial-index.ts";
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

interface EntityLodTransition {
  currentTexture: GPUTexture;
  previousTexture: GPUTexture;
  transitionStart: number;
}

interface PrepareEntityDrawItemsOptions {
  entities: ShaderCanvasEntity[];
  entitySpatialIndex: EntitySpatialIndex;
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
  readonly #visibleEntities: ShaderCanvasEntity[] = [];
  readonly #entityDrawItems: CompositionDrawItem[] = [];
  readonly #actionLayerDrawItems: CompositionDrawItem[] = [];
  readonly #prepared: PreparedEntityDrawItems = {
    entityDrawItems: this.#entityDrawItems,
    actionLayerDrawItems: this.#actionLayerDrawItems,
    hasAnimatingContent: false,
  };
  #compositionOptions: PrepareCompositionItemOptions | null = null;
  readonly #lodTransitions = new WeakMap<ShaderCanvasEntity, EntityLodTransition>();
  #hasActiveLodTransitions = false;

  constructor(options: EntityDrawItemPreparerOptions) {
    this.#texturePipeline = options.texturePipeline;
    this.#compositionPass = options.compositionPass;
  }

  get hasActiveLodTransitions(): boolean {
    return this.#hasActiveLodTransitions;
  }

  prepare(options: PrepareEntityDrawItemsOptions): PreparedEntityDrawItems {
    const {
      entities,
      entitySpatialIndex,
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
    this.#hasActiveLodTransitions = false;
    const now = performance.now();

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

    const visibleEntities = entitySpatialIndex.queryBounds(
      viewportBounds,
      this.#visibleEntities,
      entities,
    );
    const allEntitiesSelected = entities.length > 0 && selectedEntityIds.size === entities.length;
    let previousSizedEntity: ShaderCanvasEntity | null = null;
    let previousDesiredWidth = 0;
    let previousDesiredHeight = 0;
    for (const entity of visibleEntities) {
      // Check if texture needs regeneration. Animated media is marked dirty by the
      // game loop only when the decoded frame changes.
      const textureWasDirty = !!entity.textureDirty;
      const needsContinuousRender = this.#texturePipeline.needsContinuousRenderForEntity(entity);
      if (textureWasDirty || needsContinuousRender) {
        hasAnimatingContent = true;
      }

      const sameProjectedSize =
        previousSizedEntity !== null &&
        previousSizedEntity.size.width === entity.size.width &&
        previousSizedEntity.size.height === entity.size.height &&
        previousSizedEntity.originalSize.width === entity.originalSize.width &&
        previousSizedEntity.originalSize.height === entity.originalSize.height;
      const desiredRenderSize = this.#desiredRenderSize;
      if (sameProjectedSize) {
        desiredRenderSize.width = previousDesiredWidth;
        desiredRenderSize.height = previousDesiredHeight;
      } else {
        getEntityRenderSize(entity, viewport, devicePixelRatio, desiredRenderSize);
        previousSizedEntity = entity;
        previousDesiredWidth = desiredRenderSize.width;
        previousDesiredHeight = desiredRenderSize.height;
      }
      let compositionSource = this.#texturePipeline.getReusableStaticCompositionSource(
        entity,
        desiredRenderSize,
        needsContinuousRender,
      );
      if (!compositionSource) {
        const renderSize = this.#texturePipeline.resolveRenderSize(
          entity,
          desiredRenderSize,
          this.#resolvedRenderSize,
        );
        if (!renderSize) continue;
        compositionSource = this.#texturePipeline.renderEntityToTexture(
          entity,
          encoder,
          renderSize,
        );
      }
      if (!compositionSource) continue;

      let previousTexture: GPUTexture | null = null;
      let lodBlend = 1;
      if (compositionSource.kind === "texture") {
        let lodTransition = this.#lodTransitions.get(entity);
        const preparedTexture = this.#compositionPass.getPreparedRegularTexture(entity);
        const priorTexture = lodTransition?.currentTexture ?? preparedTexture;
        if (priorTexture && priorTexture !== compositionSource.texture) {
          const dimensionsChanged =
            priorTexture.width !== compositionSource.texture.width ||
            priorTexture.height !== compositionSource.texture.height;
          if (dimensionsChanged) {
            lodTransition = {
              currentTexture: compositionSource.texture,
              previousTexture: priorTexture,
              transitionStart: now,
            };
            this.#lodTransitions.set(entity, lodTransition);
          } else {
            lodTransition = undefined;
            this.#lodTransitions.delete(entity);
          }
        }

        if (lodTransition) {
          const linearProgress = Math.min(
            1,
            (now - lodTransition.transitionStart) / config.rendering.lodCrossfadeDurationMs,
          );
          if (linearProgress < 1) {
            previousTexture = lodTransition.previousTexture;
            lodBlend = linearProgress * linearProgress * (3 - 2 * linearProgress);
            this.#texturePipeline.touchCompositionTexture(previousTexture);
            this.#hasActiveLodTransitions = true;
            hasAnimatingContent = true;
          } else {
            this.#lodTransitions.delete(entity);
          }
        }
      }

      // Clear dirty flag
      entity.textureDirty = false;

      // Determine if this entity is hovered or selected
      const isHovered = entity.id === hoveredEntityId;
      const isSelected = allEntitiesSelected || selectedEntityIds.has(entity.id);

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
          previousTexture,
          lodBlend,
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
        compositionOptions.previousTexture = previousTexture;
        compositionOptions.lodBlend = lodBlend;
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
