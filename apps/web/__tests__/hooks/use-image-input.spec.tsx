import React, { useEffect, useRef } from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { withNuqsTestingAdapter } from "nuqs/adapters/testing";
import { CanvasProvider } from "#context/canvas-context.tsx";
import { canvasStore } from "#engine";
import { getViewportCenter, screenToWorld } from "#lib/canvas-math.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";

const mocks = vi.hoisted(() => ({
  addFilesToCanvas: vi.fn<(...args: unknown[]) => Promise<void>>(),
  addUrlToCanvas: vi.fn<(...args: unknown[]) => Promise<void>>(),
  addUrlsToCanvas: vi.fn<(...args: unknown[]) => Promise<void>>(),
  fitEntitiesToView: vi.fn<(...args: unknown[]) => void>(),
  wait: vi.fn<() => Promise<void>>(async () => {}),
  importStudioWithToasts: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock("#application/canvas/entity-placement.ts", () => ({
  addFilesToCanvas: mocks.addFilesToCanvas,
  addUrlToCanvas: mocks.addUrlToCanvas,
  addUrlsToCanvas: mocks.addUrlsToCanvas,
  fitEntitiesToView: mocks.fitEntitiesToView,
}));

vi.mock("#hooks/use-clipboard-paste.ts", () => ({
  useClipboardPaste: () => {},
}));

vi.mock("#hooks/use-is-mobile.ts", () => ({
  useIsMobile: () => false,
}));

vi.mock("#hooks/use-studio-file.ts", () => ({
  importStudioWithToasts: mocks.importStudioWithToasts,
}));

vi.mock("#lib/util.ts", async () => {
  const actual = await vi.importActual("#lib/util.ts");
  return {
    ...(actual as object),
    wait: mocks.wait,
  };
});

const { useImageInput } = await import("#hooks/use-image-input.ts");

type Handlers = ReturnType<typeof useImageInput>;

function Harness({ onReady }: { onReady: (handlers: Handlers, element: HTMLDivElement) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handlers = useImageInput({ containerRef, multipleFiles: true });

  useEffect(() => {
    if (containerRef.current) {
      onReady(handlers, containerRef.current);
    }
  }, [handlers, onReady]);

  return <div ref={containerRef} />;
}

function makeProviders(children: React.ReactNode) {
  const NuqsTestingWrapper = withNuqsTestingAdapter({ searchParams: {} });

  return (
    <NuqsTestingWrapper>
      <CanvasProvider>{children}</CanvasProvider>
    </NuqsTestingWrapper>
  );
}

function makeFile(name: string, type = "image/png"): File {
  return new File(["test"], name, { type });
}

describe("useImageInput", () => {
  let cleanup: () => void;
  let handlers: Handlers | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    cleanup?.();
    cleanup = setupCanvasTest();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    handlers = null;
    container = null;
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
    canvasStore.setViewport({ offset: { x: 100, y: 40 }, zoom: 2 });

    render(
      makeProviders(
        <Harness
          onReady={(nextHandlers, element) => {
            handlers = nextHandlers;
            container = element;
            element.getBoundingClientRect = () =>
              ({
                left: 10,
                top: 20,
                width: 800,
                height: 600,
                right: 810,
                bottom: 620,
                x: 10,
                y: 20,
                toJSON: () => ({}),
              }) as DOMRect;
          }}
        />,
      ),
    );
  });

  test("file picker imports use viewport center and fit to view", async () => {
    expect(handlers).not.toBeNull();
    expect(container).not.toBeNull();

    const expectedAnchor = getViewportCenter(
      canvasStore.getViewport(),
      container!.getBoundingClientRect(),
      1,
    );

    await act(async () => {
      await handlers!.handleFileSelect([makeFile("picked.png")] as unknown as FileList);
    });

    expect(mocks.addFilesToCanvas).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "picked.png" })],
      expect.any(Function),
      container,
      {
        anchor: expectedAnchor,
        select: true,
        fitToView: true,
        bottomInset: 0,
        onLoadFailure: expect.any(Function),
      },
    );
  });

  test("dropped files use drop coordinates and skip fit to view", async () => {
    expect(handlers).not.toBeNull();
    expect(container).not.toBeNull();

    const expectedAnchor = screenToWorld(
      { x: 210, y: 180 },
      canvasStore.getViewport(),
      container!.getBoundingClientRect(),
      1,
    );

    await act(async () => {
      await handlers!.handleDrop({
        clientX: 210,
        clientY: 180,
        dataTransfer: {
          files: [makeFile("drop.png")],
          items: [],
          getData: () => "",
        },
      } as unknown as React.DragEvent<HTMLDivElement>);
    });

    expect(mocks.addFilesToCanvas).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "drop.png" })],
      expect.any(Function),
      container,
      {
        anchor: expectedAnchor,
        select: true,
        fitToView: false,
        bottomInset: 0,
        onLoadFailure: expect.any(Function),
      },
    );
  });

  test("dropped URLs use grouped placement at the drop point", async () => {
    expect(handlers).not.toBeNull();
    expect(container).not.toBeNull();

    const expectedAnchor = screenToWorld(
      { x: 410, y: 260 },
      canvasStore.getViewport(),
      container!.getBoundingClientRect(),
      1,
    );

    await act(async () => {
      await handlers!.handleDrop({
        clientX: 410,
        clientY: 260,
        dataTransfer: {
          files: [],
          items: [],
          getData: (type: string) =>
            type === "text/uri-list" ? "https://example.com/a.png\nhttps://example.com/b.png" : "",
        },
      } as unknown as React.DragEvent<HTMLDivElement>);
    });

    expect(mocks.addUrlsToCanvas).toHaveBeenCalledWith(
      ["https://example.com/a.png", "https://example.com/b.png"],
      expect.any(Function),
      container,
      {
        anchor: expectedAnchor,
        select: true,
        fitToView: false,
        bottomInset: 0,
      },
    );
  });

  test("pasted items can opt into an explicit anchor without fitting the view", async () => {
    expect(handlers).not.toBeNull();
    expect(container).not.toBeNull();

    const anchor = { x: 512, y: 384 };

    await act(async () => {
      await handlers!.handlePastedItems([makeFile("pasted.png")], {
        anchor,
        fitToView: false,
      });
    });

    expect(mocks.addFilesToCanvas).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "pasted.png" })],
      expect.any(Function),
      container,
      {
        anchor,
        select: true,
        fitToView: false,
        bottomInset: 0,
        onLoadFailure: expect.any(Function),
      },
    );
  });

  test("studio file drops still import the workspace instead of adding media", async () => {
    expect(handlers).not.toBeNull();

    await act(async () => {
      await handlers!.handleDrop({
        clientX: 100,
        clientY: 100,
        dataTransfer: {
          files: [makeFile("workspace.vdmsh", "application/vdmsh")],
          items: [],
          getData: () => "",
        },
      } as unknown as React.DragEvent<HTMLDivElement>);
    });

    expect(mocks.importStudioWithToasts).toHaveBeenCalledTimes(1);
    expect(mocks.addFilesToCanvas).not.toHaveBeenCalled();
  });

  test("failed workspace drops do not leave drag-and-drop stuck loading", async () => {
    expect(handlers).not.toBeNull();

    const abortError = new Error("Workspace import cancelled");
    abortError.name = "AbortError";
    mocks.importStudioWithToasts.mockRejectedValueOnce(abortError);

    await act(async () => {
      await expect(
        handlers!.handleDrop({
          clientX: 100,
          clientY: 100,
          dataTransfer: {
            files: [makeFile("workspace.vdmsh", "application/vdmsh")],
            items: [],
            getData: () => "",
          },
        } as unknown as React.DragEvent<HTMLDivElement>),
      ).rejects.toThrow("Workspace import cancelled");
    });

    await act(async () => {
      await handlers!.handleDrop({
        clientX: 100,
        clientY: 100,
        dataTransfer: {
          files: [makeFile("drop.png")],
          items: [],
          getData: () => "",
        },
      } as unknown as React.DragEvent<HTMLDivElement>);
    });

    expect(mocks.addFilesToCanvas).toHaveBeenCalledTimes(1);
  });
});
