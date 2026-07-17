export type Thunk<T = void> = () => Promise<T>;
export type ThunkSync<T = void> = () => T;

export { createEnum } from "@voidmesh/domain/enum";
export type { EnumOf } from "@voidmesh/domain/enum";
