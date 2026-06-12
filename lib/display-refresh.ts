const COMMON_DISPLAY_FRAME_RATES = [60, 75, 90, 100, 120, 144, 165, 240] as const;

export function isPlausibleDisplayFrameRate(frameRate: number): boolean {
  if (!Number.isFinite(frameRate) || frameRate <= 0) return false;
  return COMMON_DISPLAY_FRAME_RATES.some((commonFrameRate) => {
    const tolerance = commonFrameRate * 0.03;
    return Math.abs(frameRate - commonFrameRate) <= tolerance;
  });
}

export function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return sorted[index]!;
}
