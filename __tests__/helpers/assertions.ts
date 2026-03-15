/**
 * Custom assertion helpers for canvas tests
 *
 * These helpers provide convenient assertions for common test scenarios
 * involving the canvas store, entities, and shader parameters.
 */
import type { GetParamByPath, ParamPaths, ShaderType } from "#types/canvas.ts";
import { expect } from "vite-plus/test";
import { canvasStore } from "#engine";

/**
 * Assert that the selection count matches expected
 */
export function assertSelectionCount(expected: number): void {
  const actual = canvasStore.getSelectionCount();
  expect(actual).toBe(expected);
}

/**
 * Assert that an entity has a specific shader param value
 *
 * @example
 * assertEntityParam("entity-1", "size", 25);
 * assertEntityParam("entity-1", "adjustments.brightness", 0.7);
 */
export function assertEntityParam<P extends ParamPaths>(
  entityId: string,
  path: P,
  expected: GetParamByPath<P>,
): void {
  const entity = canvasStore.getState().entities.get(entityId);
  expect(entity).toBeDefined();

  if (!entity) return;

  const actual = getNestedValue(entity.shaderParams, path);

  if (typeof expected === "object" && expected !== null) {
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  } else {
    expect(actual).toBe(expected);
  }
}

/**
 * Assert that an entity has a specific shader type
 */
export function assertShaderType(entityId: string, expected: ShaderType): void {
  const entity = canvasStore.getState().entities.get(entityId);
  expect(entity).toBeDefined();
  expect(entity?.shaderType).toBe(expected);
}

/**
 * Assert that all selected entities have a specific param value
 *
 * @example
 * assertAllSelectedHave("showOriginal", true);
 */
export function assertAllSelectedHave<P extends ParamPaths>(
  path: P,
  expected: GetParamByPath<P>,
): void {
  const selectedEntities = canvasStore.getSelectedEntities();
  expect(selectedEntities.length).toBeGreaterThan(0);

  for (const entity of selectedEntities) {
    const actual = getNestedValue(entity.shaderParams, path);

    if (typeof expected === "object" && expected !== null) {
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    } else {
      expect(actual).toBe(expected);
    }
  }
}

/**
 * Assert that all selected entities have a specific shader type
 */
export function assertAllSelectedHaveShaderType(expected: ShaderType): void {
  const selectedEntities = canvasStore.getSelectedEntities();
  expect(selectedEntities.length).toBeGreaterThan(0);

  for (const entity of selectedEntities) {
    expect(entity.shaderType).toBe(expected);
  }
}

/**
 * Assert that an entity exists in the store
 */
export function assertEntityExists(entityId: string): void {
  const entity = canvasStore.getState().entities.get(entityId);
  expect(entity).toBeDefined();
}

/**
 * Assert that an entity does NOT exist in the store
 */
export function assertEntityNotExists(entityId: string): void {
  const entity = canvasStore.getState().entities.get(entityId);
  expect(entity).toBeUndefined();
}

/**
 * Assert that an entity is selected
 */
export function assertEntitySelected(entityId: string): void {
  expect(canvasStore.isSelected(entityId)).toBe(true);
}

/**
 * Assert that an entity is NOT selected
 */
export function assertEntityNotSelected(entityId: string): void {
  expect(canvasStore.isSelected(entityId)).toBe(false);
}

/**
 * Assert that the selection contains exactly the specified entity IDs
 */
export function assertSelectionEquals(expectedIds: string[]): void {
  const actualIds = [...canvasStore.getSelectedEntityIds()];
  expect(actualIds.sort()).toEqual(expectedIds.sort());
}

/**
 * Assert that entities have uniform param value (all same)
 */
export function assertParamUniform<P extends ParamPaths>(entityIds: string[], path: P): void {
  const entities = entityIds
    .map((id) => canvasStore.getState().entities.get(id))
    .filter((e) => e !== undefined);

  expect(entities.length).toBe(entityIds.length);

  if (entities.length === 0) return;

  const firstValue = getNestedValue(entities[0]!.shaderParams, path);

  for (const entity of entities.slice(1)) {
    const value = getNestedValue(entity.shaderParams, path);

    if (typeof firstValue === "object" && firstValue !== null) {
      expect(JSON.stringify(value)).toBe(JSON.stringify(firstValue));
    } else {
      expect(value).toBe(firstValue);
    }
  }
}

/**
 * Assert that entities have mixed param values (not all same)
 */
export function assertParamMixed<P extends ParamPaths>(entityIds: string[], path: P): void {
  const entities = entityIds
    .map((id) => canvasStore.getState().entities.get(id))
    .filter((e) => e !== undefined);

  expect(entities.length).toBe(entityIds.length);

  if (entities.length < 2) return;

  const values = new Set(
    entities.map((e) => {
      const val = getNestedValue(e.shaderParams, path);
      return typeof val === "object" ? JSON.stringify(val) : val;
    }),
  );

  expect(values.size).toBeGreaterThan(1);
}

/**
 * Assert that entities have uniform shader type
 */
export function assertShaderTypeUniform(entityIds: string[]): void {
  const entities = entityIds
    .map((id) => canvasStore.getState().entities.get(id))
    .filter((e) => e !== undefined);

  expect(entities.length).toBe(entityIds.length);

  if (entities.length === 0) return;

  const firstType = entities[0]!.shaderType;

  for (const entity of entities.slice(1)) {
    expect(entity.shaderType).toBe(firstType);
  }
}

/**
 * Assert that entities have mixed shader types
 */
export function assertShaderTypeMixed(entityIds: string[]): void {
  const entities = entityIds
    .map((id) => canvasStore.getState().entities.get(id))
    .filter((e) => e !== undefined);

  expect(entities.length).toBe(entityIds.length);

  if (entities.length < 2) return;

  const types = new Set(entities.map((e) => e.shaderType));
  expect(types.size).toBeGreaterThan(1);
}

/**
 * Assert that URL params contain expected values
 */
export function assertUrlParam(
  url: string | URL,
  paramName: string,
  expected: string | null,
): void {
  const urlObj = typeof url === "string" ? new URL(url, "http://test") : url;
  const actual = urlObj.searchParams.get(paramName);
  expect(actual).toBe(expected);
}

/**
 * Assert that URL params match expected object
 */
export function assertUrlParams(url: string | URL, expected: Record<string, string | null>): void {
  const urlObj = typeof url === "string" ? new URL(url, "http://test") : url;

  for (const [key, value] of Object.entries(expected)) {
    expect(urlObj.searchParams.get(key)).toBe(value);
  }
}

/**
 * Helper to get nested value from an object by dot-notation path
 */
export function getNestedValue(obj: object, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Assert entity count in store
 */
export function assertEntityCount(expected: number): void {
  const actual = canvasStore.getState().entities.size;
  expect(actual).toBe(expected);
}

/**
 * Get param result from store for testing
 */
export function getParamResult<P extends ParamPaths>(
  path: P,
  defaultValue: GetParamByPath<P> | null,
) {
  return canvasStore.getParamResult(path, defaultValue);
}
