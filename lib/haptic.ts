// MIT License
// Copyright (c) 2026 Chánh Đại, ogdakke

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import type { ThunkSync } from "#types/index.ts";

/**
 * Haptics need a coarse pointer and the Vibration API. iOS WebKit has no
 * `navigator.vibrate`, so iOS reports no haptic support.
 */
export const supportsHaptic: ThunkSync<boolean> = () =>
  typeof window !== "undefined" &&
  "vibrate" in navigator &&
  typeof navigator.vibrate === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

/**
 * Trigger haptic feedback via the Vibration API on supporting touch devices.
 *
 * <Button onClick={haptic}>Haptic</Button>
 */
export function haptic({
  pattern,
  wantsHaptic,
}: { pattern?: VibratePattern; wantsHaptic?: boolean } = {}) {
  try {
    if (wantsHaptic === false || !supportsHaptic()) return;
    navigator.vibrate(pattern ?? 50);
  } catch {}
}
