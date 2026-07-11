import { config } from "#config";
import { deepMerge } from "#lib/deep-merge.ts";
import { retainImageAsset } from "#lib/media-assets.ts";
import { disposeEntityMedia } from "#lib/media-resources.ts";
import {
  MediaType,
  type MediaImageAsset,
  type MediaSourceImage,
  type ShaderCanvasEntity,
  type ShaderParams,
} from "#types/canvas.ts";
import type { PartialDeep } from "type-fest";

export type ResolvedBenchShaderParams = Readonly<ShaderParams>;

/** Resolve scenario overrides once so static entities can share the same parameter tree. */
export function resolveBenchShaderParams(
  overrides: Partial<ShaderParams>,
): ResolvedBenchShaderParams {
  const defaults: ShaderParams = structuredClone(config.defaults.shaderParams);
  const params = deepMerge<ShaderParams, PartialDeep<ShaderParams>>(
    defaults,
    overrides as PartialDeep<ShaderParams>,
  );
  return deepFreeze(params);
}

/**
 * Flowing glass advances `time` on the entity's top-level params object. Keep that state
 * independent while still sharing the large, immutable nested parameter tree.
 */
export function getBenchEntityShaderParams(
  resolved: ResolvedBenchShaderParams,
  needsIndependentTime: boolean,
): ShaderParams {
  return needsIndependentTime ? { ...resolved } : (resolved as ShaderParams);
}

/** Retain the one image-asset reference owned by a newly attached benchmark entity. */
export interface RetainedBenchImageMedia {
  imageBitmap: ImageBitmap;
  mediaSource: MediaSourceImage;
}

export function retainBenchImageMedia(asset: MediaImageAsset): RetainedBenchImageMedia {
  retainImageAsset(asset);
  return {
    imageBitmap: asset.imageBitmap,
    mediaSource: { type: MediaType.image, asset },
  };
}

/** Dispose every entity even if an earlier resource reports an ownership error. */
export function disposeBenchEntities(entities: readonly ShaderCanvasEntity[]): void {
  disposeBenchResources(entities, disposeEntityMedia);
}

/**
 * Create resources in bounded batches and wait for every member of a failed batch before
 * unwinding. This prevents late fulfillments from escaping cleanup after Promise.all rejects.
 */
export async function createBatchedBenchResources<T>(options: {
  count: number;
  batchSize: number;
  create: (index: number) => Promise<T>;
  dispose: (resource: T) => void;
}): Promise<T[]> {
  const resources: T[] = [];

  try {
    for (let offset = 0; offset < options.count; offset += options.batchSize) {
      const batchCount = Math.min(options.batchSize, options.count - offset);
      const settled = await Promise.allSettled(
        Array.from({ length: batchCount }, (_, index) => options.create(offset + index)),
      );

      let failed = false;
      let failure: unknown;
      for (const result of settled) {
        if (result.status === "fulfilled") {
          resources.push(result.value);
        } else if (!failed) {
          failed = true;
          failure = result.reason;
        }
      }
      if (failed) throw failure;
    }

    return resources;
  } catch (error) {
    try {
      disposeBenchResources(resources, options.dispose);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Benchmark resource setup and cleanup failed",
      );
    }
    throw error;
  }
}

export function disposeBenchResources<T>(
  resources: readonly T[],
  dispose: (resource: T) => void,
): void {
  const errors: unknown[] = [];
  for (let index = resources.length - 1; index >= 0; index -= 1) {
    try {
      dispose(resources[index]!);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Benchmark resource cleanup failed");
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
