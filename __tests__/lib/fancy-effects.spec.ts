import { beforeEach, afterEach, describe, expect, test } from "vitest";
import { FancyEffects } from "#types/fancy-effects.ts";
import { preferences, storage } from "#lib/preferences.ts";
import {
  hasDeletionEffects,
  hasPrismWakeEffects,
  resolveFancyEffectsPreference,
  withDeletionEffects,
  withPrismWakeEffects,
} from "#lib/fancy-effects.ts";

async function clearEffectPreferences() {
  await storage.removeItem("fancyDelete");
  await storage.removeItem("fancyEffects");
}
beforeEach(clearEffectPreferences);
afterEach(clearEffectPreferences);

describe("Fancy Effects preferences", () => {
  test.each([
    [true, FancyEffects.all],
    [false, FancyEffects.none],
  ] as const)(
    "silently migrates fancyDelete=%s to %s and persists it",
    async (legacy, expected) => {
      await storage.setItem("fancyDelete", legacy);
      expect(await preferences.getFancyEffects()).toBe(expected);
      expect(await storage.getItem("fancyEffects")).toBe(expected);
      expect(await storage.getItem("fancyDelete")).toBeNull();
      expect(await preferences.getFancyEffects()).toBe(expected);
    },
  );
  test.each([FancyEffects.none, FancyEffects.all, FancyEffects.deletions, FancyEffects.prismWake])(
    "preserves the explicit %s preference over legacy data",
    async (value) => {
      await storage.setItem("fancyDelete", true);
      await preferences.setFancyEffects(value);
      expect(await preferences.getFancyEffects()).toBe(value);
    },
  );
  test("new users get All unless they prefer reduced motion; saved choices take precedence", () => {
    expect(resolveFancyEffectsPreference(null, false)).toBe(FancyEffects.all);
    expect(resolveFancyEffectsPreference(null, true)).toBe(FancyEffects.none);
    expect(resolveFancyEffectsPreference(FancyEffects.all, true)).toBe(FancyEffects.all);
    expect(resolveFancyEffectsPreference(FancyEffects.none, false)).toBe(FancyEffects.none);
  });
  test("leaves first-run choice to the reduced-motion default", async () => {
    expect(await preferences.getFancyEffects()).toBeNull();
  });
  test.each([
    [FancyEffects.none, false, false],
    [FancyEffects.all, true, true],
    [FancyEffects.deletions, true, false],
    [FancyEffects.prismWake, false, true],
  ] as const)("%s enables only its selected effects", (value, deletion, prism) => {
    expect(hasDeletionEffects(value)).toBe(deletion);
    expect(hasPrismWakeEffects(value)).toBe(prism);
  });

  test.each([
    [FancyEffects.none, true, FancyEffects.deletions],
    [FancyEffects.prismWake, true, FancyEffects.all],
    [FancyEffects.all, false, FancyEffects.prismWake],
    [FancyEffects.deletions, false, FancyEffects.none],
  ] as const)("sets deletion effects on %s", (value, enabled, expected) => {
    expect(withDeletionEffects(value, enabled)).toBe(expected);
  });

  test.each([
    [FancyEffects.none, true, FancyEffects.prismWake],
    [FancyEffects.deletions, true, FancyEffects.all],
    [FancyEffects.all, false, FancyEffects.deletions],
    [FancyEffects.prismWake, false, FancyEffects.none],
  ] as const)("sets overlap effects on %s", (value, enabled, expected) => {
    expect(withPrismWakeEffects(value, enabled)).toBe(expected);
  });
});
