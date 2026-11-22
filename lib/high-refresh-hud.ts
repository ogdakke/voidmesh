import { EXPERIMENT_FLAGS } from "./high-refresh.ts";
// Temporary on-device readout for the ?hz120 experiment. Counters accumulate
// and the readout refreshes once a second.
const KNOWN_FLAGS = new Set<string>(EXPERIMENT_FLAGS.map((flag) => flag.param));
const counts = new Map<string, number>();
let element: HTMLElement | null = null; // readout body
let root: HTMLElement | null = null;
let copyButton: HTMLButtonElement | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let rafId = 0;
let lastActiveText: string | null = null;
let diagnosticStyle: HTMLStyleElement | null = null;

// Diagnostics for page compositing around the canvas. ?nobackdrop removes every
// backdrop-filter; ?nochrome hides all UI except the canvas and this readout
// (remove the param from the URL to get the UI back).
function applyCompositingDiagnostics(): void {
  const params = new URLSearchParams(location.search);
  const rules: string[] = [];
  if (params.has("nobackdrop")) {
    rules.push("* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }");
  }
  if (params.has("nochrome")) {
    rules.push(
      "body * { visibility: hidden !important; }",
      "body canvas, [data-hz-hud], [data-hz-hud] * { visibility: visible !important; }",
    );
  }
  if (rules.length === 0) return;
  diagnosticStyle = document.createElement("style");
  diagnosticStyle.textContent = rules.join("\n");
  document.head.append(diagnosticStyle);
}

export function countHud(name: string, amount = 1): void {
  if (element) counts.set(name, (counts.get(name) ?? 0) + amount);
}

export function startHud(): void {
  if (element) return;
  applyCompositingDiagnostics();
  root = document.createElement("div");
  root.dataset.hzHud = "";
  root.style.cssText =
    "position:absolute;left:8px;bottom:8px;z-index:99999;background:#0008;color:#fff;" +
    "font:11px/1.3 monospace;pointer-events:none;border-radius:6px;overflow:hidden";
  // Only the header takes taps; the rest of the readout stays click-through.
  copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "tap to copy";
  copyButton.style.cssText =
    "display:block;width:100%;min-height:36px;padding:4px 6px;border:0;margin:0;text-align:left;" +
    "font:inherit;color:#8cf;background:#fff2;pointer-events:auto;touch-action:manipulation;" +
    "-webkit-tap-highlight-color:transparent";
  copyButton.addEventListener("click", () => void copyHudReport());
  element = document.createElement("pre");
  element.style.cssText = "margin:0;padding:4px 6px;font:inherit;white-space:pre";
  root.append(copyButton, element);
  document.body.append(root);

  const countRaf = (): void => {
    countHud("mainRaf");
    rafId = requestAnimationFrame(countRaf);
  };
  rafId = requestAnimationFrame(countRaf);

  let last = performance.now();
  interval = setInterval(() => {
    const now = performance.now();
    const seconds = (now - last) / 1000;
    last = now;
    const rate = (name: string) => ((counts.get(name) ?? 0) / seconds).toFixed(0);
    const avg = (total: string, samples: string) => {
      const n = counts.get(samples) ?? 0;
      return n > 0 ? ((counts.get(total) ?? 0) / n).toFixed(1) : "-";
    };
    const ticks = counts.get("ticks") ?? 0;
    const avgTick = ticks > 0 ? (counts.get("tickMs") ?? 0) / ticks : 0;
    if (element) {
      element.textContent =
        `${[...new URLSearchParams(location.search).keys()].filter((key) => KNOWN_FLAGS.has(key)).join(" ")}\n` +
        `ticks/s    ${rate("ticks")}\n` +
        `renders/s  ${rate("renders")}  (skipped ${rate("skippedTicks")}/s)\n` +
        `coalesced  ${rate("coalesced")}/s\n` +
        `main rAF   ${rate("mainRaf")}/s\n` +
        `touchmove  ${rate("touchmove")}/s\n` +
        `scroll Δ   ${rate("scrollDelta")}/s\n` +
        `tick cpu   ${avgTick.toFixed(1)} ms\n` +
        `touch cpu  ${avg("touchMs", "touchmove")} ms/event\n` +
        `js busy    ${((((counts.get("tickMs") ?? 0) + (counts.get("touchMs") ?? 0)) / (seconds * 1000)) * 100).toFixed(0)}%\n` +
        `tick gap   ${ticks > 0 ? ((counts.get("gapMs") ?? 0) / ticks).toFixed(1) : "0"} ms, ` +
        `${rate("longGaps")} >12ms/s\n` +
        `gpu done   ${avg("gpuMs", "gpuSamples")} ms`;
    }
    if (element && ((counts.get("touchmove") ?? 0) > 0 || (counts.get("gpuSamples") ?? 0) > 0)) {
      lastActiveText = element.textContent;
    }
    counts.clear();
  }, 1000);
}

export function stopHud(): void {
  if (interval !== null) clearInterval(interval);
  cancelAnimationFrame(rafId);
  diagnosticStyle?.remove();
  diagnosticStyle = null;
  root?.remove();
  root = null;
  copyButton = null;
  element = null;
  interval = null;
  counts.clear();
}

function buildReport(): string | null {
  if (!element?.textContent) return null;
  const params = new URLSearchParams(location.search);
  const flags = [...KNOWN_FLAGS].filter((flag) => params.has(flag));
  const readout = lastActiveText
    ? `now:\n${element.textContent}\n\nlast active second:\n${lastActiveText}`
    : element.textContent;
  return [
    `flags: ${flags.length > 0 ? flags.join(", ") : "none"}`,
    `dpr: ${window.devicePixelRatio}  viewport: ${window.innerWidth}x${window.innerHeight}`,
    `ua: ${navigator.userAgent}`,
    readout,
  ].join("\n");
}

/**
 * Copies flags, device info, the latest readout and the last second that had
 * touch or GPU activity, so a copy made after tapping still includes the
 * interaction being measured. Returns whether the clipboard write succeeded.
 */
export async function copyHudReport(): Promise<boolean> {
  const report = buildReport() ?? "readout: off (enable 120 Hz mode)";
  let copied = false;
  try {
    await navigator.clipboard.writeText(report);
    copied = true;
  } catch {
    copied = false;
  }
  if (copyButton) {
    const button = copyButton;
    button.textContent = copied ? "copied ✓" : "copy failed";
    setTimeout(() => {
      if (button.isConnected) button.textContent = "tap to copy";
    }, 1200);
  }
  return copied;
}
