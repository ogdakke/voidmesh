import type { Root } from "react-dom/client";

const HOT_ROOT_KEY = "voidmeshReactRoot";

/** Reuses the React root when Vite re-evaluates the entry module during HMR. */
export function getOrCreateReactRoot(
  hotData: Record<string, unknown> | undefined,
  createRoot: () => Root,
): Root {
  const existing = hotData?.[HOT_ROOT_KEY];
  if (existing) return existing as Root;
  const root = createRoot();
  if (hotData) hotData[HOT_ROOT_KEY] = root;
  return root;
}
