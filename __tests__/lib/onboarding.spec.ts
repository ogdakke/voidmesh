import { describe, expect, test } from "vitest";
import {
  ONBOARDING_VERSION,
  OnboardingStepId,
  buildOnboardingCallouts,
  completeOnboardingStep,
  createDefaultOnboardingProgress,
  getAvailableOnboardingStepIds,
  isOnboardingComplete,
  skipCurrentOnboardingVersion,
} from "#lib/onboarding/onboarding.ts";

describe("onboarding controller helpers", () => {
  test("uses only starter selection on non-action-layer devices", () => {
    expect(getAvailableOnboardingStepIds(false)).toEqual([
      OnboardingStepId.selectStarter,
      OnboardingStepId.deleteOnDesktop,
    ]);
  });

  test("uses action-layer steps where supported", () => {
    expect(getAvailableOnboardingStepIds(true)).toEqual([
      OnboardingStepId.selectStarter,
      OnboardingStepId.openActionLayer,
      OnboardingStepId.hoverAction,
      OnboardingStepId.deleteFromActionLayer,
    ]);
  });

  test("completes steps monotonically", () => {
    const progress = createDefaultOnboardingProgress();
    const first = completeOnboardingStep(progress, OnboardingStepId.selectStarter);
    const second = completeOnboardingStep(first, OnboardingStepId.selectStarter);

    expect(first.completedStepIds).toEqual([OnboardingStepId.selectStarter]);
    expect(second).toBe(first);
  });

  test("does not become incomplete when external canvas state reverses", () => {
    const selected = completeOnboardingStep(
      createDefaultOnboardingProgress(),
      OnboardingStepId.selectStarter,
    );
    const completed = completeOnboardingStep(selected, OnboardingStepId.deleteOnDesktop);

    expect(isOnboardingComplete(completed, getAvailableOnboardingStepIds(false))).toBe(true);
  });

  test("skip completes the current version", () => {
    const skipped = skipCurrentOnboardingVersion(createDefaultOnboardingProgress());

    expect(skipped.skippedVersion).toBe(ONBOARDING_VERSION);
    expect(isOnboardingComplete(skipped, getAvailableOnboardingStepIds(true))).toBe(true);
  });

  test("builds initial entity callout", () => {
    const callouts = buildOnboardingCallouts(createDefaultOnboardingProgress(), {
      starterEntityId: "entity-1",
      supportsActionLayer: true,
      actionLayerActive: false,
      actionLayerTouchOrigin: { x: 0, y: 0 },
      containerRect: null,
    });

    expect(callouts.map((callout) => callout.id)).toEqual([OnboardingStepId.selectStarter]);
    expect(callouts[0]?.anchor).toEqual({
      type: "entity",
      entityId: "entity-1",
      placement: "top",
    });
  });

  test("shows action-layer prompt only after starter selection", () => {
    const progress = completeOnboardingStep(
      createDefaultOnboardingProgress(),
      OnboardingStepId.selectStarter,
    );

    const callouts = buildOnboardingCallouts(progress, {
      starterEntityId: "entity-1",
      supportsActionLayer: true,
      actionLayerActive: false,
      actionLayerTouchOrigin: { x: 0, y: 0 },
      containerRect: null,
    });

    expect(callouts.map((callout) => callout.id)).toEqual([OnboardingStepId.openActionLayer]);
  });
});
