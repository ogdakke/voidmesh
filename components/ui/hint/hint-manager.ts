import { useSyncExternalStore } from "react";
import { hints } from "#application/hints.ts";

export type { HintContent, HintOptions } from "#application/hints.ts";
export { hints } from "#application/hints.ts";

export function useHint() {
  return useSyncExternalStore(hints.subscribe, hints.getState);
}
