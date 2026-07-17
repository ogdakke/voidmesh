export type EnumOf<T extends Record<PropertyKey, PropertyKey>> = T & {
  infer: T[keyof T];
};

export function createEnum<const T extends Record<PropertyKey, PropertyKey>>(source: T): EnumOf<T> {
  const result = source;
  Object.freeze(result);
  return result as EnumOf<T>;
}
