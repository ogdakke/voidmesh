import { config, shaderDefaults } from "./config/index.ts";
import type { ShaderType, ParamPaths, GetParamByPath } from "#types/canvas.ts";

/**
 * Get a nested value from an object using a dot-notation path
 */
function getByPath<T>(obj: unknown, path: string): T | undefined {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current as T | undefined;
}

/**
 * Get the effective default value for a param path given the current shader type.
 *
 * Priority:
 * 1. shaderDefaults[shaderType].resetParams (shader-specific overrides)
 * 2. shaderDefaults[shaderType].mergeParams (shader-specific fills)
 * 3. config.defaults.shaderParams (global defaults)
 *
 * @example
 * getEffectiveDefault('halftone', 'size') // 10
 * getEffectiveDefault('dithering', 'size') // 1
 * getEffectiveDefault('blobs', 'blobs.eagerness') // 0.5
 * getEffectiveDefault('halftone', 'postProcess.grain.size') // 1 (global)
 */
export function getEffectiveDefault<P extends ParamPaths>(
  shaderType: ShaderType,
  path: P,
): GetParamByPath<P> | undefined {
  const defaults = shaderDefaults[shaderType];

  // Check resetParams first (forced overrides)
  const resetValue = getByPath<GetParamByPath<P>>(defaults.resetParams, path);
  if (resetValue !== undefined) {
    return resetValue;
  }

  // Check mergeParams (fills for missing values)
  const mergeValue = getByPath<GetParamByPath<P>>(defaults.mergeParams, path);
  if (mergeValue !== undefined) {
    return mergeValue;
  }

  // Fall back to global defaults
  return getByPath<GetParamByPath<P>>(config.defaults.shaderParams, path);
}

/**
 * Check if a param value differs from its effective default for a given shader type.
 *
 * @example
 * hasChangedFromDefault('halftone', 'size', 10) // false (10 is default for halftone)
 * hasChangedFromDefault('halftone', 'size', 15) // true
 * hasChangedFromDefault('dithering', 'size', 10) // true (1 is default for dithering)
 */
export function hasChangedFromDefault<P extends ParamPaths>(
  shaderType: ShaderType,
  path: P,
  value: GetParamByPath<P> | null | undefined,
): boolean {
  if (value == null) return false;
  const defaultValue = getEffectiveDefault(shaderType, path);
  return value !== defaultValue;
}
