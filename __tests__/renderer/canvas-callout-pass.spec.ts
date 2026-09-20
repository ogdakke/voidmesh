import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ActionLayerRenderState, DragVisualRenderState } from "#engine";
import { CanvasCalloutPass, resolveEntityVisualBounds } from "#renderer/canvas-callout-pass.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

beforeAll(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 });
  vi.stubGlobal("devicePixelRatio", 2);
  vi.stubGlobal("OffscreenCanvas", createOffscreenCanvas());
});

afterAll(() => vi.unstubAllGlobals());

describe("resolveEntityVisualBounds", () => {
  test("tracks the action-layer spring offset in world space", () => {
    const entity = createTestEntity({
      id: "starter",
      position: { x: 100, y: 200 },
      size: { width: 80, height: 40 },
    });

    expect(
      resolveEntityVisualBounds(
        entity,
        createActionLayer({ x: 24, y: -12 }),
        createDragVisual(),
        2,
        4,
      ),
    ).toEqual({ x: 112, y: 194, width: 80, height: 40 });
  });

  test("tracks centered drag scaling and the trailing drag offset", () => {
    const entity = createTestEntity({
      id: "starter",
      position: { x: 100, y: 200 },
      size: { width: 80, height: 40 },
    });

    expect(
      resolveEntityVisualBounds(
        entity,
        createActionLayer({ x: 20, y: -10 }),
        createDragVisual({ active: true, scale: 0.75, offset: { x: 30, y: 15 } }),
        2,
        2,
      ),
    ).toEqual({ x: 160, y: 210, width: 60, height: 30 });
  });

  test("ignores transient state that does not target the anchored entity", () => {
    const entity = createTestEntity({
      id: "other",
      position: { x: 100, y: 200 },
      size: { width: 80, height: 40 },
    });

    expect(
      resolveEntityVisualBounds(
        entity,
        createActionLayer({ x: 20, y: -10 }),
        createDragVisual({ active: true, scale: 0.75, offset: { x: 30, y: 15 } }),
        2,
        2,
      ),
    ).toEqual({ x: 100, y: 200, width: 80, height: 40 });
  });
});

describe("CanvasCalloutPass", () => {
  test("allocates and uploads the complete label uniform layout", () => {
    const device = createDevice();
    const calloutPass = new CanvasCalloutPass(device, "rgba16float", {} as GPUBuffer);
    calloutPass.initialize();

    const entity = createTestEntity({ id: "starter" });
    const callout = {
      id: "delete-on-desktop",
      text: "Delete by pressing backspace",
      anchor: { type: "entity" as const, entityId: entity.id, placement: "top" as const },
    };

    calloutPass.beginFrame({ offset: { x: 0, y: 0 }, zoom: 2 }, 800);
    calloutPass.drawCallouts(
      createRenderPass(),
      [callout],
      [entity],
      new Map([[entity.id, 0]]),
      createActionLayer({ x: 0, y: 0 }),
      createDragVisual(),
    );

    expect(device.createBuffer).toHaveBeenCalledWith(expect.objectContaining({ size: 48 }));
    const writeBuffer = vi.mocked(device.queue.writeBuffer);
    const uniformData = writeBuffer.mock.calls[0]?.[2] as Float32Array;
    expect(uniformData.byteLength).toBe(48);
    expect(uniformData[6]).toBeGreaterThan(0);
    expect(uniformData[7]).toBeGreaterThan(0);

    calloutPass.destroy();
  });
});

function createActionLayer(entityOffset: { x: number; y: number }): ActionLayerRenderState {
  return {
    active: true,
    entityIds: new Set(["starter"]),
    entityOffset,
    blurIntensity: 1,
  };
}

function createDragVisual(overrides: Partial<DragVisualRenderState> = {}): DragVisualRenderState {
  return {
    active: false,
    isDragPhase: false,
    entityIds: new Set(["starter"]),
    scale: 1,
    offset: { x: 0, y: 0 },
    appliesToSelection: true,
    ...overrides,
  };
}

function createOffscreenCanvas(): typeof OffscreenCanvas {
  const context = {
    clearRect: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    roundRect: () => {},
    fill: () => {},
    stroke: () => {},
    fillText: () => {},
    measureText: (text: string) => ({ width: text.length * 8 }),
  };
  return class MockOffscreenCanvas {
    width: number;
    height: number;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }

    getContext() {
      return context;
    }
  } as unknown as typeof OffscreenCanvas;
}

function createDevice(): GPUDevice {
  return {
    queue: {
      writeBuffer: vi.fn<GPUQueue["writeBuffer"]>(),
      copyExternalImageToTexture: vi.fn<GPUQueue["copyExternalImageToTexture"]>(),
    },
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createTexture: vi.fn<GPUDevice["createTexture"]>(
      () =>
        ({
          createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
          destroy: vi.fn<GPUTexture["destroy"]>(),
        }) as unknown as GPUTexture,
    ),
    createBuffer: vi.fn<GPUDevice["createBuffer"]>(
      () =>
        ({
          destroy: vi.fn<GPUBuffer["destroy"]>(),
        }) as unknown as GPUBuffer,
    ),
    createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
  } as unknown as GPUDevice;
}

function createRenderPass(): GPURenderPassEncoder {
  return {
    setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
    setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
    draw: vi.fn<GPURenderPassEncoder["draw"]>(),
  } as unknown as GPURenderPassEncoder;
}
