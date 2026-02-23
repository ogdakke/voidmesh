/**
 * Shared test setup utilities for canvas tests
 */
import { canvasStore } from "#engine";
import { resetEntityCounter } from "./test-entity.ts";
import { mockAllMediaAPIs } from "../mocks/media.mock.ts";

/**
 * Setup function for canvas tests
 * Call in beforeEach() or at file level (with afterAll cleanup)
 *
 * @returns Cleanup function to call in afterEach() or afterAll()
 *
 * @example
 * // File-level setup (preferred for test files with single describe)
 * import { setupCanvasTest } from "../helpers/test-setup.ts";
 *
 * const cleanup = setupCanvasTest();
 * afterAll(() => cleanup());
 *
 * @example
 * // Per-test setup (for test files with multiple describe blocks needing isolation)
 * let cleanup: () => void;
 * beforeEach(() => { cleanup = setupCanvasTest(); });
 * afterEach(() => cleanup());
 */
export function setupCanvasTest(): () => void {
  resetEntityCounter();
  const cleanupMedia = mockAllMediaAPIs();

  // Reset store state properly (increments versions and notifies subscribers)
  canvasStore.reset();

  return () => cleanupMedia();
}
