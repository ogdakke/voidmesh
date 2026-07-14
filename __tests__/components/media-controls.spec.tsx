/**
 * Tests for MediaControls component
 *
 * Focuses on the frozen state behavior for exit animations
 * and immediate updates when switching between media entities.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { screen, act, fireEvent, waitFor } from "@testing-library/react";
import { MediaControls } from "#components/media-controls/media-controls.tsx";
import { renderWithCanvas } from "../helpers/render-with-providers.tsx";
import { createEntityInput, resetEntityCounter } from "../helpers/test-entity.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { canvasStore } from "#engine";

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
  resetEntityCounter();
});

afterEach(() => {
  cleanup();
});

describe("MediaControls", () => {
  describe("visibility", () => {
    test("hidden when no entity selected", () => {
      renderWithCanvas(<MediaControls />);

      const controls = document.querySelector(".media-controls");
      expect(controls).toHaveAttribute("hidden");
    });

    test("hidden when non-animated entity selected", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      act(() => {
        const id = canvas.addEntity(createEntityInput({ mediaType: "image" }));
        canvas.selectEntity(id);
      });

      const controls = document.querySelector(".media-controls");
      expect(controls).toHaveAttribute("hidden");
    });

    test("visible when video entity selected", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      act(() => {
        const id = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 60 }));
        canvas.selectEntity(id);
      });

      const controls = document.querySelector(".media-controls");
      expect(controls).not.toHaveAttribute("hidden");
    });
  });

  describe("exit animation state", () => {
    test("hides the control surface when deselecting", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      let videoId: string;
      act(() => {
        videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
        canvas.selectEntity(videoId);
      });

      // Seek to a specific time
      act(() => {
        canvasStore.seekVideo(videoId!, 45.32);
      });

      expect(screen.getByRole("slider", { hidden: true })).toHaveAttribute(
        "aria-valuetext",
        "45:32 of 1:40:00",
      );

      act(() => {
        canvasStore.clearSelection();
      });

      const controls = document.querySelector(".media-controls");
      expect(controls).toHaveAttribute("hidden");
      expect(screen.getByRole("slider", { hidden: true })).toHaveAttribute(
        "aria-valuetext",
        "45:32 of 1:40:00",
      );
    });
  });

  describe("entity switching", () => {
    test("displays new entity time immediately when switching videos", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      let idA: string;
      let idB: string;

      act(() => {
        idA = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 100 }));
        idB = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 200 }));
        canvas.selectEntity(idA);
      });

      // Seek video A
      act(() => {
        canvasStore.seekVideo(idA!, 15);
      });

      expect(screen.getByRole("slider", { hidden: true })).toHaveAttribute(
        "aria-valuetext",
        "15:00 of 1:40:00",
      );

      // Seek video B while not selected
      act(() => {
        canvasStore.seekVideo(idB!, 85);
      });

      // Switch to video B
      act(() => {
        canvas.selectEntity(idB!);
      });

      // Should show video B's time (85s = 1:25), not video A's time
      expect(screen.getByRole("slider", { hidden: true })).toHaveAttribute(
        "aria-valuetext",
        "1:25:00 of 3:20:00",
      );
    });

    test("displays correct duration when switching videos", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      let idA: string;
      let idB: string;

      act(() => {
        idA = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 30 }));
        idB = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 120 }));
        canvas.selectEntity(idA);
      });

      // Video A duration: 30 seconds
      expect(screen.getByRole("slider", { hidden: true })).toHaveAttribute(
        "aria-valuetext",
        "0:00 of 30:00",
      );

      act(() => {
        canvas.selectEntity(idB!);
      });

      // Video B duration: 120 seconds = 2:00
      expect(screen.getByRole("slider", { hidden: true })).toHaveAttribute(
        "aria-valuetext",
        "0:00 of 2:00:00",
      );
    });
  });

  describe("play/pause button", () => {
    test("shows play button when paused", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      act(() => {
        const id = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 60 }));
        canvas.selectEntity(id);
      });

      const button = screen.getByRole("button", { name: /play/i, hidden: true });
      expect(button).toBeInTheDocument();
    });

    test("shows pause button when playing", async () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      let videoId: string;
      act(() => {
        videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 60 }));
        canvas.selectEntity(videoId);
      });

      await act(async () => {
        await canvasStore.playVideo(videoId!);
      });

      const button = screen.getByRole("button", { name: /pause/i, hidden: true });
      expect(button).toBeInTheDocument();
    });
  });

  describe("keyboard seeking", () => {
    test("period and comma seek video by one frame", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      let videoId: string;
      act(() => {
        videoId = canvas.addEntity(
          createEntityInput({ mediaType: "video", videoDuration: 60, videoFps: 30 }),
        );
        canvas.selectEntity(videoId);
      });

      const slider = screen.getByRole("slider", { hidden: true });

      act(() => {
        canvasStore.seekVideo(videoId!, 0.05);
      });

      act(() => {
        fireEvent.keyDown(slider, { key: "." });
      });
      expect(canvasStore.getState().entities.get(videoId!)?.playback?.currentTime).toBeCloseTo(
        2 / 30,
      );

      act(() => {
        fireEvent.keyDown(slider, { key: "," });
      });
      expect(canvasStore.getState().entities.get(videoId!)?.playback?.currentTime).toBeCloseTo(
        1 / 30,
      );
    });
  });

  describe("mute button", () => {
    test("shows mute button for video with audio, defaulting to muted", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      act(() => {
        const id = canvas.addEntity(
          createEntityInput({ mediaType: "video", videoDuration: 60, videoHasAudio: true }),
        );
        canvas.selectEntity(id);
      });

      expect(screen.getByRole("button", { name: /unmute/i, hidden: true })).toBeInTheDocument();
    });

    test("clicking mute button toggles selected video audio state", async () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      let videoId: string;
      act(() => {
        videoId = canvas.addEntity(
          createEntityInput({ mediaType: "video", videoDuration: 60, videoHasAudio: true }),
        );
        canvas.selectEntity(videoId);
      });

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: /unmute/i, hidden: true }));
      });

      const entity = canvasStore.getState().entities.get(videoId!);
      expect(entity?.playback?.muted).toBe(false);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /^mute$/i, hidden: true })).toBeInTheDocument();
      });
    });

    test("does not show mute button for video without audio", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      act(() => {
        const id = canvas.addEntity(
          createEntityInput({ mediaType: "video", videoDuration: 60, videoHasAudio: false }),
        );
        canvas.selectEntity(id);
      });

      expect(screen.queryByRole("button", { name: /mute/i, hidden: true })).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /unmute/i, hidden: true }),
      ).not.toBeInTheDocument();
    });

    test("switching selected videos shows each independent muted state", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      let idA: string;
      let idB: string;
      act(() => {
        idA = canvas.addEntity(
          createEntityInput({
            mediaType: "video",
            videoDuration: 60,
            videoHasAudio: true,
            muted: false,
          }),
        );
        idB = canvas.addEntity(
          createEntityInput({
            mediaType: "video",
            videoDuration: 60,
            videoHasAudio: true,
            muted: true,
          }),
        );
        canvas.selectEntity(idA);
      });

      expect(screen.getByRole("button", { name: /^mute$/i, hidden: true })).toBeInTheDocument();

      act(() => {
        canvas.selectEntity(idB!);
      });

      expect(screen.getByRole("button", { name: /unmute/i, hidden: true })).toBeInTheDocument();
    });
  });
});

// ============================================================================
// GIF Controls Tests
// ============================================================================

describe("MediaControls - GIF support", () => {
  describe("visibility", () => {
    test("visible when GIF entity selected", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      act(() => {
        const id = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
        canvas.selectEntity(id);
      });

      const controls = document.querySelector(".media-controls");
      expect(controls).not.toHaveAttribute("hidden");
    });

    test("does not show mute button for GIF", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      act(() => {
        const id = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
        canvas.selectEntity(id);
      });

      expect(screen.queryByRole("button", { name: /mute/i, hidden: true })).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /unmute/i, hidden: true }),
      ).not.toBeInTheDocument();
    });
  });

  describe("time display", () => {
    test("displays GIF time values", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      let gifId: string;
      act(() => {
        gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 10 }));
        canvas.selectEntity(gifId);
      });

      // Seek to a specific time
      act(() => {
        canvasStore.seekGif(gifId!, 5.5);
      });

      // Should display 5:50 (5 seconds, 50 centiseconds)
      expect(screen.getByRole("slider", { hidden: true })).toHaveAttribute(
        "aria-valuetext",
        "5:50 of 10:00",
      );
    });

    test("displays correct duration for GIF", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      act(() => {
        const id = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 3.5 }));
        canvas.selectEntity(id);
      });

      // Duration should be 3:50 (3 seconds, 50 centiseconds)
      expect(screen.getByRole("slider", { hidden: true })).toHaveAttribute(
        "aria-valuetext",
        "0:00 of 3:50",
      );
    });
  });

  describe("play/pause button", () => {
    test("shows play button when GIF paused", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      act(() => {
        const id = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
        canvas.selectEntity(id);
      });

      const button = screen.getByRole("button", { name: /play/i, hidden: true });
      expect(button).toBeInTheDocument();
    });

    test("shows pause button when GIF playing", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      let gifId: string;
      act(() => {
        gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
        canvas.selectEntity(gifId);
      });

      act(() => {
        canvasStore.playGif(gifId!);
      });

      const button = screen.getByRole("button", { name: /pause/i, hidden: true });
      expect(button).toBeInTheDocument();
    });
  });

  describe("keyboard seeking", () => {
    test("period and comma seek GIF by one frame", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      let gifId: string;
      act(() => {
        gifId = canvas.addEntity(
          createEntityInput({ mediaType: "gif", gifDuration: 2, gifFrameCount: 10 }),
        );
        canvas.selectEntity(gifId);
      });

      const slider = screen.getByRole("slider", { hidden: true });

      act(() => {
        canvasStore.seekGif(gifId!, 0.25);
      });

      act(() => {
        fireEvent.keyDown(slider, { key: "." });
      });
      expect(canvasStore.getState().entities.get(gifId!)?.playback?.currentTime).toBeCloseTo(0.4);

      act(() => {
        fireEvent.keyDown(slider, { key: "," });
      });
      expect(canvasStore.getState().entities.get(gifId!)?.playback?.currentTime).toBeCloseTo(0.2);
    });
  });

  describe("entity switching", () => {
    test("switching between video and GIF shows correct controls", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      let videoId: string;
      let gifId: string;

      act(() => {
        videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 60 }));
        gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 2 }));
        canvas.selectEntity(videoId);
      });

      // Video selected - controls should be visible
      let controls = document.querySelector(".media-controls");
      expect(controls).not.toHaveAttribute("hidden");

      // Switch to GIF
      act(() => {
        canvas.selectEntity(gifId!);
      });

      // GIF selected - controls should still be visible
      controls = document.querySelector(".media-controls");
      expect(controls).not.toHaveAttribute("hidden");

      // Switch to no selection
      act(() => {
        canvasStore.clearSelection();
      });

      // No selection - controls should be hidden
      controls = document.querySelector(".media-controls");
      expect(controls).toHaveAttribute("hidden");
    });

    test("displays correct duration when switching between video and GIF", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      let videoId: string;
      let gifId: string;

      act(() => {
        videoId = canvas.addEntity(createEntityInput({ mediaType: "video", videoDuration: 120 }));
        gifId = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 5 }));
        canvas.selectEntity(videoId);
      });

      // Video duration: 120 seconds = 2:00
      expect(screen.getByRole("slider", { hidden: true })).toHaveAttribute(
        "aria-valuetext",
        "0:00 of 2:00:00",
      );

      act(() => {
        canvas.selectEntity(gifId!);
      });

      // GIF duration: 5 seconds
      expect(screen.getByRole("slider", { hidden: true })).toHaveAttribute(
        "aria-valuetext",
        "0:00 of 5:00",
      );
    });
  });
});
