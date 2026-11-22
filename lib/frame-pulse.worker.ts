// Posts one message per display frame at the requested interval. Worker rAF is
// gated to 60 Hz on iOS (measured), so a drift-corrected timer paces ticks.
// See lib/frame-source.ts.
self.onmessage = (event: MessageEvent<{ intervalMs: number }>) => {
  const { intervalMs } = event.data;
  let next = performance.now();
  const pulse = (): void => {
    self.postMessage(0);
    const now = performance.now();
    // Keep the cadence; after a stall, skip missed slots instead of bursting.
    next = Math.max(next + intervalMs, now - intervalMs);
    setTimeout(pulse, Math.max(0, next - now));
  };
  pulse();
};
