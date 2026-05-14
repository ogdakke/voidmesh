import { storage } from "./storage.ts";
import {
  ALL_ONBOARDING_STEP_IDS,
  ONBOARDING_RESET_EVENT,
  ONBOARDING_VERSION,
  createDefaultOnboardingProgress,
  type OnboardingProgress,
  type OnboardingStepId,
} from "./onboarding.ts";

const STORAGE_KEY = "onboarding";
const STEP_IDS = new Set<string>(ALL_ONBOARDING_STEP_IDS);

export function normalizeOnboardingProgress(value: unknown): OnboardingProgress {
  if (!isRecord(value) || value.version !== ONBOARDING_VERSION) {
    return createDefaultOnboardingProgress();
  }

  const completedStepIds = Array.isArray(value.completedStepIds)
    ? value.completedStepIds.filter((id): id is OnboardingStepId => STEP_IDS.has(id))
    : [];

  return {
    version: ONBOARDING_VERSION,
    completedStepIds: Array.from(new Set(completedStepIds)),
    skippedVersion: value.skippedVersion === ONBOARDING_VERSION ? ONBOARDING_VERSION : null,
  };
}

export async function getOnboardingProgress(): Promise<OnboardingProgress> {
  try {
    return normalizeOnboardingProgress(await storage.getItem<unknown>(STORAGE_KEY));
  } catch {
    return createDefaultOnboardingProgress();
  }
}

export async function setOnboardingProgress(progress: OnboardingProgress): Promise<void> {
  await storage.setItem(STORAGE_KEY, normalizeOnboardingProgress(progress));
}

export async function markOnboardingStepCompleted(
  stepId: OnboardingStepId,
): Promise<OnboardingProgress> {
  const progress = await getOnboardingProgress();
  if (progress.completedStepIds.includes(stepId)) return progress;

  const next = normalizeOnboardingProgress({
    ...progress,
    completedStepIds: [...progress.completedStepIds, stepId],
  });
  await setOnboardingProgress(next);
  return next;
}

export async function skipOnboardingVersion(): Promise<OnboardingProgress> {
  const progress = await getOnboardingProgress();
  const next = normalizeOnboardingProgress({
    ...progress,
    skippedVersion: ONBOARDING_VERSION,
  });
  await setOnboardingProgress(next);
  return next;
}

export async function resetOnboardingProgress(): Promise<OnboardingProgress> {
  const next = createDefaultOnboardingProgress();
  await setOnboardingProgress(next);
  window.dispatchEvent(new Event(ONBOARDING_RESET_EVENT));
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
