import type { AppLoaderPreviewControls } from "./app-loader.ts";

/**
 * Dev-only harness for the loader (`?loader-preview`). Holds the loader on screen and
 * adds a small control bar: replay the exit into the app, skip to the next caption, saturate
 * the main thread to check smoothness, and read the worker's per-frame render cost.
 */

const BUSY_SLICE_MS = 120;
const BUSY_INTERVAL_MS = 160;
const APP_REVEAL_MS = 1400;

const STYLE = `
.loader-preview {
  position: fixed;
  z-index: 1000000;
  inset: calc(env(safe-area-inset-top, 0px) + 12px) 12px auto;
  width: fit-content;
  margin-inline: auto;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 20px;
  background: color-mix(in oklch, var(--background) 72%, transparent);
  backdrop-filter: blur(16px) saturate(1.4);
  -webkit-backdrop-filter: blur(16px) saturate(1.4);
  box-shadow: 0 0 0 1px oklch(from var(--color) l c h / 0.1), 0 8px 28px -10px oklch(0% 0 0 / 0.35);
  font: 500 12px/1 var(--sans-serif-rounded);
  color: var(--color);
  animation: loader-preview-in 500ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.loader-preview button {
  flex: none;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: background-color 160ms, color 160ms, transform 160ms;
}
.loader-preview button:hover { background: oklch(from var(--color) l c h / 0.07); }
.loader-preview button:active { transform: scale(0.96); }
.loader-preview button[aria-pressed="true"] { background: var(--destructive); color: white; }
.loader-preview-stats {
  flex: none;
  padding: 0 10px;
  font: 500 11px/30px ui-monospace, "SF Mono", Menlo, monospace;
  font-variant-numeric: tabular-nums;
  color: oklch(from var(--color) l c h / 0.6);
}
.loader-preview hr {
  flex: none;
  width: 1px;
  height: 16px;
  margin: 0 4px;
  border: 0;
  background: oklch(from var(--color) l c h / 0.14);
}
@keyframes loader-preview-in { from { opacity: 0; translate: 0 -12px; } }
`;

export function mountAppLoaderPreview(controls: AppLoaderPreviewControls) {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);

  const bar = document.createElement("div");
  bar.className = "loader-preview";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Loader preview");

  const button = (label: string, onClick: () => void) => {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.addEventListener("click", onClick);
    bar.append(el);
    return el;
  };

  let transitioning = false;
  button("Play exit", async () => {
    if (transitioning) return;
    transitioning = true;
    await controls.playExit();
    await new Promise((resolve) => setTimeout(resolve, APP_REVEAL_MS));
    controls.replay();
    transitioning = false;
  });

  button("Next line", controls.nextLine);

  let busy = false;
  let busyTimer: ReturnType<typeof setInterval> | undefined;
  const busyButton = button("Busy main thread", () => {
    busy = !busy;
    busyButton.setAttribute("aria-pressed", String(busy));
    clearInterval(busyTimer);
    if (!busy) return;
    busyTimer = setInterval(() => {
      const end = performance.now() + BUSY_SLICE_MS;
      while (performance.now() < end) {
        // Intentionally block the main thread.
      }
    }, BUSY_INTERVAL_MS);
  });
  busyButton.setAttribute("aria-pressed", "false");

  bar.append(document.createElement("hr"));
  const stats = document.createElement("output");
  stats.className = "loader-preview-stats";
  stats.title = "Loader worker CPU time per frame (avg / max), frame rate, dither cells";
  bar.append(stats);
  controls.onStats(({ avgMs, maxMs, fps, cells }) => {
    stats.textContent = `${avgMs.toFixed(1)} / ${maxMs.toFixed(1)} ms · ${Math.round(fps)} fps · ${Math.round(cells / 1000)}k cells`;
  });

  document.body.append(bar);
}
