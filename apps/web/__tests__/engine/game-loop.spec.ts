import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import { AnimationScheduler } from "#lib/animation-scheduler.ts";
import { screenToWorld } from "#lib/canvas-math.ts";
import { GameLoop, SpacePanMode, type GameLoopDeps } from "#engine";
import { canvasStore } from "#engine";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { createTestEntity } from "../helpers/test-entity.ts";
import { createMockGameLoopDeps } from "../helpers/game-loop-deps.mock.ts";
import type { Point } from "#types/canvas.ts";
import type { InfiniteCanvasRenderer } from "#renderer/canvas-renderer.ts";
import { logger } from "#lib/client.logger.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

const CONTAINER_WIDTH = 800;
const CONTAINER_HEIGHT = 600;

function createMockContainer(): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => new DOMRect(0, 0, CONTAINER_WIDTH, CONTAINER_HEIGHT);
  Object.defineProperty(el, "clientWidth", { value: CONTAINER_WIDTH });
  Object.defineProperty(el, "clientHeight", { value: CONTAINER_HEIGHT });
  return el;
}

function createGameLoop(deps: GameLoopDeps): GameLoop {
  const gl = new GameLoop(deps);
  gl.setContainer(createMockContainer());
  return gl;
}

/**
 * Add an entity at a known world position.
 * With default viewport (offset 0, zoom 1, DPR 1, container at 0,0),
 * screen coords === world coords, so the entity is hit-testable at (x, y).
 */
function addEntity(
  x: number,
  y: number,
  width = 200,
  height = 150,
  opts: { id?: string; locked?: boolean; zIndex?: number } = {},
): string {
  const entity = createTestEntity({
    id: opts.id,
    position: { x, y },
    size: { width, height },
    locked: opts.locked,
    zIndex: opts.zIndex,
  });
  canvasStore.addEntity(entity);
  return entity.id;
}

/** Simulate a complete click (pointer down + up at same position) */
function click(gl: GameLoop, point: Point, shiftKey = false): void {
  gl.handlePointerDown(point, shiftKey);
  gl.handlePointerUp(point);
}

function getViewportValues() {
  const viewport = canvasStore.getViewport();
  return {
    offset: { x: viewport.offset.x, y: viewport.offset.y },
    zoom: viewport.zoom,
  };
}

function createLoopRenderer(isEntityVisible = true): InfiniteCanvasRenderer {
  return {
    isReady: true,
    device: null,
    colorConfig: { canvasFormat: "rgba8unorm", canvasColorSpace: "srgb" },
    render: vi.fn<() => void>(),
    getFrameStats: vi.fn<() => object>(),
    hasPendingRenderWork: vi.fn<() => boolean>(() => false),
    needsContinuousRenderForEntity: vi.fn<() => boolean>(() => false),
    isEntityVisible: vi.fn<() => boolean>(() => isEntityVisible),
  } as unknown as InfiniteCanvasRenderer;
}

// ── Setup ───────────────────────────────────────────────────────────────────

let gl: GameLoop;
let deps: GameLoopDeps;
let cleanupCanvas: () => void;

beforeEach(() => {
  cleanupCanvas = setupCanvasTest();
  canvasStore.setViewport({ offset: { x: 0, y: 0 }, zoom: 1 });
  deps = createMockGameLoopDeps(new AnimationScheduler());
  gl = createGameLoop(deps);
  Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
});

afterEach(() => {
  cleanupCanvas();
  vi.restoreAllMocks();
});

describe("Render loop errors", () => {
  test("reports render errors and keeps the animation loop alive", () => {
    const error = new Error("render boom");
    const renderErrorHandler = vi.fn<(error: unknown) => void>();
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const renderer = createLoopRenderer();
    vi.mocked(renderer.render).mockImplementation(() => {
      throw error;
    });

    gl.setRenderer(renderer);
    gl.setRenderErrorHandler(renderErrorHandler);

    expect(() => gl.start()).not.toThrow();
    expect(renderErrorHandler).toHaveBeenCalledWith(error);
    expect(loggerError).toHaveBeenCalledWith("[GameLoop] Render failed", error);
    expect(deps.perf.onRender).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalled();
  });

  test("does not log handled render errors", () => {
    const error = new Error("expected render failure");
    const renderErrorHandler = vi.fn<(error: unknown) => boolean>(() => true);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const renderer = createLoopRenderer();
    vi.mocked(renderer.render).mockImplementation(() => {
      throw error;
    });

    gl.setRenderer(renderer);
    gl.setRenderErrorHandler(renderErrorHandler);

    expect(() => gl.start()).not.toThrow();
    expect(renderErrorHandler).toHaveBeenCalledWith(error);
    expect(loggerError).not.toHaveBeenCalled();
  });
});

describe("Animated media render scheduling", () => {
  test("limits physical video playback while preserving the logical mobile workload", async () => {
    const mobileLoop = new GameLoop(deps, {
      maxActiveVideoElements: 4,
      minActiveVideoScreenEdge: 0,
    });
    mobileLoop.setContainer(createMockContainer());
    const renderer = createLoopRenderer(true);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const entities = Array.from({ length: 43 }, (_, index) => {
      const entity = createTestEntity({ id: `mobile-video-${index}`, mediaType: "video" });
      if (entity.mediaSource.type !== "video" || !entity.playback) {
        throw new Error("Expected a video test entity");
      }
      entity.playback.isPlaying = true;
      entity.playback.loop = true;
      return entity;
    });
    await Promise.all(
      entities.map((entity) =>
        entity.mediaSource.type === "video" ? entity.mediaSource.videoElement.play() : undefined,
      ),
    );
    canvasStore.addEntities(entities);

    mobileLoop.setRenderer(renderer);
    mobileLoop.start();

    const activeVideoCount = entities.filter(
      (entity) => entity.mediaSource.type === "video" && !entity.mediaSource.videoElement.paused,
    ).length;
    expect(activeVideoCount).toBe(4);
    expect(entities.every((entity) => entity.playback?.isPlaying === true)).toBe(true);
    mobileLoop.stop();
  });

  test("incrementally reclassifies bulk entity edits without a fixed count cutoff", () => {
    const renderer = createLoopRenderer();
    let nextFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const entities = Array.from({ length: 40 }, (_, index) =>
      createTestEntity({ id: `classification-${index}` }),
    );
    canvasStore.addEntities(entities);

    gl.setRenderer(renderer);
    gl.start();
    vi.mocked(renderer.needsContinuousRenderForEntity).mockClear();
    canvasStore.updateEntities(
      entities.slice(0, 33).map((entity) => ({
        id: entity.id,
        updates: { name: `${entity.name} changed` },
      })),
    );
    if (!nextFrame) throw new Error("Expected frame loop to schedule another frame");
    (nextFrame as FrameRequestCallback)(performance.now());

    expect(renderer.needsContinuousRenderForEntity).toHaveBeenCalledTimes(33);
  });

  test("does not keep rendering for an offscreen playing GIF", () => {
    const renderer = createLoopRenderer(false);
    let nextFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(250);
    const entity = createTestEntity({ mediaType: "gif", gifDuration: 1, gifFrameCount: 10 });
    if (entity.playback) entity.playback.isPlaying = true;
    canvasStore.addEntity(entity);
    canvasStore.clearDirtyFlags();

    gl.setRenderer(renderer);
    gl.start();
    if (!nextFrame) throw new Error("Expected frame loop to schedule another frame");
    (nextFrame as FrameRequestCallback)(250);

    expect(renderer.render).toHaveBeenCalledOnce();
  });

  test("renders a playing GIF frame when the entity is visible", () => {
    const renderer = createLoopRenderer(true);
    let nextFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(250);
    const entity = createTestEntity({ mediaType: "gif", gifDuration: 1, gifFrameCount: 10 });
    if (entity.playback) entity.playback.isPlaying = true;
    canvasStore.addEntity(entity);
    canvasStore.clearDirtyFlags();

    gl.setRenderer(renderer);
    gl.start();
    if (!nextFrame) throw new Error("Expected frame loop to schedule another frame");
    (nextFrame as FrameRequestCallback)(250);

    expect(renderer.render).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Desktop Pointer Interactions
// ═══════════════════════════════════════════════════════════════════════════

describe("Desktop pointer interactions", () => {
  describe("read-only access", () => {
    test("allows selection without moving entities", () => {
      const id = addEntity(100, 100);
      gl.setReadOnly(true);

      gl.handlePointerDown({ x: 150, y: 150 });
      gl.handlePointerMove({ x: 250, y: 250 });
      gl.processInput();
      gl.handlePointerUp({ x: 250, y: 250 });

      expect(canvasStore.getSelectedEntityIds().has(id)).toBe(true);
      expect(canvasStore.getState().entities.get(id)?.position).toEqual({ x: 100, y: 100 });
    });

    test("cancels an in-progress transient drag when access becomes read-only", () => {
      const id = addEntity(100, 100);
      gl.handlePointerDown({ x: 150, y: 150 });
      gl.handlePointerMove({ x: 250, y: 250 });
      gl.processInput();

      gl.setReadOnly(true);
      gl.handlePointerUp({ x: 250, y: 250 });

      expect(canvasStore.getState().entities.get(id)?.position).toEqual({ x: 100, y: 100 });
      expect(canvasStore.getTransientEntityDragOffset()).toEqual({ x: 0, y: 0 });
    });

    test("does not toggle playback when clicking an already-selected entity", () => {
      const entity = createTestEntity({
        id: "read-only-gif",
        mediaType: "gif",
        position: { x: 100, y: 100 },
      });
      canvasStore.addEntity(entity);
      canvasStore.replaceSelection([entity.id]);
      gl.setReadOnly(true);

      click(gl, { x: 150, y: 150 });

      expect(canvasStore.getState().entities.get(entity.id)?.playback?.isPlaying).toBe(false);
    });
  });

  describe("Click to select", () => {
    test("passive pointer movement does not hit-test entities", () => {
      addEntity(100, 100);
      const spatialQuery = vi.spyOn(canvasStore, "queryEntitiesInBounds");

      gl.handlePointerMove({ x: 150, y: 150 });
      gl.processInput();

      expect(spatialQuery).not.toHaveBeenCalled();
    });

    test("click on entity selects it", () => {
      const id = addEntity(100, 100);
      click(gl, { x: 150, y: 150 });
      expect(canvasStore.getSelectedEntityIds().has(id)).toBe(true);
    });

    test("click on already-selected entity keeps it selected", () => {
      const id = addEntity(100, 100);
      click(gl, { x: 150, y: 150 });
      click(gl, { x: 150, y: 150 });
      expect(canvasStore.getSelectedEntityIds().has(id)).toBe(true);
      expect(canvasStore.getSelectedEntityIds().size).toBe(1);
    });

    test("click on empty space clears selection", () => {
      const id = addEntity(100, 100);
      click(gl, { x: 150, y: 150 });
      expect(canvasStore.getSelectedEntityIds().has(id)).toBe(true);
      click(gl, { x: 500, y: 500 });
      expect(canvasStore.getSelectedEntityIds().size).toBe(0);
    });

    test("click on entity replaces existing multi-selection", () => {
      const id1 = addEntity(100, 100);
      const id2 = addEntity(400, 100);

      click(gl, { x: 150, y: 150 });
      click(gl, { x: 450, y: 150 }, true);
      expect(canvasStore.getSelectedEntityIds().size).toBe(2);

      click(gl, { x: 150, y: 150 });
      expect(canvasStore.getSelectedEntityIds().size).toBe(1);
      expect(canvasStore.getSelectedEntityIds().has(id1)).toBe(true);
      expect(canvasStore.getSelectedEntityIds().has(id2)).toBe(false);
    });

    test("click on overlapping entities selects highest z-index entity", () => {
      const backId = addEntity(100, 100, 200, 150, { zIndex: 1 });
      const frontId = addEntity(100, 100, 200, 150, { zIndex: 10 });

      click(gl, { x: 150, y: 150 });

      expect(canvasStore.getSelectedEntityIds().has(frontId)).toBe(true);
      expect(canvasStore.getSelectedEntityIds().has(backId)).toBe(false);
    });

    test("click on transparent top entity cell selects entity behind it", () => {
      const backId = addEntity(100, 100, 200, 150, { zIndex: 1 });
      const frontId = addEntity(100, 100, 200, 150, { zIndex: 10 });
      const front = canvasStore.getState().entities.get(frontId);
      if (!front || front.mediaSource.type !== "image") throw new Error("Expected image entity");
      front.mediaSource.asset.alphaHitGrid = {
        width: 2,
        height: 2,
        cellSize: 1,
        cols: 2,
        rows: 2,
        cells: new Uint8Array([0, 1, 1, 1]),
        hasTransparentCells: true,
        hasOpaqueCells: true,
      };

      click(gl, { x: 125, y: 125 });

      expect(canvasStore.getSelectedEntityIds().has(backId)).toBe(true);
      expect(canvasStore.getSelectedEntityIds().has(frontId)).toBe(false);
    });

    test("click on a selected entity's transparent cell clears selection", () => {
      const id = addEntity(100, 100, 200, 150);
      const entity = canvasStore.getState().entities.get(id);
      if (!entity || entity.mediaSource.type !== "image") throw new Error("Expected image entity");
      entity.mediaSource.asset.alphaHitGrid = {
        width: 2,
        height: 2,
        cellSize: 1,
        cols: 2,
        rows: 2,
        cells: new Uint8Array([0, 1, 1, 1]),
        hasTransparentCells: true,
        hasOpaqueCells: true,
      };
      canvasStore.replaceSelection([id]);

      click(gl, { x: 125, y: 125 });

      expect(canvasStore.getSelectedEntityIds().size).toBe(0);
    });

    test("click on opaque top entity cell selects top entity", () => {
      const backId = addEntity(100, 100, 200, 150, { zIndex: 1 });
      const frontId = addEntity(100, 100, 200, 150, { zIndex: 10 });
      const front = canvasStore.getState().entities.get(frontId);
      if (!front || front.mediaSource.type !== "image") throw new Error("Expected image entity");
      front.mediaSource.asset.alphaHitGrid = {
        width: 2,
        height: 2,
        cellSize: 1,
        cols: 2,
        rows: 2,
        cells: new Uint8Array([0, 1, 1, 1]),
        hasTransparentCells: true,
        hasOpaqueCells: true,
      };

      click(gl, { x: 250, y: 125 });

      expect(canvasStore.getSelectedEntityIds().has(frontId)).toBe(true);
      expect(canvasStore.getSelectedEntityIds().has(backId)).toBe(false);
    });

    test("click on overlapping entities ignores locked topmost entity", () => {
      const unlockedId = addEntity(100, 100, 200, 150, { zIndex: 10 });
      const lockedId = addEntity(100, 100, 200, 150, { locked: true, zIndex: 20 });

      click(gl, { x: 150, y: 150 });

      expect(canvasStore.getSelectedEntityIds().has(unlockedId)).toBe(true);
      expect(canvasStore.getSelectedEntityIds().has(lockedId)).toBe(false);
    });
  });

  describe("Shift+click", () => {
    test("shift+click on unselected entity adds to selection", () => {
      const id1 = addEntity(100, 100);
      const id2 = addEntity(400, 100);

      click(gl, { x: 150, y: 150 });
      click(gl, { x: 450, y: 150 }, true);
      expect(canvasStore.getSelectedEntityIds().has(id1)).toBe(true);
      expect(canvasStore.getSelectedEntityIds().has(id2)).toBe(true);
    });

    test("shift+click on selected entity removes from selection", () => {
      const id1 = addEntity(100, 100);
      const id2 = addEntity(400, 100);

      click(gl, { x: 150, y: 150 });
      click(gl, { x: 450, y: 150 }, true);
      expect(canvasStore.getSelectedEntityIds().size).toBe(2);

      click(gl, { x: 150, y: 150 }, true);
      expect(canvasStore.getSelectedEntityIds().has(id1)).toBe(false);
      expect(canvasStore.getSelectedEntityIds().has(id2)).toBe(true);
    });
  });

  describe("Entity drag", () => {
    test("short click does NOT trigger drag (stays as click)", () => {
      const id = addEntity(100, 100);

      gl.handlePointerDown({ x: 150, y: 150 });
      gl.handlePointerMove({ x: 151, y: 151 });
      gl.handlePointerUp({ x: 151, y: 151 });

      expect(canvasStore.getSelectedEntityIds().has(id)).toBe(true);
    });

    test("pointer down on entity starts possible drag visual", () => {
      addEntity(100, 100);
      gl.handlePointerDown({ x: 150, y: 150 });
      expect(deps.dragVisual.startPossibleDrag).toHaveBeenCalled();
    });

    test("pointer up releases drag visual", () => {
      addEntity(100, 100);
      gl.handlePointerDown({ x: 150, y: 150 });
      gl.handlePointerUp({ x: 150, y: 150 });
      expect(deps.dragVisual.release).toHaveBeenCalled();
    });

    test("keeps a small multi-selection drag transient until pointer up", () => {
      const firstId = addEntity(100, 100);
      const secondId = addEntity(400, 100);
      click(gl, { x: 150, y: 150 });
      click(gl, { x: 450, y: 150 }, true);
      const first = canvasStore.getState().entities.get(firstId)!;
      const second = canvasStore.getState().entities.get(secondId)!;

      gl.handlePointerDown({ x: 150, y: 150 });
      gl.handlePointerMove({ x: 170, y: 140 });
      gl.processInput();

      expect(first.position).toEqual({ x: 100, y: 100 });
      expect(second.position).toEqual({ x: 400, y: 100 });
      expect(canvasStore.getTransientEntityDragOffset()).toEqual({ x: 20, y: -10 });

      gl.handlePointerUp({ x: 170, y: 140 });

      expect(first.position).toEqual({ x: 120, y: 90 });
      expect(second.position).toEqual({ x: 420, y: 90 });
      expect(canvasStore.getTransientEntityDragOffset()).toEqual({ x: 0, y: 0 });
    });
  });

  describe("Drag-select rectangle", () => {
    test("drag on empty space creates drag-select bounds", () => {
      addEntity(100, 100, 100, 100);

      gl.handlePointerDown({ x: 500, y: 500 });
      gl.handlePointerMove({ x: 600, y: 600 });
      gl.processInput();

      const bounds = gl.getDragSelectBounds();
      expect(bounds).not.toBeNull();
      expect(bounds?.width).toBe(100);
      expect(bounds?.height).toBe(100);
    });

    test("drag-select clears when pointer up", () => {
      gl.handlePointerDown({ x: 500, y: 500 });
      gl.handlePointerMove({ x: 600, y: 600 });
      expect(gl.getDragSelectBounds()).not.toBeNull();

      gl.handlePointerUp({ x: 600, y: 600 });
      expect(gl.getDragSelectBounds()).toBeNull();
    });

    test("drag-select in replace mode clears previous selection", () => {
      const id1 = addEntity(100, 100, 100, 100);
      click(gl, { x: 150, y: 150 });
      expect(canvasStore.getSelectedEntityIds().has(id1)).toBe(true);

      gl.handlePointerDown({ x: 500, y: 500 });
      expect(canvasStore.getSelectedEntityIds().size).toBe(0);
    });

    test("coalesces drag-selection queries to one per processed frame", () => {
      addEntity(100, 100, 100, 100);
      const query = vi.spyOn(canvasStore, "queryEntitiesInBoundsUnordered");

      gl.handlePointerDown({ x: 500, y: 500 });
      const versionAfterPointerDown = canvasStore.getState().version;
      gl.handlePointerMove({ x: 450, y: 450 });
      gl.handlePointerMove({ x: 300, y: 300 });
      gl.handlePointerMove({ x: 50, y: 50 });

      expect(query).not.toHaveBeenCalled();
      gl.processInput();
      expect(query).toHaveBeenCalledTimes(1);
      expect(canvasStore.getSelectedEntityIds().size).toBe(1);
      expect(canvasStore.getState().version).toBe(versionAfterPointerDown);

      gl.handlePointerUp({ x: 50, y: 50 });
      expect(canvasStore.getState().version).toBe(versionAfterPointerDown + 1);
    });

    test("shift+drag with existing selection uses subtractive mode", () => {
      addEntity(100, 100, 100, 100);
      click(gl, { x: 150, y: 150 });
      expect(canvasStore.getSelectedEntityIds().size).toBe(1);

      gl.handlePointerDown({ x: 500, y: 500 }, true);
      expect(gl.getDragSelectMode()).toBe("subtractive");
      gl.handlePointerUp({ x: 600, y: 600 });
    });
  });

  test("multi-selection bounds do not materialize a selected-entity array", () => {
    const first = addEntity(100, 100, 100, 100);
    const second = addEntity(300, 100, 100, 100);
    canvasStore.replaceSelection([first, second]);
    const materialize = vi.spyOn(canvasStore, "getSelectedEntities");
    const entityLookup = vi.spyOn(canvasStore.getState().entities, "get");

    expect(gl.getMultiSelectBounds()).toEqual({ x: 100, y: 100, width: 300, height: 100 });
    canvasStore.panBy({ x: 50, y: 50 });
    expect(gl.getMultiSelectBounds()).toEqual({ x: 100, y: 100, width: 300, height: 100 });
    expect(materialize).not.toHaveBeenCalled();
    expect(entityLookup).toHaveBeenCalledTimes(2);

    canvasStore.moveEntity(first, { x: 10, y: 0 });
    expect(gl.getMultiSelectBounds()).toEqual({ x: 110, y: 100, width: 290, height: 100 });
    expect(entityLookup).toHaveBeenCalledTimes(5);
  });

  describe("Click on multi-selection", () => {
    test("click on entity in multi-selection collapses to single on pointerUp", () => {
      const id1 = addEntity(100, 100);
      addEntity(400, 100);

      click(gl, { x: 150, y: 150 });
      click(gl, { x: 450, y: 150 }, true);
      expect(canvasStore.getSelectedEntityIds().size).toBe(2);

      click(gl, { x: 150, y: 150 });
      expect(canvasStore.getSelectedEntityIds().size).toBe(1);
      expect(canvasStore.getSelectedEntityIds().has(id1)).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Wheel Zoom/Pan
// ═══════════════════════════════════════════════════════════════════════════

describe("Wheel zoom/pan", () => {
  test("wheel without ctrlKey pans viewport", () => {
    const before = getViewportValues();
    gl.handleWheel(50, 30, { x: 400, y: 300 }, false);
    const after = canvasStore.getViewport();

    expect(after.offset.x).toBeGreaterThan(before.offset.x);
    expect(after.offset.y).toBeGreaterThan(before.offset.y);
    expect(after.zoom).toBe(before.zoom);
  });

  test("wheel with ctrlKey zooms viewport", () => {
    const before = getViewportValues();
    gl.handleWheel(0, -10, { x: 400, y: 300 }, true);
    const after = canvasStore.getViewport();

    expect(after.zoom).toBeGreaterThan(before.zoom);
  });

  test("ctrl+wheel zooms toward mouse position", () => {
    const mousePoint = { x: 200, y: 150 };
    const worldBefore = { x: mousePoint.x, y: mousePoint.y };

    gl.handleWheel(0, -10, mousePoint, true);

    const v = canvasStore.getViewport();
    const rect = new DOMRect(0, 0, CONTAINER_WIDTH, CONTAINER_HEIGHT);
    const worldAfter = screenToWorld(mousePoint, v, rect, 1);

    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 1);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 1);
  });

  test("wheel cancels active viewport animation", () => {
    gl.handleWheel(10, 10, { x: 400, y: 300 }, false);
    expect(deps.viewportAnimation.cancel).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Space+Drag Pan
// ═══════════════════════════════════════════════════════════════════════════

describe("Space+drag pan", () => {
  test("setSpaceHeld(true) sets spacePanMode to ready", () => {
    gl.setSpaceHeld(true);
    expect(gl.spacePanMode).toBe(SpacePanMode.ready);
  });

  test("setSpaceHeld(false) resets to idle", () => {
    gl.setSpaceHeld(true);
    gl.setSpaceHeld(false);
    expect(gl.spacePanMode).toBe(SpacePanMode.idle);
  });

  test("pointer down in ready mode transitions to panning and pans viewport", () => {
    gl.setSpaceHeld(true);
    const before = getViewportValues();
    gl.handlePointerDown({ x: 400, y: 300 });
    expect(gl.spacePanMode).toBe(SpacePanMode.panning);

    gl.handlePointerMove({ x: 350, y: 250 });
    const after = canvasStore.getViewport();
    expect(after.offset.x).not.toBe(before.offset.x);
    expect(after.offset.y).not.toBe(before.offset.y);
  });

  test("pointer up in panning transitions to panned", () => {
    gl.setSpaceHeld(true);
    gl.handlePointerDown({ x: 400, y: 300 });
    gl.handlePointerUp({ x: 350, y: 250 });
    expect(gl.spacePanMode).toBe(SpacePanMode.panned);
  });

  test("space+drag does not select entities", () => {
    addEntity(100, 100);
    gl.setSpaceHeld(true);
    gl.handlePointerDown({ x: 150, y: 150 });
    gl.handlePointerUp({ x: 150, y: 150 });

    expect(canvasStore.getSelectedEntityIds().size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Touch Tap Detection
// ═══════════════════════════════════════════════════════════════════════════

describe("Touch tap detection", () => {
  test("tap on entity selects it", () => {
    const id = addEntity(100, 100);

    gl.handleTouchStart([{ x: 150, y: 150 }]);
    gl.handleTouchEnd([], false);

    expect(canvasStore.getSelectedEntityIds().has(id)).toBe(true);
  });

  test("tap on empty space clears selection", () => {
    const id = addEntity(100, 100);
    gl.handleTouchStart([{ x: 150, y: 150 }]);
    gl.handleTouchEnd([], false);
    expect(canvasStore.getSelectedEntityIds().has(id)).toBe(true);

    gl.handleTouchStart([{ x: 500, y: 500 }]);
    gl.handleTouchEnd([], false);
    expect(canvasStore.getSelectedEntityIds().size).toBe(0);
  });

  test("double-tap on entity triggers zoom-to-fit", () => {
    addEntity(100, 100);

    gl.handleTouchStart([{ x: 150, y: 150 }]);
    gl.handleTouchEnd([], false);

    gl.handleTouchStart([{ x: 150, y: 150 }]);
    gl.handleTouchEnd([], false);

    expect(deps.viewportAnimation.animateTo).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Touch Single-Finger Pan
// ═══════════════════════════════════════════════════════════════════════════

describe("Single-finger pan", () => {
  test("touch pan moves viewport", () => {
    const before = getViewportValues();

    gl.handleTouchStart([{ x: 400, y: 300 }]);
    gl.handleTouchMove([{ x: 350, y: 250 }]);

    const after = canvasStore.getViewport();
    expect(after.offset.x).toBeGreaterThan(before.offset.x);
    expect(after.offset.y).toBeGreaterThan(before.offset.y);
  });

  test("swipe triggers momentum on touchEnd", () => {
    const before = getViewportValues();

    gl.handleTouchStart([{ x: 400, y: 300 }]);
    gl.handleTouchMove([{ x: 350, y: 300 }]);
    gl.handleTouchMove([{ x: 300, y: 300 }]);
    gl.handleTouchMove([{ x: 200, y: 300 }]);
    gl.handleTouchEnd([], false);

    // Pan happened during the swipe itself
    const after = canvasStore.getViewport();
    expect(after.offset.x).not.toBe(before.offset.x);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pinch-to-Zoom
// ═══════════════════════════════════════════════════════════════════════════

describe("Pinch-to-zoom", () => {
  test("two-finger pinch changes zoom", () => {
    const before = canvasStore.getViewport();
    expect(before.zoom).toBe(1);

    gl.handleTouchStart([
      { x: 350, y: 300 },
      { x: 450, y: 300 },
    ]);
    gl.handleTouchMove([
      { x: 300, y: 300 },
      { x: 500, y: 300 },
    ]);

    const after = canvasStore.getViewport();
    expect(after.zoom).toBe(2);
  });

  test("pinch zooms toward center between fingers", () => {
    const center = { x: 400, y: 300 };

    gl.handleTouchStart([
      { x: center.x - 50, y: center.y },
      { x: center.x + 50, y: center.y },
    ]);
    gl.handleTouchMove([
      { x: center.x - 100, y: center.y },
      { x: center.x + 100, y: center.y },
    ]);

    const v = canvasStore.getViewport();
    const rect = new DOMRect(0, 0, CONTAINER_WIDTH, CONTAINER_HEIGHT);
    const worldAfter = screenToWorld(center, v, rect, 1);
    expect(worldAfter.x).toBeCloseTo(center.x, 1);
    expect(worldAfter.y).toBeCloseTo(center.y, 1);
  });

  test("second finger cancels long-press timer", () => {
    vi.useFakeTimers();
    addEntity(100, 100);

    // Single finger starts long-press timer
    gl.handleTouchStart([{ x: 150, y: 150 }]);

    // Second finger should cancel it
    gl.handleTouchStart([
      { x: 150, y: 150 },
      { x: 300, y: 300 },
    ]);

    // Advance past long-press delay — should NOT activate
    const longPressDelay = gl.getTouchConfig().longPressDelay;
    vi.advanceTimersByTime(longPressDelay + 10);
    expect(deps.actionLayer.activate).not.toHaveBeenCalled();

    gl.handleTouchEnd([], false);
    vi.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Context Menu
// ═══════════════════════════════════════════════════════════════════════════

describe("Context menu", () => {
  test("right-click on entity selects it", () => {
    const id = addEntity(100, 100);
    gl.handleContextMenu({ x: 150, y: 150 });
    expect(canvasStore.getSelectedEntityIds().has(id)).toBe(true);
  });

  test("right-click on selected entity in multi-selection preserves selection", () => {
    const id1 = addEntity(100, 100);
    const id2 = addEntity(400, 100);

    click(gl, { x: 150, y: 150 });
    click(gl, { x: 450, y: 150 }, true);
    expect(canvasStore.getSelectedEntityIds().size).toBe(2);

    gl.handleContextMenu({ x: 150, y: 150 });
    expect(canvasStore.getSelectedEntityIds().size).toBe(2);
    expect(canvasStore.getSelectedEntityIds().has(id1)).toBe(true);
    expect(canvasStore.getSelectedEntityIds().has(id2)).toBe(true);
  });

  test("right-click on empty space clears selection", () => {
    addEntity(100, 100);
    click(gl, { x: 150, y: 150 });
    expect(canvasStore.getSelectedEntityIds().size).toBe(1);

    gl.handleContextMenu({ x: 500, y: 500 });
    expect(canvasStore.getSelectedEntityIds().size).toBe(0);
  });

  test("handleContextMenuClose resets context flag", () => {
    addEntity(100, 100);
    gl.handleContextMenu({ x: 150, y: 150 });
    gl.handleContextMenuClose();

    click(gl, { x: 500, y: 500 });
    expect(canvasStore.getSelectedEntityIds().size).toBe(0);
  });

  test("right-click cancels drag visual from preceding pointerDown", () => {
    addEntity(100, 100);

    // pointerDown starts possible drag visual
    gl.handlePointerDown({ x: 150, y: 150 });
    expect(deps.dragVisual.startPossibleDrag).toHaveBeenCalled();

    // Context menu should cancel drag visual
    gl.handleContextMenu({ x: 150, y: 150 });
    expect(deps.dragVisual.cancel).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Long-Press and Action Layer (requires fake timers)
// ═══════════════════════════════════════════════════════════════════════════

describe("Long-press and action layer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("long-press on entity activates action layer after delay", () => {
    addEntity(100, 100);

    gl.handleTouchStart([{ x: 150, y: 150 }]);

    const longPressDelay = gl.getTouchConfig().longPressDelay;
    vi.advanceTimersByTime(longPressDelay + 10);

    expect(deps.actionLayer.activate).toHaveBeenCalled();
  });

  test("finger movement beyond threshold cancels long-press", () => {
    addEntity(100, 100);

    gl.handleTouchStart([{ x: 150, y: 150 }]);

    const moveThreshold = gl.getTouchConfig().longPressMoveThreshold;
    gl.handleTouchMove([{ x: 150 + moveThreshold + 5, y: 150 }]);

    const longPressDelay = gl.getTouchConfig().longPressDelay;
    vi.advanceTimersByTime(longPressDelay + 10);

    expect(deps.actionLayer.activate).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Multi-Touch Gesture Transitions
// ═══════════════════════════════════════════════════════════════════════════

describe("Multi-touch gesture transitions", () => {
  test("pan → pinch zoom → pan: remaining finger continues panning after zoom", () => {
    const before = getViewportValues();

    // Phase 1: single finger pan
    gl.handleTouchStart([{ x: 400, y: 300 }]);
    gl.handleTouchMove([{ x: 350, y: 250 }]);
    const afterPan1 = canvasStore.getViewport();
    expect(afterPan1.offset.x).not.toBe(before.offset.x);
    expect(afterPan1.offset.y).not.toBe(before.offset.y);

    // Phase 2: add second finger → pinch zoom
    gl.handleTouchStart([
      { x: 350, y: 250 },
      { x: 450, y: 250 },
    ]);
    const zoomBefore = canvasStore.getViewport().zoom;
    gl.handleTouchMove([
      { x: 300, y: 250 },
      { x: 500, y: 250 },
    ]);
    const afterZoom = canvasStore.getViewport();
    expect(afterZoom.zoom).toBeGreaterThan(zoomBefore);

    // Phase 3: lift second finger → back to single-finger pan
    gl.handleTouchEnd([{ x: 300, y: 250 }]);
    const afterLift = getViewportValues();

    // Move the remaining finger further
    gl.handleTouchMove([{ x: 250, y: 200 }]);
    const afterPan2 = canvasStore.getViewport();
    expect(afterPan2.offset.x).not.toBe(afterLift.offset.x);
    expect(afterPan2.offset.y).not.toBe(afterLift.offset.y);

    gl.handleTouchEnd([], false);
  });

  test("entity drag → pinch zoom → entity drag: remaining finger continues moving entity", () => {
    vi.useFakeTimers();
    const id = addEntity(100, 100);

    // Phase 1: long-press to trigger action layer
    gl.handleTouchStart([{ x: 150, y: 150 }]);
    const longPressDelay = gl.getTouchConfig().longPressDelay;
    vi.advanceTimersByTime(longPressDelay + 10);
    // Action layer should now be active
    expect(deps.actionLayer.activate).toHaveBeenCalled();

    // Drag beyond safe zone to transition from action layer to entity drag
    const safeZoneRadius = 120;
    gl.handleTouchMove([{ x: 150 + safeZoneRadius + 20, y: 150 }]);
    expect(deps.actionLayer.transitionToDrag).toHaveBeenCalled();

    // Phase 2: add second finger for pinch zoom
    gl.handleTouchStart([
      { x: 150 + safeZoneRadius + 20, y: 150 },
      { x: 400, y: 300 },
    ]);
    const zoomBefore = canvasStore.getViewport().zoom;

    // Pinch outward
    gl.handleTouchMove([
      { x: 100, y: 150 },
      { x: 500, y: 300 },
    ]);
    const afterZoom = canvasStore.getViewport();
    expect(afterZoom.zoom).not.toBe(zoomBefore);

    // Phase 3: lift second finger — remaining finger should continue entity drag
    gl.handleTouchEnd([{ x: 100, y: 150 }]);

    // Move remaining finger — the effective transient position should move without
    // committing geometry until the gesture ends.
    const entityBefore = canvasStore.getState().entities.get(id);
    const offsetBefore = canvasStore.getTransientEntityDragOffset();
    const effectiveXBefore = (entityBefore?.position.x ?? 0) + offsetBefore.x;
    gl.handleTouchMove([{ x: 50, y: 150 }]);
    const entityAfter = canvasStore.getState().entities.get(id);
    const offsetAfter = canvasStore.getTransientEntityDragOffset();
    const effectiveXAfter = (entityAfter?.position.x ?? 0) + offsetAfter.x;
    expect(entityAfter?.position.x).toBe(entityBefore?.position.x);
    expect(effectiveXAfter).not.toBe(effectiveXBefore);

    gl.handleTouchEnd([], false);
    expect(canvasStore.getState().entities.get(id)?.position.x).toBe(effectiveXAfter);
    vi.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Action Layer + Second Finger
// ═══════════════════════════════════════════════════════════════════════════

describe("Action layer cancellation on second finger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("second finger cancels action layer and allows zoom", () => {
    addEntity(100, 100);

    // Long-press to activate action layer
    gl.handleTouchStart([{ x: 150, y: 150 }]);
    const longPressDelay = gl.getTouchConfig().longPressDelay;
    vi.advanceTimersByTime(longPressDelay + 10);
    expect(deps.actionLayer.activate).toHaveBeenCalled();

    // Add second finger — should cancel action layer
    gl.handleTouchStart([
      { x: 150, y: 150 },
      { x: 400, y: 300 },
    ]);
    expect(deps.actionLayer.cancel).toHaveBeenCalled();

    // Pinch should work
    const zoomBefore = canvasStore.getViewport().zoom;
    gl.handleTouchMove([
      { x: 100, y: 150 },
      { x: 500, y: 300 },
    ]);
    const afterZoom = canvasStore.getViewport();
    expect(afterZoom.zoom).not.toBe(zoomBefore);

    gl.handleTouchEnd([], false);
  });

  test("second finger cancels drag visual when action layer is active", () => {
    addEntity(100, 100);

    // Long-press to activate action layer (which also activates drag visual)
    gl.handleTouchStart([{ x: 150, y: 150 }]);
    const longPressDelay = gl.getTouchConfig().longPressDelay;
    vi.advanceTimersByTime(longPressDelay + 10);
    expect(deps.dragVisual.activateDrag).toHaveBeenCalled();

    // Add second finger — drag visual should be cancelled
    gl.handleTouchStart([
      { x: 150, y: 150 },
      { x: 400, y: 300 },
    ]);
    expect(deps.dragVisual.cancel).toHaveBeenCalled();

    gl.handleTouchEnd([], false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Locked Entities
// ═══════════════════════════════════════════════════════════════════════════

describe("Locked entities", () => {
  test("click on locked entity does not select it", () => {
    addEntity(100, 100, 200, 150, { locked: true });
    click(gl, { x: 150, y: 150 });
    expect(canvasStore.getSelectedEntityIds().size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Start/Stop
// ═══════════════════════════════════════════════════════════════════════════

describe("Start/stop", () => {
  test("isTouchActive returns false when no touches active", () => {
    expect(gl.isTouchActive()).toBe(false);
  });

  test("stopMomentum does not throw when no momentum active", () => {
    expect(() => gl.stopMomentum()).not.toThrow();
  });
});
