import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { CollaborationPresencePass } from "#renderer/collaboration-presence-pass.ts";
import type { RemotePeerPresence } from "#engine";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("CollaborationPresencePass", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, COPY_DST: 2, UNIFORM: 4 });
    vi.stubGlobal("GPUTextureUsage", {
      TEXTURE_BINDING: 1,
      COPY_DST: 2,
      RENDER_ATTACHMENT: 4,
    });
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        readonly context = {
          beginPath() {},
          clearRect() {},
          closePath() {},
          fill() {},
          fillText() {},
          font: "",
          measureText: () => ({ width: 70 }),
          moveTo() {},
          lineTo() {},
          restore() {},
          roundRect() {},
          save() {},
          shadowBlur: 0,
          shadowColor: "",
          stroke() {},
          strokeStyle: "",
          fillStyle: "",
          lineWidth: 0,
          textBaseline: "alphabetic",
        };

        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }

        getContext() {
          return this.context;
        }
      },
    );
  });

  afterAll(() => vi.unstubAllGlobals());

  test("reuses selection geometry and cursor textures across cursor-only frames", () => {
    const { device, copyExternalImageToTexture, createTexture, writeBuffer } = createDevice();
    const pass = new CollaborationPresencePass(device, "bgra8unorm", {} as GPUBuffer);
    const entity = createTestEntity({ id: "selected" });
    const presence: RemotePeerPresence = {
      peerId: "peer",
      name: "Dithered Texel",
      color: [1, 0, 0, 1],
      cursor: { x: 10, y: 20 },
      selectedEntityIds: [entity.id],
    };
    const selectionOptions = {
      presences: [presence],
      entities: [entity],
      entityIndices: new Map([[entity.id, 0]]),
      presenceSelectionVersion: 1,
      entityVersion: 1,
      geometryVersion: 1,
      viewport: { offset: { x: 0, y: 0 }, zoom: 1 },
      devicePixelRatio: 2,
    };

    pass.prepareSelections(selectionOptions);
    pass.prepareSelections(selectionOptions);
    expect(writeBuffer).toHaveBeenCalledTimes(1);

    const { encoder } = createEncoder();
    const encodeOptions = {
      encoder,
      targetView: {} as GPUTextureView,
      presences: [presence],
      viewport: selectionOptions.viewport,
      devicePixelRatio: 2,
    };
    pass.encode(encodeOptions);
    presence.cursor = { x: 30, y: 40 };
    pass.encode(encodeOptions);

    expect(createTexture).toHaveBeenCalledOnce();
    expect(createTexture).toHaveBeenCalledWith(expect.objectContaining({ usage: 7 }));
    expect(copyExternalImageToTexture).toHaveBeenCalledOnce();
    expect(writeBuffer).toHaveBeenCalledTimes(3);
    pass.destroy();
  });
});

function createDevice() {
  const writeBuffer = vi.fn<GPUQueue["writeBuffer"]>();
  const copyExternalImageToTexture = vi.fn<GPUQueue["copyExternalImageToTexture"]>();
  const createTexture = vi.fn<GPUDevice["createTexture"]>(
    () =>
      ({
        createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
        destroy: vi.fn<GPUTexture["destroy"]>(),
      }) as unknown as GPUTexture,
  );
  const device = {
    queue: { writeBuffer, copyExternalImageToTexture },
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createBuffer: vi.fn<GPUDevice["createBuffer"]>(
      () => ({ destroy: vi.fn<GPUBuffer["destroy"]>() }) as unknown as GPUBuffer,
    ),
    createTexture,
  } as unknown as GPUDevice;
  return { device, copyExternalImageToTexture, createTexture, writeBuffer };
}

function createEncoder() {
  const renderPass = {
    setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
    setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
    setVertexBuffer: vi.fn<GPURenderPassEncoder["setVertexBuffer"]>(),
    draw: vi.fn<GPURenderPassEncoder["draw"]>(),
    end: vi.fn<GPURenderPassEncoder["end"]>(),
  } as unknown as GPURenderPassEncoder;
  const encoder = {
    beginRenderPass: vi.fn<GPUCommandEncoder["beginRenderPass"]>(() => renderPass),
  } as unknown as GPUCommandEncoder;
  return { encoder, renderPass };
}
