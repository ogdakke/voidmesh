import type { PartialDeep } from "type-fest";

/**
 * Deep merge two objects recursively.
 * - Arrays are replaced, not merged
 * - Primitives are replaced
 * - Objects are recursively merged
 * - undefined values in updates are ignored (preserve existing)
 * - null values in updates delete the field (set to undefined)
 */
export function deepMerge<T extends object, U extends PartialDeep<T>>(existing: T, updates: U): T {
  const result = { ...existing };

  for (const key of Object.keys(updates) as (keyof T)[]) {
    const updateValue = updates[key as keyof PartialDeep<T>];
    const existingValue = existing[key];

    if (updateValue === undefined) {
      // Skip undefined - preserve existing value
      continue;
    }

    if (updateValue === null) {
      // null means "delete this field"
      result[key] = undefined as T[keyof T];
      continue;
    }

    if (
      typeof updateValue === "object" &&
      !Array.isArray(updateValue) &&
      existingValue !== null &&
      typeof existingValue === "object" &&
      !Array.isArray(existingValue)
    ) {
      result[key] = deepMerge(existingValue, updateValue as any);
    } else {
      result[key] = updateValue as T[keyof T];
    }
  }

  return result as T;
}
