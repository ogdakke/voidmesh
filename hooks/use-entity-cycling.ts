/**
 * Entity cycling for ArrowUp/ArrowDown navigation
 *
 * Uses insertion order (Map iteration order), NOT zIndex.
 * Performant: cached entity order, no expensive operations during rapid key presses.
 */
import { type RefObject } from "react";
import { canvasStore, viewportAnimation } from "../engine/index.ts";
import { useIsMobile } from "./use-is-mobile.ts";
import { calculateFitToView, easings } from "../lib/canvas-math.ts";
import { config } from "../lib/config/index.ts";
import type { ShaderCanvasEntity } from "#types/canvas.ts";

// Cached entity order - invalidated when entities change
let cachedEntityOrder: string[] | null = null;
let cachedVersion: number = -1;

// Throttle flag - prevents cycling while animation is in progress
let isCycling = false;

/**
 * Get entities in insertion order for cycling.
 * Returns cached result if entities haven't changed.
 */
export function getEntityCycleOrder(): string[] {
  const state = canvasStore.getState();

  // Check if cache is valid
  if (cachedEntityOrder !== null && cachedVersion === state.version) {
    return cachedEntityOrder;
  }

  // Rebuild cache: Map iteration preserves insertion order
  cachedEntityOrder = [...state.entities.keys()];
  cachedVersion = state.version;

  return cachedEntityOrder;
}

/**
 * Clear the cached entity order and reset cycling state.
 * Exported for testing.
 */
export function clearEntityCycleCache(): void {
  cachedEntityOrder = null;
  cachedVersion = -1;
  isCycling = false;
}

/**
 * Check if currently cycling (for testing).
 */
export function isCyclingInProgress(): boolean {
  return isCycling;
}

/**
 * Get the reference entity ID for cycling in multi-select.
 * For "next": returns the entity that appears last in insertion order among selected.
 * For "previous": returns the entity that appears first in insertion order among selected.
 */
function getCycleReferenceEntity(
  selectedIds: ReadonlySet<string>,
  order: string[],
  direction: "next" | "previous",
): string | null {
  if (selectedIds.size === 0) return null;

  // For single selection, just return it
  if (selectedIds.size === 1) {
    return selectedIds.values().next().value ?? null;
  }

  // For multi-select, find first/last in insertion order
  if (direction === "next") {
    // Find the last selected entity in insertion order
    for (let i = order.length - 1; i >= 0; i--) {
      if (selectedIds.has(order[i]!)) {
        return order[i]!;
      }
    }
  } else {
    // Find the first selected entity in insertion order
    for (let i = 0; i < order.length; i++) {
      if (selectedIds.has(order[i]!)) {
        return order[i]!;
      }
    }
  }

  return null;
}

/**
 * Animate viewport to center on an entity.
 * Sets isCycling flag and resets it on completion.
 */
function animateToEntity(
  entity: ShaderCanvasEntity,
  containerRef?: RefObject<HTMLElement | null>,
  bottomInset: number = 0,
): void {
  // Try to get container from ref, or find it in DOM
  const container = containerRef?.current ?? document.querySelector(".infinite-canvas");
  if (!container) {
    // No container - complete immediately
    isCycling = false;
    return;
  }

  const targetViewport = calculateFitToView({
    entityPosition: entity.position,
    entitySize: entity.size,
    containerWidth: (container as HTMLElement).clientWidth,
    containerHeight: (container as HTMLElement).clientHeight,
    dpr: window.devicePixelRatio,
    padding: 0.15,
    minZoom: undefined,
    maxZoom: undefined,
    bottomInset,
  });

  viewportAnimation.animateTo(targetViewport, {
    duration: config.canvas.animation.fitToViewDuration,
    easing: easings[config.canvas.animation.easing],
    onComplete: () => {
      isCycling = false;
    },
  });
}

/**
 * Cycle to the next entity (ArrowDown).
 * If no selection, starts from first entity.
 * Wraps from last to first.
 *
 * @param containerRef - Reference to container element for viewport calculation
 * @param isRepeat - If true (key held), throttle by animation. If false (fresh press), interrupt.
 */
export function cycleToNextEntity(
  containerRef?: RefObject<HTMLElement | null>,
  isRepeat: boolean = false,
  bottomInset: number = 0,
): void {
  // Only throttle held keys (repeat), allow fresh presses to interrupt
  if (isRepeat && isCycling) return;

  const order = getEntityCycleOrder();
  if (order.length === 0) return;

  const state = canvasStore.getState();
  const selectedIds = state.selectedEntityIds;

  let nextIndex: number;

  if (selectedIds.size === 0) {
    // No selection - start from first
    nextIndex = 0;
  } else {
    // Find current position and move to next
    const referenceId = getCycleReferenceEntity(selectedIds, order, "next");
    const currentIndex = referenceId ? order.indexOf(referenceId) : -1;
    nextIndex = (currentIndex + 1) % order.length;
  }

  const nextId = order[nextIndex];
  if (!nextId) return;

  // Set cycling flag before animation
  isCycling = true;

  canvasStore.replaceSelection([nextId]);

  const entity = state.entities.get(nextId);
  if (entity) {
    animateToEntity(entity, containerRef, bottomInset);
  } else {
    // No entity to animate to - reset flag
    isCycling = false;
  }
}

/**
 * Cycle to the previous entity (ArrowUp).
 * If no selection, starts from last entity.
 * Wraps from first to last.
 *
 * @param containerRef - Reference to container element for viewport calculation
 * @param isRepeat - If true (key held), throttle by animation. If false (fresh press), interrupt.
 */
export function cycleToPreviousEntity(
  containerRef?: RefObject<HTMLElement | null>,
  isRepeat: boolean = false,
  bottomInset: number = 0,
): void {
  // Only throttle held keys (repeat), allow fresh presses to interrupt
  if (isRepeat && isCycling) return;

  const order = getEntityCycleOrder();
  if (order.length === 0) return;

  const state = canvasStore.getState();
  const selectedIds = state.selectedEntityIds;

  let prevIndex: number;

  if (selectedIds.size === 0) {
    // No selection - start from last
    prevIndex = order.length - 1;
  } else {
    // Find current position and move to previous
    const referenceId = getCycleReferenceEntity(selectedIds, order, "previous");
    const currentIndex = referenceId ? order.indexOf(referenceId) : 0;
    prevIndex = (currentIndex - 1 + order.length) % order.length;
  }

  const prevId = order[prevIndex];
  if (!prevId) return;

  // Set cycling flag before animation
  isCycling = true;

  canvasStore.replaceSelection([prevId]);

  const entity = state.entities.get(prevId);
  if (entity) {
    animateToEntity(entity, containerRef, bottomInset);
  } else {
    // No entity to animate to - reset flag
    isCycling = false;
  }
}

/**
 * Hook to create cycling handlers with container reference.
 * Returns memoized callbacks suitable for keybind registration.
 *
 * Uses e.repeat to differentiate held keys (throttled) from fresh presses (interrupt).
 */
export function useEntityCycling(containerRef: RefObject<HTMLElement | null>) {
  const isMobile = useIsMobile();
  const bottomInset = isMobile ? config.canvas.mobile.bottomInset : 0;

  const handleCycleNext = (e: KeyboardEvent) => {
    e.preventDefault();
    cycleToNextEntity(containerRef, e.repeat, bottomInset);
  };

  const handleCyclePrevious = (e: KeyboardEvent) => {
    e.preventDefault();
    cycleToPreviousEntity(containerRef, e.repeat, bottomInset);
  };

  return { handleCycleNext, handleCyclePrevious };
}
