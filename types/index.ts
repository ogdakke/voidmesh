export type Thunk<T = void> = () => Promise<T>;
export type ThunkSync<T = void> = () => T;

export type EnumOf<T extends PropertyKey> = {
  [K in T]: K;
} & { infer: T };

export function createEnum<const T extends Record<PropertyKey, PropertyKey>>(
  source: T,
): EnumOf<T[keyof T]> {
  const result = source;
  Object.freeze(result);
  return result as unknown as EnumOf<T[keyof T]>;
}
