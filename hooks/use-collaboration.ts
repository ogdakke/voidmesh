import { useSyncExternalStore } from "react";
import { collaborationMetrics } from "#lib/collaboration/metrics.ts";

export function useCollaborationMetrics() {
  return useSyncExternalStore(collaborationMetrics.subscribe, collaborationMetrics.getSnapshot);
}
