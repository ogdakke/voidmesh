import { FancyEffects } from "#types/fancy-effects.ts";

export function hasDeletionEffects(value: FancyEffects): boolean {
  return value === FancyEffects.all || value === FancyEffects.deletions;
}
export function hasPrismWakeEffects(value: FancyEffects): boolean {
  return value === FancyEffects.all || value === FancyEffects.prismWake;
}

export function withDeletionEffects(value: FancyEffects, enabled: boolean): FancyEffects {
  const prismWake = hasPrismWakeEffects(value);
  if (enabled) return prismWake ? FancyEffects.all : FancyEffects.deletions;
  return prismWake ? FancyEffects.prismWake : FancyEffects.none;
}

export function withPrismWakeEffects(value: FancyEffects, enabled: boolean): FancyEffects {
  const deletions = hasDeletionEffects(value);
  if (enabled) return deletions ? FancyEffects.all : FancyEffects.prismWake;
  return deletions ? FancyEffects.deletions : FancyEffects.none;
}

export function resolveFancyEffectsPreference(
  saved: FancyEffects | null,
  reducedMotion: boolean,
): FancyEffects {
  return saved ?? (reducedMotion ? FancyEffects.none : FancyEffects.all);
}
