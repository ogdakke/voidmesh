import { useEffect, useSyncExternalStore } from "react";
import { StaticStudioShell } from "#components/static-studio-shell/static-studio-shell.tsx";
import { LiveRoot } from "./app.tsx";

let hasMounted = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getMountedSnapshot() {
  return hasMounted;
}

function markMounted() {
  if (hasMounted) return;
  hasMounted = true;
  listeners.forEach((listener) => listener());
}

export function Boot() {
  const mounted = useSyncExternalStore(subscribe, getMountedSnapshot, () => false);

  useEffect(() => {
    markMounted();
  }, []);

  return mounted ? <LiveRoot /> : <StaticStudioShell />;
}
