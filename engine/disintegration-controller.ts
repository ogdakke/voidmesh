import type { Point } from "#types/canvas.ts";
import { easings } from "#lib/canvas-math.ts";
import {
  canvasStore,
  type DisintegrationRenderOverlay,
  type DisintegrationRenderState,
} from "./canvas-store.ts";
import {
  scheduler as defaultScheduler,
  type AnimationScheduler,
  type AnimationHandle,
} from "../lib/animation-scheduler.ts";

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
const STAGGER_DELAY_MS = 0;

/**
 * Controls per-entity disintegration animations (timing + spatial data).
 * GPU resources (textures, buffers) are managed by the renderer.
 *
 * The entity is removed from the store immediately on deletion.
 * This controller drives the visual overlay that plays independently.
 * Self-registers with AnimationScheduler to keep the render loop alive.
 */
class DisintegrationController {
  #scheduler: AnimationScheduler;
  #overlays = new Map<string, DisintegrationOverlay>();
  #staggerIndex = 0;
  #handle: AnimationHandle | null = null;

  constructor(scheduler: AnimationScheduler) {
    this.#scheduler = scheduler;
  }

  /** Register a new disintegration overlay. */
  addOverlay(
    id: string,
    position: Point,
    size: { width: number; height: number },
    rotation: number,
  ): DisintegrationRenderOverlay {
    const delay = this.#staggerIndex * STAGGER_DELAY_MS;
    this.#staggerIndex++;

    const overlay: DisintegrationOverlay = {
      id,
      startTime: performance.now() + delay,
      dissolveDuration: DISSOLVE_DURATION_MS,
      duration: DISSOLVE_DURATION_MS + PARTICLE_LIFETIME_MS,
      seed: Math.random() * 1000,
      position: { x: position.x, y: position.y },
      size: { width: size.width, height: size.height },
      rotation,
    };
    this.#overlays.set(id, overlay);

    canvasStore.setContainerDirty();

    // Register with scheduler if not already active
    if (!this.#handle?.isActive) {
      this.#handle = this.#scheduler.custom({
        tag: "disintegration",
        tick: (now) => {
          // Evict completed overlays
          let removed = false;
          for (const [overlayId, overlay] of this.#overlays) {
            if (now >= overlay.startTime && now - overlay.startTime >= overlay.duration) {
              this.#overlays.delete(overlayId);
              removed = true;
            }
          }
          if (removed) {
            canvasStore.setContainerDirty();
          }
          return this.#overlays.size > 0;
        },
      });
    }

    return this.#toRenderOverlay(overlay, performance.now());
  }

  /** Reset stagger counter. Call before a batch of deletions. */
  resetStagger(): void {
    this.#staggerIndex = 0;
  }

  /** Get eased progress for an overlay (0 = not started, 0→1 = animating). */
  getProgress(id: string): number {
    const overlay = this.#overlays.get(id);
    if (!overlay) return 0;

    const now = performance.now();
    return this.#getProgressAt(overlay, now);
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

  getRenderState(now = performance.now()): DisintegrationRenderState {
    return {
      overlays: Array.from(this.#overlays.values(), (overlay) =>
        this.#toRenderOverlay(overlay, now),
      ),
    };
  }

  /** Cancel a specific overlay (e.g., on undo). */
  cancelOverlay(id: string): void {
    if (this.#overlays.delete(id)) {
      canvasStore.setContainerDirty();
    }
  }

  /** Cancel all active overlays. */
  clear(): void {
    this.#overlays.clear();
    this.#staggerIndex = 0;
    canvasStore.setContainerDirty();
  }

  #toRenderOverlay(overlay: DisintegrationOverlay, now: number): DisintegrationRenderOverlay {
    return {
      id: overlay.id,
      startTime: overlay.startTime,
      dissolveDuration: overlay.dissolveDuration,
      duration: overlay.duration,
      seed: overlay.seed,
      position: { x: overlay.position.x, y: overlay.position.y },
      size: { width: overlay.size.width, height: overlay.size.height },
      rotation: overlay.rotation,
      progress: this.#getProgressAt(overlay, now),
      elapsedSeconds: Math.max(now - overlay.startTime, 0) / 1000,
    };
  }

  #getProgressAt(overlay: DisintegrationOverlay, now: number): number {
    if (now < overlay.startTime) return 0;

    const elapsed = now - overlay.startTime;
    const t = Math.min(elapsed / overlay.dissolveDuration, 1);
    return easings.easeOutExpo(t);
  }
}

/** Singleton instance */
export const disintegrationController = new DisintegrationController(defaultScheduler);
