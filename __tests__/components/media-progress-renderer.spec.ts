import { describe, expect, test, vi } from "vitest";
import { renderMediaProgress } from "#components/media-controls/media-progress-renderer.ts";

describe("renderMediaProgress", () => {
  test("groups text work into four font changes per frame", () => {
    let font = "10px sans-serif";
    let fontWrites = 0;
    const context = {
      get font() {
        return font;
      },
      set font(value: string) {
        font = value;
        fontWrites++;
      },
      globalAlpha: 1,
      fillStyle: "",
      textBaseline: "alphabetic",
      clearRect: vi.fn<(...args: unknown[]) => void>(),
      save: vi.fn<() => void>(),
      restore: vi.fn<() => void>(),
      beginPath: vi.fn<() => void>(),
      roundRect: vi.fn<(...args: unknown[]) => void>(),
      fill: vi.fn<() => void>(),
      clip: vi.fn<() => void>(),
      fillRect: vi.fn<(...args: unknown[]) => void>(),
      fillText: vi.fn<(...args: unknown[]) => void>(),
      measureText: vi.fn<(text: string) => { width: number }>((text) => ({
        width: text.length * 8,
      })),
    } as unknown as CanvasRenderingContext2D;

    renderMediaProgress(
      context,
      320,
      32,
      {
        currentTime: 12.34,
        duration: 120,
        currentParts: { main: "12", ms: "34" },
        durationParts: { main: "2:00", ms: "00" },
        hovered: false,
        focused: false,
        dragging: false,
        scrubProgress: 0,
      },
      {
        trackColor: "gray",
        progressColor: "blue",
        textColor: "black",
        fontFamily: "system-ui",
        fontWeight: "400",
        fontSize: 14,
        textY: 16,
        trackHeight: 8,
        trackRadius: 4,
      },
    );

    expect(fontWrites).toBe(4);
    expect(context.fillText).toHaveBeenCalledTimes(4);
  });
});
