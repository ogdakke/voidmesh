import { subscribeDisplayClock } from "./display-clock.ts";

/**
 * Drives the engine frame loop. `schedule` is called once per tick, after the
 * tick body; a source may fire continuously and ignore repeat calls.
 */
export interface FrameSource {
  schedule(callback: () => void): void;
  cancel(): void;
}

export function createRafFrameSource(): FrameSource {
  let id: number | null = null;
  return {
    schedule(callback) {
      id = requestAnimationFrame(callback);
    },
    cancel() {
      if (id === null) return;
      cancelAnimationFrame(id);
      id = null;
    },
  };
}

/** Ticks on every pulse of the shared 120 Hz display clock. */
export function createDisplayClockFrameSource(): FrameSource {
  let unsubscribe: (() => void) | null = null;
  return {
    schedule(callback) {
      unsubscribe ??= subscribeDisplayClock(callback);
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
