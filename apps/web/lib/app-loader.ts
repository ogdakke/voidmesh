const MIN_DISPLAY_MS = 800;
const startTime = Date.now();

const el = document.getElementById("app-loader") as HTMLElement | null;
const textEl = el?.querySelector("p") ?? null;

let dismissed = false;

export const appLoader = {
  setText(text: string) {
    if (textEl) textEl.textContent = text;
  },
  dismiss() {
    if (!el || dismissed) return;
    dismissed = true;
    const hide = () => {
      el.hidden = true;
    };
    const remaining = MIN_DISPLAY_MS - (Date.now() - startTime);
    if (remaining > 0) {
      setTimeout(hide, remaining);
    } else {
      hide();
    }
  },
  startTime,
} as const;
