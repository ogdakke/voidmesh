import { toastManager } from "#application/notifications.ts";

export async function shareOrCopyUrl() {
  if (navigator.share) {
    navigator.share({ title: "Voidmesh", url: window.location.href }).catch(() => {});
  } else {
    await navigator.clipboard.writeText(window.location.href);
    toastManager.add({ type: "primary", title: "Link copied to clipboard" });
  }
}
