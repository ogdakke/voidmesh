/**
 * Mock browser media APIs for testing
 * - createImageBitmap
 * - URL.createObjectURL / revokeObjectURL
 * - OffscreenCanvas
 * - HTMLVideoElement play/pause
 */

export interface MockImageBitmap {
  width: number;
  height: number;
  close: () => void;
}

let objectUrlCounter = 0;
const objectUrls = new Map<string, Blob>();

/**
 * Create a mock ImageBitmap
 */
export function createMockImageBitmap(width = 100, height = 100): MockImageBitmap {
  return {
    width,
    height,
    close: () => {},
  };
}

/**
 * Install mock createImageBitmap
 * Returns cleanup function
 */
export function mockCreateImageBitmap(): () => void {
  const original = (globalThis as any).createImageBitmap;

  (globalThis as any).createImageBitmap = async (
    source: ImageBitmapSource,
    _options?: ImageBitmapOptions,
  ): Promise<MockImageBitmap> => {
    // Extract dimensions from source if possible
    let width = 100;
    let height = 100;

    if (source && typeof source === "object") {
      if ("width" in source && typeof source.width === "number") {
        width = source.width;
      }
      if ("height" in source && typeof source.height === "number") {
        height = source.height;
      }
    }

    return createMockImageBitmap(width, height);
  };

  return () => {
    (globalThis as any).createImageBitmap = original;
  };
}

/**
 * Install mock URL.createObjectURL and revokeObjectURL
 * Returns cleanup function
 */
export function mockObjectURL(): () => void {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  URL.createObjectURL = (blob: Blob): string => {
    const url = `blob:mock-${++objectUrlCounter}`;
    objectUrls.set(url, blob);
    return url;
  };

  URL.revokeObjectURL = (url: string): void => {
    objectUrls.delete(url);
  };

  return () => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    objectUrls.clear();
  };
}

/**
 * Mock OffscreenCanvas for tests
 */
export class MockOffscreenCanvas {
  width: number;
  height: number;
  #context2d: MockOffscreenCanvasRenderingContext2D | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(contextType: string): MockOffscreenCanvasRenderingContext2D | null {
    if (contextType === "2d") {
      if (!this.#context2d) {
        this.#context2d = new MockOffscreenCanvasRenderingContext2D(this);
      }
      return this.#context2d;
    }
    return null;
  }

  transferToImageBitmap(): MockImageBitmap {
    return createMockImageBitmap(this.width, this.height);
  }

  convertToBlob(): Promise<Blob> {
    return Promise.resolve(new Blob([], { type: "image/png" }));
  }
}

export class MockOffscreenCanvasRenderingContext2D {
  canvas: MockOffscreenCanvas;
  fillStyle: string = "#000000";
  strokeStyle: string = "#000000";

  constructor(canvas: MockOffscreenCanvas) {
    this.canvas = canvas;
  }

  drawImage() {}
  fillRect() {}
  clearRect() {}
  getImageData() {
    return {
      data: new Uint8ClampedArray(this.canvas.width * this.canvas.height * 4),
      width: this.canvas.width,
      height: this.canvas.height,
    };
  }
  putImageData() {}
}

/**
 * Install mock OffscreenCanvas globally
 * Returns cleanup function
 */
export function mockOffscreenCanvas(): () => void {
  const original = (globalThis as any).OffscreenCanvas;

  (globalThis as any).OffscreenCanvas = MockOffscreenCanvas;

  return () => {
    (globalThis as any).OffscreenCanvas = original;
  };
}

/**
 * Mock HTMLVideoElement play/pause for video entities
 */
export function createMockVideoElement(options?: {
  duration?: number;
  videoWidth?: number;
  videoHeight?: number;
}): HTMLVideoElement {
  const { duration = 10, videoWidth = 1920, videoHeight = 1080 } = options ?? {};

  const video: Record<string, unknown> = {
    src: "",
    currentTime: 0,
    duration,
    videoWidth,
    videoHeight,
    paused: true,
    loop: false,
    playbackRate: 1,
    play: async function (this: Record<string, unknown>) {
      this.paused = false;
    },
    pause: function (this: Record<string, unknown>) {
      this.paused = true;
    },
    load: function () {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  return video as unknown as HTMLVideoElement;
}

/**
 * Install all media mocks at once
 * Returns cleanup function that restores all
 */
export function mockAllMediaAPIs(): () => void {
  const cleanups = [mockCreateImageBitmap(), mockObjectURL(), mockOffscreenCanvas()];

  return () => {
    cleanups.forEach((cleanup) => cleanup());
  };
}
