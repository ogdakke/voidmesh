import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mockCreateImageBitmap, mockObjectURL, mockOffscreenCanvas } from "../mocks/media.mock.ts";

vi.mock("#lib/audio-demux.ts", () => ({
  hasAudioTrack: async () => false,
}));

vi.mock("mediabunny", () => ({
  ALL_FORMATS: {},
  BlobSource: class BlobSource {},
  Input: class Input {
    async getPrimaryVideoTrack(): Promise<null> {
      return null;
    }

    dispose(): void {}
  },
  VideoSampleSink: class VideoSampleSink {},
}));

const { loadVideo } = await import("#lib/media-loader.ts");

describe("loadVideo", () => {
  let cleanupMediaMocks: (() => void)[];

  beforeEach(() => {
    cleanupMediaMocks = [mockCreateImageBitmap(), mockObjectURL(), mockOffscreenCanvas()];
  });

  afterEach(() => {
    for (const cleanup of cleanupMediaMocks) cleanup();
    vi.restoreAllMocks();
  });

  test("uses the initial decoded frame without waiting for a redundant seek event", async () => {
    const video = new EventTarget() as HTMLVideoElement;
    let readyState = 0;
    let source = "";
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 0, writable: true },
      duration: { configurable: true, value: 1 },
      readyState: { configurable: true, get: () => readyState },
      src: {
        configurable: true,
        get: () => source,
        set: (value: string) => {
          source = value;
          queueMicrotask(() => {
            readyState = 2;
            video.dispatchEvent(new Event("loadedmetadata"));
            video.dispatchEvent(new Event("loadeddata"));
          });
        },
      },
      videoHeight: { configurable: true, value: 180 },
      videoWidth: { configurable: true, value: 320 },
    });
    video.play = async () => undefined;

    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      if (tagName.toLowerCase() === "video") return video;
      return createElement(tagName);
    }) as typeof document.createElement);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("video load did not settle")), 1_000);
    });
    const result = await Promise.race([
      loadVideo(new Blob(["video"], { type: "video/mp4" })),
      timeout,
    ]).finally(() => clearTimeout(timeoutId));

    expect(result.width).toBe(320);
    expect(result.height).toBe(180);
    expect(result.initialFrame).toMatchObject({ width: 320, height: 180 });
  });

  test("hydrates a hosted video paused and reuses persisted metadata", async () => {
    const video = new EventTarget() as HTMLVideoElement;
    let readyState = 0;
    const play = vi.fn<() => Promise<void>>(async () => undefined);
    Object.defineProperties(video, {
      duration: { configurable: true, value: 12 },
      readyState: { configurable: true, get: () => readyState },
      src: {
        configurable: true,
        set: () => {
          queueMicrotask(() => {
            readyState = 2;
            video.dispatchEvent(new Event("loadedmetadata"));
            video.dispatchEvent(new Event("loadeddata"));
          });
        },
      },
      videoHeight: { configurable: true, value: 720 },
      videoWidth: { configurable: true, value: 1280 },
    });
    video.play = play;

    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      if (tagName.toLowerCase() === "video") return video;
      return createElement(tagName);
    }) as typeof document.createElement);

    const result = await loadVideo(new Blob(["video"], { type: "video/mp4" }), {
      alphaMode: "unknown",
      fps: 30,
      hasAudio: true,
      startPlayback: false,
    });

    expect(play).not.toHaveBeenCalled();
    expect(result).toMatchObject({ alphaMode: "unknown", fps: 30, hasAudio: true });
  });
});
