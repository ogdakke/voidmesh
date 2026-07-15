const MEASURE_PREFIX = "voidmesh.";

/** Emit a bounded User Timing entry that appears in Chrome performance traces. */
export function tracePerformancePhase(
  name: string,
  startTime: number,
  endTime: number,
  recordTimeline = false,
): number {
  const duration = endTime - startTime;
  if (import.meta.env.DEV && recordTimeline) {
    const measureName = `${MEASURE_PREFIX}${name}`;
    performance.measure(measureName, { start: startTime, end: endTime });
    performance.clearMeasures(measureName);
  }
  return duration;
}
