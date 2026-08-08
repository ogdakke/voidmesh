import type { CanvasCallout } from "#types/canvas.ts";

export const ONBOARDING_VERSION = 1;
export const ONBOARDING_RESET_EVENT = "voidmesh:onboarding-reset";

export const OnboardingStepId = {
  selectStarter: "select-starter",
  deleteOnDesktop: "delete-on-desktop",
  openActionLayer: "open-action-layer",
  hoverAction: "hover-action",
  deleteFromActionLayer: "delete-from-action-layer",
} as const;

export type OnboardingStepId = (typeof OnboardingStepId)[keyof typeof OnboardingStepId];

export interface OnboardingProgress {
  version: number;
  completedStepIds: OnboardingStepId[];
  skippedVersion: number | null;
}

export interface OnboardingRuntime {
  starterEntityId: string | null;
  supportsActionLayer: boolean;
  actionLayerActive: boolean;
  actionLayerTouchOrigin: { x: number; y: number };
  containerRect: DOMRect | null;
}

export const ALL_ONBOARDING_STEP_IDS: readonly OnboardingStepId[] = [
  OnboardingStepId.selectStarter,
  OnboardingStepId.deleteOnDesktop,
  OnboardingStepId.openActionLayer,
  OnboardingStepId.hoverAction,
  OnboardingStepId.deleteFromActionLayer,
];

export function createDefaultOnboardingProgress(): OnboardingProgress {
  return {
    version: ONBOARDING_VERSION,
    completedStepIds: [],
    skippedVersion: null,
  };
}

export function getAvailableOnboardingStepIds(
  supportsActionLayer: boolean,
): readonly OnboardingStepId[] {
  if (supportsActionLayer)
    return [
      OnboardingStepId.selectStarter,
      OnboardingStepId.openActionLayer,
      OnboardingStepId.hoverAction,
      OnboardingStepId.deleteFromActionLayer,
    ];
  return [OnboardingStepId.selectStarter, OnboardingStepId.deleteOnDesktop];
}

export function isOnboardingSkipped(progress: OnboardingProgress): boolean {
  return progress.skippedVersion === ONBOARDING_VERSION;
}

export function isOnboardingComplete(
  progress: OnboardingProgress,
  availableStepIds: readonly OnboardingStepId[],
): boolean {
  if (isOnboardingSkipped(progress)) return true;
  const completed = new Set(progress.completedStepIds);
  return availableStepIds.every((id) => completed.has(id));
}

export function completeOnboardingStep(
  progress: OnboardingProgress,
  stepId: OnboardingStepId,
): OnboardingProgress {
  if (progress.completedStepIds.includes(stepId)) return progress;
  return {
    ...progress,
    completedStepIds: [...progress.completedStepIds, stepId],
  };
}

export function skipCurrentOnboardingVersion(progress: OnboardingProgress): OnboardingProgress {
  return {
    ...progress,
    skippedVersion: ONBOARDING_VERSION,
  };
}

export function buildOnboardingCallouts(
  progress: OnboardingProgress,
  runtime: OnboardingRuntime,
): CanvasCallout[] {
  if (!runtime.starterEntityId || isOnboardingSkipped(progress)) return [];

  const completed = new Set(progress.completedStepIds);
  const callouts: CanvasCallout[] = [];

  if (!completed.has(OnboardingStepId.selectStarter)) {
    callouts.push({
      id: OnboardingStepId.selectStarter,
      text: "Select this image to edit its effects",
      anchor: {
        type: "entity",
        entityId: runtime.starterEntityId,
        placement: "top",
      },
    });
  }

  if (
    !runtime.supportsActionLayer &&
    completed.has(OnboardingStepId.selectStarter) &&
    !completed.has(OnboardingStepId.deleteOnDesktop)
  ) {
    callouts.push({
      id: OnboardingStepId.deleteOnDesktop,
      text: "Delete by pressing backspace",
      anchor: {
        type: "entity",
        entityId: runtime.starterEntityId,
        placement: "top",
      },
    });
  }

  if (
    runtime.supportsActionLayer &&
    completed.has(OnboardingStepId.selectStarter) &&
    !completed.has(OnboardingStepId.openActionLayer)
  ) {
    callouts.push({
      id: OnboardingStepId.openActionLayer,
      text: "Long press it to move, save, delete and more",
      anchor: {
        type: "entity",
        entityId: runtime.starterEntityId,
        placement: "bottom",
      },
    });
  }

  if (
    runtime.supportsActionLayer &&
    runtime.actionLayerActive &&
    completed.has(OnboardingStepId.openActionLayer) &&
    !completed.has(OnboardingStepId.hoverAction) &&
    runtime.containerRect
  ) {
    callouts.push({
      id: OnboardingStepId.hoverAction,
      text: "Move your finger over actions and release to do the action",
      anchor: {
        type: "entity",
        entityId: runtime.starterEntityId,
        placement: "top",
      },
    });
  }

  if (
    runtime.supportsActionLayer &&
    completed.has(OnboardingStepId.hoverAction) &&
    !completed.has(OnboardingStepId.deleteFromActionLayer) &&
    runtime.containerRect
  ) {
    callouts.push({
      id: OnboardingStepId.deleteFromActionLayer,
      text: "Move your finger over the X and release to delete",
      anchor: {
        type: "entity",
        entityId: runtime.starterEntityId,
        placement: "top",
      },
    });
  }

  return callouts;
}
