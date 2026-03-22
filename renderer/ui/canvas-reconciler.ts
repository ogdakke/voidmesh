// ---------------------------------------------------------------------------
// Canvas UI Reconciler
// ---------------------------------------------------------------------------
//
// Creates the react-reconciler instance and exports typed helpers.
//

import ReactReconciler from "react-reconciler";
import { ConcurrentRoot } from "react-reconciler/constants.js";
import { hostConfig } from "./host-config.ts";
import { SceneNode } from "./scene-node.ts";

// react-reconciler@0.33.0 requires many React 19 methods not yet in
// @types/react-reconciler. Cast to any for the creation call (same as R3F).
const reconciler = ReactReconciler(hostConfig);

export type CanvasUIFiberRoot = ReturnType<typeof reconciler.createContainer>;

/**
 * Create a new React container backed by a root SceneNode.
 * Each scene key (e.g. "label-<entityId>", "debug-ui") gets its own container.
 */
export function createCanvasContainer(rootNode: SceneNode): CanvasUIFiberRoot {
  return reconciler.createContainer(
    rootNode,
    ConcurrentRoot, // tag — we always flushSync so concurrency doesn't matter
    null, // hydrationCallbacks
    false, // isStrictMode
    null, // concurrentUpdatesByDefaultOverride
    "", // identifierPrefix
    // Error handlers — log to console
    (error: unknown) => console.error("[CanvasUI] Uncaught:", error),
    (error: unknown) => console.error("[CanvasUI] Caught:", error),
    (error: unknown) => console.error("[CanvasUI] Recoverable:", error),
    () => {},
  );
}

/**
 * Synchronously update a container with a new React element.
 * Uses flushSyncFromReconciler to guarantee the commit completes before returning.
 */
export function updateCanvasContainer(
  element: React.ReactElement | null,
  container: CanvasUIFiberRoot,
): void {
  // flushSyncFromReconciler runs the callback and synchronously flushes
  // all scheduled React work, ensuring SceneNodes are committed before we return.
  reconciler.flushSyncFromReconciler(() => {
    reconciler.updateContainer(element, container, null, undefined);
  });
}

/**
 * Unmount all children from a container.
 */
export function unmountCanvasContainer(container: CanvasUIFiberRoot): void {
  reconciler.flushSyncFromReconciler(() => {
    reconciler.updateContainer(null, container, null, undefined);
  });
}
