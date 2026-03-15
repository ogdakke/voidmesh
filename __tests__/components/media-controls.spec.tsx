/**
 * Tests for MediaControls component
 *
 * Focuses on the frozen state behavior for exit animations
 * and immediate updates when switching between media entities.
 */
import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { screen, act } from "@testing-library/react";
import { MediaControls } from "../../components/infinite-canvas/media-controls.tsx";
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

  describe("frozen state for exit animation", () => {
    test("displays frozen time values when deselecting", () => {
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

      // Verify time is displayed (main part in one element, ms in nested span)
      expect(screen.getByText("45")).toBeInTheDocument();

      // Deselect - controls become hidden but should retain frozen values
      act(() => {
        canvasStore.clearSelection();
      });

      // The frozen values should still be in the DOM (for CSS exit animation)
      expect(screen.getByText("45")).toBeInTheDocument();
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

      expect(screen.getByText("15")).toBeInTheDocument();

      // Seek video B while not selected
      act(() => {
        canvasStore.seekVideo(idB!, 85);
      });

      // Switch to video B
      act(() => {
        canvas.selectEntity(idB!);
      });

      // Should show video B's time (85s = 1:25), not video A's frozen time
      expect(screen.getByText("1:25")).toBeInTheDocument();
      expect(screen.queryByText("15")).not.toBeInTheDocument();
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
      expect(screen.getByText("30")).toBeInTheDocument();

      act(() => {
        canvas.selectEntity(idB!);
      });

      // Video B duration: 120 seconds = 2:00
      expect(screen.getByText("2:00")).toBeInTheDocument();
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
      expect(screen.getByText("5")).toBeInTheDocument();
    });

    test("displays correct duration for GIF", () => {
      const { canvas } = renderWithCanvas(<MediaControls />);

      act(() => {
        const id = canvas.addEntity(createEntityInput({ mediaType: "gif", gifDuration: 3.5 }));
        canvas.selectEntity(id);
      });

      // Duration should be 3:50 (3 seconds, 50 centiseconds)
      expect(screen.getByText("3")).toBeInTheDocument();
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
      expect(screen.getByText("2:00")).toBeInTheDocument();

      act(() => {
        canvas.selectEntity(gifId!);
      });

      // GIF duration: 5 seconds
      expect(screen.getByText("5")).toBeInTheDocument();
    });
  });
});
