import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { createEntityInput } from "../helpers/test-entity.ts";

const { addFilesToCanvas, addUrlsToCanvas } = await import("#lib/entity-placement.ts");
const { canvasStore, gameLoop, viewportAnimation } = await import("#engine");
const mediaLoader = await import("#lib/media-loader.ts");

function makeContainer(): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: 1200, configurable: true });
  Object.defineProperty(element, "clientHeight", { value: 800, configurable: true });
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 1200,
      height: 800,
      right: 1200,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
}

function makeFile(name: string, type = "image/png"): File {
  return new File(["test"], name, { type });
}

function makeEntityInput(size: { width: number; height: number }) {
  return createEntityInput({ size });
}

function createAddEntityRecorder() {
  const added: Array<{
    entity: Omit<ShaderCanvasEntity, "id" | "zIndex" | "name">;
    filename?: string;
  }> = [];

  const addEntity = (
    entity: Omit<ShaderCanvasEntity, "id" | "zIndex" | "name">,
    filename?: string,
  ) => {
    const id = filename ?? `entity-${added.length + 1}`;
    added.push({ entity, filename });
    canvasStore.addEntity({
      ...entity,
      id,
      zIndex: added.length,
      name: filename ?? id,
    } as ShaderCanvasEntity);
    return id;
  };

  return { addEntity, added };
}

describe("entity placement", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup?.();
    cleanup = setupCanvasTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
  });

  test("single file drop anchors entity center at the provided point", async () => {
    const animateTo = vi.spyOn(viewportAnimation, "animateTo");
    vi.spyOn(mediaLoader, "loadMediaFile").mockResolvedValue(
      makeEntityInput({ width: 120, height: 80 }),
    );
    const { addEntity, added } = createAddEntityRecorder();

    const ids = await addFilesToCanvas([makeFile("one.png")], addEntity, makeContainer(), {
      anchor: { x: 400, y: 300 },
      select: true,
      fitToView: false,
      bottomInset: 0,
    });

    expect(ids).toEqual(["one.png"]);
    expect(added).toHaveLength(1);
    expect(added[0]!.entity.position).toEqual({ x: 340, y: 260 });
    expect(canvasStore.getSelectedEntityIds()).toEqual(new Set(["one.png"]));
    expect(animateTo).not.toHaveBeenCalled();
  });

  test("multiple file drop centers the combined bounds on the provided point", async () => {
    vi.spyOn(mediaLoader, "loadMediaFile")
      .mockResolvedValueOnce(makeEntityInput({ width: 100, height: 80 }))
      .mockResolvedValueOnce(makeEntityInput({ width: 220, height: 160 }));

    const { addEntity, added } = createAddEntityRecorder();

    await addFilesToCanvas(
      [makeFile("small.png"), makeFile("large.png")],
      addEntity,
      makeContainer(),
      {
        anchor: { x: 600, y: 450 },
        select: true,
        fitToView: false,
        bottomInset: 0,
      },
    );

    expect(added).toHaveLength(2);

    const minX = Math.min(...added.map(({ entity }) => entity.position.x));
    const minY = Math.min(...added.map(({ entity }) => entity.position.y));
    const maxX = Math.max(...added.map(({ entity }) => entity.position.x + entity.size.width));
    const maxY = Math.max(...added.map(({ entity }) => entity.position.y + entity.size.height));

    expect((minX + maxX) / 2).toBe(600);
    expect((minY + maxY) / 2).toBe(450);
  });

  test("fit-to-view remains opt-in", async () => {
    const stopMomentum = vi.spyOn(gameLoop, "stopMomentum");
    const animateTo = vi.spyOn(viewportAnimation, "animateTo");
    vi.spyOn(mediaLoader, "loadMediaFile").mockResolvedValue(
      makeEntityInput({ width: 100, height: 100 }),
    );
    const { addEntity } = createAddEntityRecorder();
    const container = makeContainer();

    await addFilesToCanvas([makeFile("fit.png")], addEntity, container, {
      anchor: { x: 100, y: 100 },
      select: true,
      fitToView: true,
      bottomInset: 24,
    });

    expect(stopMomentum).toHaveBeenCalled();
    expect(animateTo).toHaveBeenCalledTimes(1);
  });

  test("multiple dropped URLs are laid out as a group around the drop point", async () => {
    const animateTo = vi.spyOn(viewportAnimation, "animateTo");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(new Blob(["a"], { type: "image/png" }), {
            headers: { "content-type": "image/png" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(new Blob(["b"], { type: "image/png" }), {
            headers: { "content-type": "image/png" },
          }),
        ),
    );

    vi.spyOn(mediaLoader, "loadMediaFromBlob")
      .mockResolvedValueOnce(makeEntityInput({ width: 80, height: 80 }))
      .mockResolvedValueOnce(makeEntityInput({ width: 160, height: 120 }));

    const { addEntity, added } = createAddEntityRecorder();

    await addUrlsToCanvas(
      ["https://example.com/a.png", "https://example.com/b.png"],
      addEntity,
      makeContainer(),
      {
        anchor: { x: 320, y: 240 },
        select: true,
        fitToView: false,
        bottomInset: 0,
      },
    );

    const minX = Math.min(...added.map(({ entity }) => entity.position.x));
    const minY = Math.min(...added.map(({ entity }) => entity.position.y));
    const maxX = Math.max(...added.map(({ entity }) => entity.position.x + entity.size.width));
    const maxY = Math.max(...added.map(({ entity }) => entity.position.y + entity.size.height));

    expect((minX + maxX) / 2).toBe(320);
    expect((minY + maxY) / 2).toBe(240);
    expect(animateTo).not.toHaveBeenCalled();
  });
});
