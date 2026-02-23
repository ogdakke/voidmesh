import { deepMerge } from "./deep-merge.ts";
import { shaderDefaults } from "./config/index.ts";
import type { ShaderParams, ShaderType } from "#types/canvas.ts";
import type { PartialDeep } from "type-fest";

/**
 * Merge source into target, but only for fields that are undefined in target.
 * Does not override existing values. Recurses for nested objects.
 */
function mergeIfMissing<T extends object>(target: T, source: PartialDeep<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key as keyof PartialDeep<T>];
    const targetValue = target[key];

    if (sourceValue === undefined) continue;

    if (targetValue === undefined) {
      // Target doesn't have this value, use source
      result[key] = sourceValue as T[keyof T];
    } else if (
      typeof sourceValue === "object" &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === "object" &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      // Both are objects, recurse
      result[key] = mergeIfMissing(targetValue, sourceValue as PartialDeep<typeof targetValue>);
    }
    // Otherwise, target already has a value, keep it
  }

  return result;
}

/**
 * Apply sensible defaults when switching shader types.
 *
 * Logic:
 * 1. If entity already uses the target shader, return params unchanged
 * 2. Apply mergeParams (only fills in missing values)
 * 3. Apply resetParams (forced overrides for optimal appearance)
 *
 * @param currentParams - Entity's current shader params
 * @param currentShaderType - Entity's current shader type
 * @param targetShaderType - The shader type being switched to
 * @returns New shader params with defaults applied
 */
export function applyShaderDefaults(
  currentParams: ShaderParams,
  currentShaderType: ShaderType,
  targetShaderType: ShaderType,
): ShaderParams {
  // If already using this shader, don't change anything
  if (currentShaderType === targetShaderType) {
    return currentParams;
  }

  const defaults = shaderDefaults[targetShaderType];

  // Start with current params
  let result = { ...currentParams };

  // 1. Apply mergeParams first (fills in missing values only)
  result = mergeIfMissing(result, defaults.mergeParams) as ShaderParams;

  // 2. Apply resetParams (forced overrides)
  result = deepMerge(result, defaults.resetParams);

  return result;
}
