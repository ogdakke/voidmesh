/**
 * Media time formatting utilities
 *
 * Format: "SS:ms" for < 60s, "M:SS:ms" for >= 60s
 * - SS = seconds (no padding for < 60s, 2-digit padding for >= 60s)
 * - ms = centiseconds (hundredths of a second, always 2 digits)
 * - M = minutes (no padding)
 *
 * Examples:
 * - 0.00s  → "0:00"
 * - 5.10s  → "5:10"
 * - 45.32s → "45:32"
 * - 59.99s → "59:99"
 * - 60.00s → "1:00:00"
 * - 90.50s → "1:30:50"
 * - 125.05s → "2:05:05"
 */

export interface MediaTimeParts {
  /** Main part: "SS" for < 60s, "M:SS" for >= 60s */
  main: string;
  /** Centiseconds part: always 2 digits */
  ms: string;
}

/**
 * Format seconds into a human-readable time string.
 * Uses SS:ms format for < 60s, M:SS:ms for >= 60s.
 *
 * @param seconds - Time in seconds (can include fractional part)
 * @returns Formatted time string
 */
export function formatMediaTime(seconds: number): string {
  // Handle invalid values
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }

  // Convert to centiseconds first to avoid floating point issues
  // Round to nearest centisecond, then extract components
  const totalCentiseconds = Math.round(seconds * 100);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);

  if (totalSeconds < 60) {
    // Format: "SS:ms"
    const cs = centiseconds.toString().padStart(2, "0");
    return `${totalSeconds}:${cs}`;
  }

  // Format: "M:SS:ms"
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const secsStr = secs.toString().padStart(2, "0");
  const csStr = centiseconds.toString().padStart(2, "0");

  return `${minutes}:${secsStr}:${csStr}`;
}

/**
 * Format seconds into separate parts for custom styling.
 * Returns main part (seconds or minutes:seconds) and ms part separately.
 *
 * @param seconds - Time in seconds (can include fractional part)
 * @returns Object with main and ms parts
 */
export function formatMediaTimeParts(seconds: number): MediaTimeParts {
  // Handle invalid values
  if (!Number.isFinite(seconds) || seconds < 0) {
    return { main: "0", ms: "00" };
  }

  // Convert to centiseconds first to avoid floating point issues
  const totalCentiseconds = Math.round(seconds * 100);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const ms = centiseconds.toString().padStart(2, "0");

  if (totalSeconds < 60) {
    return { main: totalSeconds.toString(), ms };
  }

  // Format main as "M:SS"
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const main = `${minutes}:${secs.toString().padStart(2, "0")}`;

  return { main, ms };
}
