import { toastManager } from "#application/notifications.ts";
import type { MediaLoadFailure } from "#application/canvas/entity-placement.ts";

const MEDIA_LOAD_ERROR_TOAST_TIMEOUT_MS = 20_000;

export function showMediaLoadFailureToasts(failures: readonly MediaLoadFailure[]): void {
  const videoFailures = failures.filter((failure) => failure.mediaKind === "video");
  const otherFailures = failures.filter((failure) => failure.mediaKind !== "video");

  if (videoFailures.length > 0) {
    const firstFile = videoFailures[0]!.file.name;
    toastManager.add({
      title: videoFailures.length === 1 ? "Unsupported video" : "Unsupported videos",
      description:
        videoFailures.length === 1
          ? `${firstFile} isn’t supported by this browser.`
          : `${videoFailures.length} videos aren’t supported by this browser.`,
      type: "destructive",
      timeout: MEDIA_LOAD_ERROR_TOAST_TIMEOUT_MS,
    });
  }

  if (otherFailures.length > 0) {
    toastManager.add({
      title: "Couldn’t load media",
      description:
        otherFailures.length === 1
          ? `${otherFailures[0]!.file.name} couldn’t be loaded.`
          : `${otherFailures.length} files couldn’t be loaded.`,
      type: "destructive",
      timeout: MEDIA_LOAD_ERROR_TOAST_TIMEOUT_MS,
    });
  }
}
