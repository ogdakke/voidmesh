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

export const supportsHaptic: ThunkSync<boolean> = () =>
  typeof window !== "undefined" ? window.matchMedia("(pointer: coarse)").matches : false;

/**
 * Type guard to check if navigator supports vibrate API
 */
function hasVibrate(nav: Navigator): nav is Navigator {
  return "vibrate" in nav && typeof nav.vibrate === "function";
}

/**
 * Trigger haptic feedback on mobile devices.
 *
 * Uses Vibration API on Android/modern browsers, and iOS checkbox trick on iOS.
 *
 * <Button onClick={haptic}>Haptic</Button>
 */
export function haptic({
  pattern,
  wantsHaptic,
}: { pattern?: VibratePattern; wantsHaptic?: boolean } = {}) {
  try {
    if (wantsHaptic === false || !supportsHaptic()) return;

    if (hasVibrate(navigator)) {
      navigator.vibrate(pattern ?? 50);
      return;
    }

    // iOS haptic trick via checkbox switch element
    const label = document.createElement("label");
    label.ariaHidden = "true";
    label.style.display = "none";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    label.appendChild(input);

    try {
      document.head.appendChild(label);
      label.click();
    } finally {
      document.head.removeChild(label);
    }
  } catch {}
}
