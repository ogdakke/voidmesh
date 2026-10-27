import { createEnum } from "./index.ts";

export const FancyEffects = createEnum({
  none: "none",
  all: "all",
  deletions: "deletions",
  prismWake: "prismWake",
});
export type FancyEffects = typeof FancyEffects.infer;

export function isFancyEffects(value: unknown): value is FancyEffects {
  return (
    value === FancyEffects.none ||
    value === FancyEffects.all ||
    value === FancyEffects.deletions ||
    value === FancyEffects.prismWake
  );
}
