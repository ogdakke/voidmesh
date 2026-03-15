/**
 * Clipboard API mock for copy/paste tests
 *
 * Provides a mock implementation of the Clipboard API that can be used
 * in tests to verify clipboard operations without actual system clipboard access.
 */
import { vi, type Mock } from "vite-plus/test";

export interface ClipboardMock {
  /** Mock for clipboard.write() - writing ClipboardItems */
  write: Mock<(items: ClipboardItem[]) => Promise<void>>;
  /** Mock for clipboard.read() - reading ClipboardItems */
  read: Mock<() => Promise<ClipboardItem[]>>;
  /** Mock for clipboard.writeText() - writing plain text */
  writeText: Mock<(text: string) => Promise<void>>;
  /** Mock for clipboard.readText() - reading plain text */
  readText: Mock<() => Promise<string>>;
  /** Set the text content that readText will return */
  setTextContent: (text: string) => void;
  /** Set the items that read will return */
  setItems: (items: ClipboardItem[]) => void;
  /** Get the last text written to clipboard */
  getLastWrittenText: () => string | null;
  /** Get the last items written to clipboard */
  getLastWrittenItems: () => ClipboardItem[] | null;
  /** Cleanup and restore original clipboard */
  cleanup: () => void;
}

/**
 * Create a mock clipboard implementation
 *
 * @example
 * const clipboard = mockClipboard();
 *
 * // Set what readText returns
 * clipboard.setTextContent("https://example.com?shader=halftone");
 *
 * // In test component
 * await navigator.clipboard.readText(); // Returns the set content
 *
 * // Verify writes
 * await navigator.clipboard.writeText("copied text");
 * expect(clipboard.getLastWrittenText()).toBe("copied text");
 *
 * // Cleanup
 * clipboard.cleanup();
 */
export function mockClipboard(): ClipboardMock {
  const originalClipboard = navigator.clipboard;

  let storedText: string | null = null;
  let storedItems: ClipboardItem[] | null = null;
  let lastWrittenText: string | null = null;
  let lastWrittenItems: ClipboardItem[] | null = null;

  const writeMock = vi.fn(async (items: ClipboardItem[]) => {
    lastWrittenItems = items;
    storedItems = items;
  });

  const readMock = vi.fn(async () => {
    return storedItems ?? [];
  });

  const writeTextMock = vi.fn(async (text: string) => {
    lastWrittenText = text;
    storedText = text;
  });

  const readTextMock = vi.fn(async () => {
    return storedText ?? "";
  });

  const mockClipboardObj = {
    write: writeMock,
    read: readMock,
    writeText: writeTextMock,
    readText: readTextMock,
  };

  // Replace navigator.clipboard
  Object.defineProperty(navigator, "clipboard", {
    value: mockClipboardObj,
    writable: true,
    configurable: true,
  });

  return {
    write: writeMock,
    read: readMock,
    writeText: writeTextMock,
    readText: readTextMock,

    setTextContent(text: string) {
      storedText = text;
    },

    setItems(items: ClipboardItem[]) {
      storedItems = items;
    },

    getLastWrittenText() {
      return lastWrittenText;
    },

    getLastWrittenItems() {
      return lastWrittenItems;
    },

    cleanup() {
      Object.defineProperty(navigator, "clipboard", {
        value: originalClipboard,
        writable: true,
        configurable: true,
      });
    },
  };
}

/**
 * Create a mock ClipboardItem for testing
 *
 * @example
 * const item = createMockClipboardItem({
 *   "text/plain": "Hello World",
 *   "image/png": new Blob(["fake image"], { type: "image/png" }),
 * });
 */
export function createMockClipboardItem(data: Record<string, string | Blob>): ClipboardItem {
  const types = Object.keys(data);

  return {
    types,
    async getType(type: string): Promise<Blob> {
      const content = data[type];
      if (content === undefined) {
        throw new DOMException("Type not found", "NotFoundError");
      }

      if (typeof content === "string") {
        return new Blob([content], { type: "text/plain" });
      }

      return content;
    },
    presentationStyle: "unspecified",
  } as ClipboardItem;
}

/**
 * Create a mock ClipboardItem containing a URL
 */
export function createUrlClipboardItem(url: string): ClipboardItem {
  return createMockClipboardItem({
    "text/plain": url,
  });
}

/**
 * Create a mock ClipboardItem containing an image blob
 */
export function createImageClipboardItem(imageType: string = "image/png"): ClipboardItem {
  const fakeImageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
  const blob = new Blob([fakeImageData], { type: imageType });

  return createMockClipboardItem({
    [imageType]: blob,
  });
}

/**
 * Mock ClipboardItem constructor for environments that don't have it
 */
export function mockClipboardItemConstructor(): () => void {
  const originalClipboardItem = globalThis.ClipboardItem;

  class MockClipboardItem implements ClipboardItem {
    #data: Record<string, Blob | Promise<Blob>>;
    types: readonly string[];
    presentationStyle: PresentationStyle = "unspecified";

    constructor(data: Record<string, Blob | Promise<Blob | string>>) {
      this.#data = {} as Record<string, Blob | Promise<Blob>>;

      for (const [type, value] of Object.entries(data)) {
        if (value instanceof Promise) {
          this.#data[type] = value.then((v) => {
            if (typeof v === "string") {
              return new Blob([v], { type: "text/plain" });
            }
            return v;
          });
        } else {
          this.#data[type] = value;
        }
      }

      this.types = Object.keys(data);
    }

    async getType(type: string): Promise<Blob> {
      const content = this.#data[type];
      if (content === undefined) {
        throw new DOMException("Type not found", "NotFoundError");
      }

      if (content instanceof Promise) {
        return content;
      }

      return content;
    }
  }

  globalThis.ClipboardItem = MockClipboardItem as unknown as typeof ClipboardItem;

  return () => {
    if (originalClipboardItem) {
      globalThis.ClipboardItem = originalClipboardItem;
    }
  };
}
