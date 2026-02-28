import type { Point } from "#types/canvas.ts";
import { easings } from "../lib/canvas-math.ts";
import { canvasStore } from "./canvas-store.ts";

export interface DisintegrationOverlay {
  id: string;
  startTime: number;
  /** How long the dissolve front takes to sweep across (ms) */
  dissolveDuration: number;
  /** Total animation duration including particle tail (ms) */
  duration: number;
  seed: number;
  position: Point;
  size: { width: number; height: number };
  rotation: number;
}

const DISSOLVE_DURATION_MS = 2800;
/** How long each particle drifts after spawning (ms). Also determines the tail after dissolve completes. */
export const PARTICLE_LIFETIME_MS = 600;
const STAGGER_DELAY_MS = 200;

/**
 * Controls per-entity disintegration animations (timing + spatial data).
 * GPU resources (textures, buffers) are managed by the renderer.
 *
 * The entity is removed from the store immediately on deletion.
 * This controller drives the visual overlay that plays independently.
 */
class DisintegrationController {
  #overlays = new Map<string, DisintegrationOverlay>();
  #staggerIndex = 0;

  /** Register a new disintegration overlay. */
  addOverlay(
    id: string,
    position: Point,
    size: { width: number; height: number },
    rotation: number,
  ): void {
    const delay = this.#staggerIndex * STAGGER_DELAY_MS;
    this.#staggerIndex++;

    this.#overlays.set(id, {
      id,
      startTime: performance.now() + delay,
      dissolveDuration: DISSOLVE_DURATION_MS,
      duration: DISSOLVE_DURATION_MS + PARTICLE_LIFETIME_MS,
      seed: Math.random() * 1000,
      position: { x: position.x, y: position.y },
      size: { width: size.width, height: size.height },
      rotation,
    });

    canvasStore.setContainerDirty();
  }

  /** Reset stagger counter. Call before a batch of deletions. */
  resetStagger(): void {
    this.#staggerIndex = 0;
  }

  /**
   * Advance all animations. Returns completed overlay IDs (caller cleans up GPU resources).
   * Returns true if any animation is still active.
   */
  tick(now: number): boolean {
    if (this.#overlays.size === 0) return false;

    const completed: string[] = [];

    for (const [id, overlay] of this.#overlays) {
      if (now < overlay.startTime) continue;
      const elapsed = now - overlay.startTime;
      if (elapsed >= overlay.duration) {
        completed.push(id);
      }
    }

    for (const id of completed) {
      this.#overlays.delete(id);
    }

    return this.#overlays.size > 0;
  }

  /** Get eased progress for an overlay (0 = not started, 0→1 = animating). */
  getProgress(id: string): number {
    const overlay = this.#overlays.get(id);
    if (!overlay) return 0;

    const now = performance.now();
    if (now < overlay.startTime) return 0;

    const elapsed = now - overlay.startTime;
    const t = Math.min(elapsed / overlay.dissolveDuration, 1);
    return easings.easeOutExpo(t);
  }

  /** Get a specific overlay by ID. */
  getOverlay(id: string): DisintegrationOverlay | undefined {
    return this.#overlays.get(id);
  }

  /** Whether a specific overlay exists (including not-yet-started staggered ones). */
  hasOverlay(id: string): boolean {
    return this.#overlays.has(id);
  }

  /** Iterate active overlays (for rendering). */
  getOverlays(): IterableIterator<DisintegrationOverlay> {
    return this.#overlays.values();
  }

  /** Cancel a specific overlay (e.g., on undo). */
  cancelOverlay(id: string): void {
    this.#overlays.delete(id);
  }
}

/** Singleton instance */
export const disintegrationController = new DisintegrationController();
