import type { RenderState } from "./canvas-store.ts";
import { entityDragVisual } from "./entity-drag-visual.ts";
import { actionLayerController } from "./action-layer-controller.ts";

/**
 * Entity label positioning controller.
 * Manages the DOM overlay label for the selected entity.
 * Follows the same singleton pattern as ViewportAnimationController.
 *
 * Optimizations:
 * - Uses `transform` instead of `left`/`top` to avoid layout thrashing (compositor-only)
 * - Caches all values to skip DOM writes when nothing changed
 *   (during passive video playback this means zero DOM operations per frame)
 */
class EntityLabelController {
  #container: HTMLElement | null = null;
  #labelElement: HTMLDivElement | null = null;
  #textElement: HTMLSpanElement | null = null;

  // Cached values for dirty-checking — skip DOM writes when nothing changed
  #cachedLeft = NaN;
  #cachedTop = NaN;
  #cachedTextContent = "";
  #cachedWarning = false;
  #cachedOpacity = "";
  #cachedTitle = "";
  #cachedDragMode = false;

  // PWA safe-area handling
  #isInStandalonePWAMode = !!(navigator as any)?.standalone;
  #safeAreaInsetTop: number | undefined;

  /**
   * Set the container element (needed for DPR calculations).
   * Called once during initialization.
   */
  setContainer(container: HTMLElement): void {
    this.#container = container;
  }

  /**
   * Set the label DOM element to position.
   * Called once during initialization.
   */
  setLabelElement(element: HTMLDivElement): void {
    this.#labelElement = element;
  }

  /**
   * Set the text span element for content updates.
   * Called once during initialization.
   */
  setTextElement(element: HTMLSpanElement): void {
    this.#textElement = element;
  }

  /**
   * Update the label position and content.
   * Called by game loop each frame when needsRender is true.
   */
  tick(renderState: RenderState): void {
    if (!this.#container || !this.#labelElement || !this.#textElement) return;

    const { selectedEntityIds, entities, viewport } = renderState;
    const selectedId =
      selectedEntityIds.size === 1 ? selectedEntityIds.values().next().value : null;
    const entity = selectedId ? entities.find((e) => e.id === selectedId) : null;

    if (!entity) {
      if (this.#cachedOpacity !== "0") {
        this.#labelElement.style.opacity = "0";
        this.#cachedOpacity = "0";
      }
      // Clear drag mode when no entity is shown
      if (this.#cachedDragMode) {
        this.#labelElement.classList.remove("infinite-canvas__entity-label--dragging");
        this.#cachedDragMode = false;
      }
      return;
    }

    if (this.#cachedOpacity !== "1") {
      this.#labelElement.style.opacity = "1";
      this.#cachedOpacity = "1";
    }

    const dpr = window.devicePixelRatio || 1;
    let left =
      ((entity.position.x + entity.size.width / 2 - viewport.offset.x) * viewport.zoom) / dpr;

    const safeAreaInsetTop = this.#isInStandalonePWAMode ? (this.#getSafeAreaInsetTop() ?? 0) : 0;
    let top = ((entity.position.y - viewport.offset.y) * viewport.zoom) / dpr - safeAreaInsetTop;

    // Apply action layer rubber-band offset (CSS pixels)
    if (actionLayerController.isActive()) {
      const offset = actionLayerController.getEntityOffset();
      left += offset.x;
      top += offset.y;
    }

    // Use transform for GPU-composited positioning (no layout thrash).
    // Only write if position actually changed (number comparison).
    if (left !== this.#cachedLeft || top !== this.#cachedTop) {
      this.#labelElement.style.transform = `translate(calc(${left}px - 50%), calc(${top}px - 100% - 8px))`;
      this.#cachedLeft = left;
      this.#cachedTop = top;
    }

    // Dirty-check textContent on the text span (name never changes during playback)
    const isWarning = entity.shaderParams.showOriginal;
    const desiredText = isWarning ? "\u26A0 Original: " + entity.name : entity.name;

    if (this.#cachedTextContent !== desiredText) {
      this.#textElement.textContent = desiredText;
      this.#cachedTextContent = desiredText;
    }

    // Dirty-check warning class
    if (this.#cachedWarning !== isWarning) {
      if (isWarning) {
        this.#labelElement.classList.add("infinite-canvas__entity-label--warning");
      } else {
        this.#labelElement.classList.remove("infinite-canvas__entity-label--warning");
      }
      this.#cachedWarning = isWarning;
    }

    // Dirty-check title attribute
    if (this.#cachedTitle !== entity.name) {
      this.#labelElement.title = entity.name;
      this.#cachedTitle = entity.name;
    }

    // Dirty-check drag mode class
    const isDragMode = entityDragVisual.isDragPhase();
    if (this.#cachedDragMode !== isDragMode) {
      if (isDragMode) {
        this.#labelElement.classList.add("infinite-canvas__entity-label--dragging");
      } else {
        this.#labelElement.classList.remove("infinite-canvas__entity-label--dragging");
      }
      this.#cachedDragMode = isDragMode;
    }
  }

  #getSafeAreaInsetTop(): number | undefined {
    if (this.#safeAreaInsetTop && this.#safeAreaInsetTop > 0) return this.#safeAreaInsetTop;
    const top = +window
      .getComputedStyle(document.documentElement)
      .getPropertyValue("--safe-area-top")
      .slice(0, -2);
    if (this.#isInStandalonePWAMode && top <= 0) {
      // Standalone mode with 0 — keep recomputing. See https://stackoverflow.com/q/64891541
      return undefined;
    }
    this.#safeAreaInsetTop = top;
    return top;
  }
}

// Singleton instance
export const entityLabel = new EntityLabelController();
