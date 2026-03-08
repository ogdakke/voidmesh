import type { ContentVariant, ModelSize, WeightFile } from "./upscale-types.ts";

type WeightKey = `${ModelSize}-${ContentVariant}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON imports have inferred literal types that don't match our interface exactly
const weightImporters: Record<WeightKey, () => Promise<any>> = {
  "s-rl": () => import("#weights/cnn-2x-s-rl.json"),
  "s-an": () => import("#weights/cnn-2x-s-an.json"),
  "s-3d": () => import("#weights/cnn-2x-s-3d.json"),
  "m-rl": () => import("#weights/cnn-2x-m-rl.json"),
  "m-an": () => import("#weights/cnn-2x-m-an.json"),
  "m-3d": () => import("#weights/cnn-2x-m-3d.json"),
  "l-rl": () => import("#weights/cnn-2x-l-rl.json"),
  "l-an": () => import("#weights/cnn-2x-l-an.json"),
  "l-3d": () => import("#weights/cnn-2x-l-3d.json"),
};

/** Cache loaded weights in memory */
const weightCache = new Map<WeightKey, WeightFile>();

/**
 * Load model weights via lazy dynamic import.
 * Vite code-splits each JSON into a separate chunk, loaded on demand.
 * Results are cached in memory for subsequent calls.
 */
export async function loadWeights(size: ModelSize, variant: ContentVariant): Promise<WeightFile> {
  const key: WeightKey = `${size}-${variant}`;

  const cached = weightCache.get(key);
  if (cached) return cached;

  const module = await weightImporters[key]();
  const weights = module.default as WeightFile;
  weightCache.set(key, weights);
  return weights;
}
