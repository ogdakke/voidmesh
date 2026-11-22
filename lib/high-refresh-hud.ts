// Temporary on-device readout for the ?hz120 experiment. Counters accumulate
// and the readout refreshes once a second.
const KNOWN_FLAGS = new Set(["hz120", "nowlur", "nop3", "noscroller"]);
const counts = new Map<string, number>();
let element: HTMLElement | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let rafId = 0;
let lastActiveText: string | null = null;

export function countHud(name: string, amount = 1): void {
  if (element) counts.set(name, (counts.get(name) ?? 0) + amount);
}

export function startHud(): void {
  if (element) return;
  element = document.createElement("pre");
  element.style.cssText =
    "position:absolute;left:8px;bottom:8px;z-index:99999;margin:0;padding:4px 6px;" +
    "font:11px/1.3 monospace;color:#fff;background:#0008;pointer-events:none;white-space:pre";
  document.body.append(element);

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
  element?.remove();
  element = null;
  interval = null;
  counts.clear();
}

/**
 * The latest readout plus the last second that had touch or GPU activity, so a
 * copy made after tapping a button still includes the interaction being measured.
 */
export function getHudReport(): string | null {
  if (!element?.textContent) return null;
  return lastActiveText
    ? `now:\n${element.textContent}\n\nlast active second:\n${lastActiveText}`
    : element.textContent;
}
