import { beforeEach, describe, expect, test, vi } from "vitest";
import { ONBOARDING_VERSION, OnboardingStepId } from "#lib/onboarding.ts";

let storedValue: unknown;
const getItem = vi.fn<() => Promise<unknown>>(async () => storedValue);
const setItem = vi.fn<(key: string, value: unknown) => Promise<void>>(async (_key, value) => {
  storedValue = value;
});

vi.mock("#lib/storage.ts", () => ({
  storage: {
    getItem,
    setItem,
  },
}));

const {
  getOnboardingProgress,
  markOnboardingStepCompleted,
  normalizeOnboardingProgress,
  skipOnboardingVersion,
} = await import("#lib/onboarding-storage.ts");

describe("onboarding storage", () => {
  beforeEach(() => {
    storedValue = undefined;
    getItem.mockClear();
    setItem.mockClear();
  });

  test("defaults malformed progress", () => {
    expect(normalizeOnboardingProgress("not progress")).toEqual({
      version: ONBOARDING_VERSION,
      completedStepIds: [],
      skippedVersion: null,
    });
  });

  test("resets progress for old versions", () => {
    expect(
      normalizeOnboardingProgress({
        version: ONBOARDING_VERSION - 1,
        completedStepIds: [OnboardingStepId.selectStarter],
        skippedVersion: ONBOARDING_VERSION - 1,
      }),
    ).toEqual({
      version: ONBOARDING_VERSION,
      completedStepIds: [],
      skippedVersion: null,
    });
  });

  test("deduplicates and filters completed step ids", () => {
    expect(
      normalizeOnboardingProgress({
        version: ONBOARDING_VERSION,
        completedStepIds: [
          OnboardingStepId.selectStarter,
          "unknown-step",
          OnboardingStepId.selectStarter,
        ],
      }).completedStepIds,
    ).toEqual([OnboardingStepId.selectStarter]);
  });

  test("marks steps complete monotonically", async () => {
    storedValue = {
      version: ONBOARDING_VERSION,
      completedStepIds: [OnboardingStepId.selectStarter],
      skippedVersion: null,
    };

    const next = await markOnboardingStepCompleted(OnboardingStepId.openActionLayer);

    expect(next.completedStepIds).toEqual([
      OnboardingStepId.selectStarter,
      OnboardingStepId.openActionLayer,
    ]);
    expect(storedValue).toEqual(next);
  });

  test("persists skip for current version", async () => {
    const next = await skipOnboardingVersion();

    expect(next.skippedVersion).toBe(ONBOARDING_VERSION);
    expect(storedValue).toEqual(next);
  });

  test("falls back when storage throws", async () => {
    getItem.mockRejectedValueOnce(new Error("read failed"));

    await expect(getOnboardingProgress()).resolves.toEqual({
      version: ONBOARDING_VERSION,
      completedStepIds: [],
      skippedVersion: null,
    });
  });
});
