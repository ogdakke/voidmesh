// Temporary on-device readout for the ?hz120 experiment. Counters accumulate
// and the readout refreshes once a second.
const counts = new Map<string, number>();
let element: HTMLElement | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let rafId = 0;

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
        `hz120\n` +
        `ticks/s    ${rate("ticks")}\n` +
        `coalesced  ${rate("coalesced")}/s\n` +
        `main rAF   ${rate("mainRaf")}/s\n` +
        `touchmove  ${rate("touchmove")}/s\n` +
        `scroll Δ   ${rate("scrollDelta")}/s\n` +
        `tick cpu   ${avgTick.toFixed(1)} ms\n` +
        `tick gap   ${ticks > 0 ? ((counts.get("gapMs") ?? 0) / ticks).toFixed(1) : "0"} ms, ` +
        `${rate("longGaps")} >12ms/s\n` +
        `gpu done   ${avg("gpuMs", "gpuSamples")} ms`;
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

/** The most recent readout text, or null when the HUD is not running. */
export function getHudText(): string | null {
  return element?.textContent || null;
}
