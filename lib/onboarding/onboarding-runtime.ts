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
  if (!includesStarterEntity(selectedEntityIds)) return;
  completeOnboardingStepFromEvent(OnboardingStepId.selectStarter);
}

export function completeOnboardingStarterDeletionFromEvent(
  deletedEntityIds: ReadonlySet<string> | readonly string[],
): void {
  if (!includesStarterEntity(deletedEntityIds)) return;
  completeOnboardingStepFromEvent(OnboardingStepId.deleteOnDesktop);
}

function includesStarterEntity(entityIds: ReadonlySet<string> | readonly string[]): boolean {
  if (!starterEntityId) return false;
  for (const id of entityIds) {
    if (id === starterEntityId) return true;
  }
  return false;
}
