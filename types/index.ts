export type Thunk<T = void> = () => Promise<T>;
export type ThunkSync<T = void> = () => T;

export type EnumOf<T extends Record<PropertyKey, PropertyKey>> = Readonly<T> & {
  infer: T[keyof T];
};

export function createEnum<const T extends Record<PropertyKey, PropertyKey>>(source: T): EnumOf<T> {
  const result = source;
  Object.freeze(result);
  return result as unknown as EnumOf<T>;
}
