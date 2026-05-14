import { useEffect, useRef, useState } from "react";
import { useActionLayer } from "#hooks/use-action-layer.ts";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import {
  buildOnboardingCallouts,
  completeOnboardingStep,
  getAvailableOnboardingStepIds,
  isOnboardingComplete,
  isOnboardingSkipped,
  ONBOARDING_RESET_EVENT,
  OnboardingStepId,
  skipCurrentOnboardingVersion,
  type OnboardingProgress,
} from "#lib/onboarding.ts";
import { getOnboardingProgress, setOnboardingProgress } from "#lib/onboarding-storage.ts";
import {
  setOnboardingStarterEntityId,
  setOnboardingStepCompleteHandler,
} from "#lib/onboarding-runtime.ts";
import { getViewportLayoutCenter } from "#lib/canvas-math.ts";
import { logger } from "#lib/client.logger.ts";
import { loadMediaFromBlob } from "#lib/media-loader.ts";
import { canvasStore } from "#engine";
import { useCanvasCommands, useCanvasSelector } from "#context/use-canvas.ts";

interface UseOnboardingOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  ready: boolean;
}

interface UseOnboardingResult {
  active: boolean;
  skip: () => void;
}

export function useOnboarding({ containerRef, ready }: UseOnboardingOptions): UseOnboardingResult {
  const { addEntity } = useCanvasCommands();
  const isMobile = useIsMobile();
  const actionLayer = useActionLayer();
  const entityCount = useCanvasSelector((state) => state.entities.size);
  const [progress, setProgress] = useState<OnboardingProgress | null>(null);
  const [starterEntityId, setStarterEntityId] = useState<string | null>(null);
  const hasAttemptedAutoStartRef = useRef(false);

  const availableStepIds = getAvailableOnboardingStepIds(isMobile);

  useEffect(() => {
    let cancelled = false;
    const handleReset = () => {
      hasAttemptedAutoStartRef.current = false;
      setStarterEntityId(null);
      setOnboardingStarterEntityId(null);
      canvasStore.setCanvasCallouts([]);
      getOnboardingProgress()
        .then((stored) => {
          setProgress(stored);
        })
        .catch((err) => {
          logger.warn("Failed to reload onboarding progress", err);
        });
    };

    window.addEventListener(ONBOARDING_RESET_EVENT, handleReset);
    getOnboardingProgress()
      .then((stored) => {
        if (!cancelled) setProgress(stored);
      })
      .catch((err) => {
        logger.warn("Failed to load onboarding progress", err);
      });
    return () => {
      cancelled = true;
      window.removeEventListener(ONBOARDING_RESET_EVENT, handleReset);
      setOnboardingStarterEntityId(null);
      canvasStore.setCanvasCallouts([]);
    };
  }, []);

  useEffect(() => {
    return setOnboardingStepCompleteHandler((stepId) => {
      setProgress((current) => completeStepAndPersist(current, stepId));
    });
  }, []);

  useEffect(() => {
    if (!ready || !progress || hasAttemptedAutoStartRef.current || entityCount !== 0) return;
    if (
      isOnboardingSkipped(progress) ||
      isOnboardingComplete(progress, getAvailableOnboardingStepIds(isMobile))
    ) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    hasAttemptedAutoStartRef.current = true;
    let cancelled = false;

    const start = async () => {
      try {
        const response = await fetch("/favicon.webp");
        const blob = await response.blob();
        const center = getViewportLayoutCenter(
          canvasStore.getViewport(),
          container,
          window.devicePixelRatio,
        );
        const entity = await loadMediaFromBlob(
          blob,
          blob.type || "image/webp",
          center,
          "favicon.webp",
        );
        if (!entity || cancelled) return;

        const id = addEntity(
          {
            ...entity,
            position: {
              x: center.x - entity.size.width / 2,
              // slide up to not show bottom callouts under mobile controls
              y: center.y - (isMobile ? 200 : 0) - entity.size.height / 2,
            },
          },
          "voidmesh",
          { skipUndo: true, source: "onboarding" },
        );

        setStarterEntityId(id);
        setOnboardingStarterEntityId(id);
      } catch (err) {
        logger.warn("Failed to start onboarding", err);
      }
    };

    void start();
    return () => {
      cancelled = true;
    };
  }, [addEntity, containerRef, entityCount, isMobile, progress, ready]);

  const active =
    !!progress &&
    !!starterEntityId &&
    !isOnboardingSkipped(progress) &&
    !isOnboardingComplete(progress, availableStepIds);

  useEffect(() => {
    if (!progress || !active) {
      canvasStore.setCanvasCallouts([]);
      return;
    }

    canvasStore.setCanvasCallouts(
      buildOnboardingCallouts(progress, {
        starterEntityId,
        supportsActionLayer: isMobile,
        actionLayerActive: actionLayer.active,
        actionLayerTouchOrigin: actionLayer.touchOrigin,
        containerRect: containerRef.current?.getBoundingClientRect() ?? null,
      }),
    );
  }, [
    actionLayer.active,
    actionLayer.touchOrigin,
    active,
    containerRef,
    isMobile,
    progress,
    starterEntityId,
  ]);

  const skip = () => {
    if (!progress) return;
    const next = skipCurrentOnboardingVersion(progress);
    setProgress(next);
    setOnboardingProgress(next).catch((err) => logger.warn("Failed to persist onboarding", err));
    canvasStore.setCanvasCallouts([]);
  };

  return { active, skip };
}

function completeStepAndPersist(
  progress: OnboardingProgress | null,
  stepId: OnboardingStepId,
): OnboardingProgress | null {
  if (!progress || progress.completedStepIds.includes(stepId)) return progress;

  const next = completeOnboardingStep(progress, stepId);
  setOnboardingProgress(next).catch((err) => logger.warn("Failed to persist onboarding step", err));
  return next;
}
