import { canvasStore, type ParamResult } from "#engine";
import { useCanvasSelector } from "#context/use-canvas.ts";
import type { ParamPaths, GetParamByPath } from "#types/canvas.ts";

// Re-export ParamResult from canvas-store for convenience
export type { ParamResult } from "#engine";

/**
 * Hook for reading shader param values with multi-select support.
 *
 * Returns the first entity's value (always available for display) and whether
 * values differ across the selection (isMixed).
 *
 * Performance: Uses store-level caching with structural sharing.
 * The returned object reference is stable when values don't change.
 *
 * @example
 * const brightness = useParamValue("adjustments.brightness", 0.5);
 * // brightness.value = 0.5, brightness.isMixed = true/false
 *
 * <Slider
 *   label={brightness.isMixed ? "Brightness (Mixed)" : "Brightness"}
 *   value={brightness.value}
 *   showValue={!brightness.isMixed}
 * />
 */
export function useParamValue<P extends ParamPaths>(
  path: P,
  defaultValue: NonNullable<GetParamByPath<P>>,
): ParamResult<NonNullable<GetParamByPath<P>>>;

/**
 * Overload for nullable params (like optional nested objects).
 * Pass `null` as default to check if the param exists.
 */
export function useParamValue<P extends ParamPaths>(
  path: P,
  defaultValue: null,
): ParamResult<GetParamByPath<P> | null>;

export function useParamValue<P extends ParamPaths>(
  path: P,
  defaultValue: GetParamByPath<P> | null,
): ParamResult<GetParamByPath<P> | null> {
  return useCanvasSelector(() => canvasStore.getParamResult(path, defaultValue));
}
