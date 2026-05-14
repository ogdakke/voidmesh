import { OnboardingStepId, type OnboardingStepId as OnboardingStepIdType } from "./onboarding.ts";

type CompleteStepHandler = (stepId: OnboardingStepIdType) => void;

let starterEntityId: string | null = null;
let completeStepHandler: CompleteStepHandler | null = null;

export function setOnboardingStarterEntityId(entityId: string | null): void {
  starterEntityId = entityId;
}

export function setOnboardingStepCompleteHandler(handler: CompleteStepHandler | null): () => void {
  completeStepHandler = handler;
  return () => {
    if (completeStepHandler === handler) {
      completeStepHandler = null;
    }
  };
}

export function completeOnboardingStepFromEvent(stepId: OnboardingStepIdType): void {
  completeStepHandler?.(stepId);
}

export function completeOnboardingStarterSelectionFromEvent(
  selectedEntityIds: ReadonlySet<string> | readonly string[],
): void {
  if (!starterEntityId) return;
  for (const id of selectedEntityIds) {
    if (id === starterEntityId) {
      completeOnboardingStepFromEvent(OnboardingStepId.selectStarter);
      return;
    }
  }
}
