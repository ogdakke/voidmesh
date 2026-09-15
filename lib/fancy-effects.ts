import { FancyEffects } from "#types/fancy-effects.ts";

export function hasDeletionEffects(value: FancyEffects): boolean {
  return value === FancyEffects.all || value === FancyEffects.deletions;
}
export function hasPrismWakeEffects(value: FancyEffects): boolean {
  return value === FancyEffects.all || value === FancyEffects.prismWake;
}

export function resolveFancyEffectsPreference(
  saved: FancyEffects | null,
  reducedMotion: boolean,
): FancyEffects {
  return saved ?? (reducedMotion ? FancyEffects.none : FancyEffects.all);
}
