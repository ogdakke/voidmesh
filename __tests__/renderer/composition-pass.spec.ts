import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { releaseImageAsset } from "#lib/media-assets.ts";
import { CompositionPass, type PrepareCompositionItemOptions } from "#renderer/composition-pass.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("CompositionPass draw item reuse", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
  });

  afterAll(() => vi.unstubAllGlobals());

  test("mutates one stable draw item across cached bind-group updates", () => {
    const uniformBuffer = { destroy: vi.fn<() => void>() } as unknown as GPUBuffer;
    const device = {
      queue: { writeBuffer: vi.fn<GPUQueue["writeBuffer"]>() },
      createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
      createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
        () => ({}) as GPUBindGroupLayout,
      ),
      createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
      createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(
        () => ({}) as GPUPipelineLayout,
      ),
      createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(
        () => ({}) as GPURenderPipeline,
      ),
      createBuffer: vi.fn<GPUDevice["createBuffer"]>(() => uniformBuffer),
      createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
    } as unknown as GPUDevice;
    const pass = new CompositionPass({
      device,
      format: "bgra8unorm",
      viewportUniformBuffer: {} as GPUBuffer,
    });
    const entity = createTestEntity({ id: "stable-draw-item" });
    const texture = {
      createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
    } as unknown as GPUTexture;
    const options: PrepareCompositionItemOptions = {
      entity,
      source: { kind: "texture", texture },
      isHovered: false,
      isSelected: false,
      debugMode: false,
      positionOffsetX: 0,
      positionOffsetY: 0,
      visualScale: 1,
    };

    const first = pass.prepareDrawItem(options);
    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    options.positionOffsetX = 12;
    const moved = pass.prepareDrawItem(options);
    expect(moved).toBe(first);
    expect(moved.offsetX).toBe(12);
    expect(device.createBindGroup).toHaveBeenCalledOnce();
    expect(device.queue.writeBuffer).toHaveBeenCalledTimes(2);

    options.isSelected = true;
    const selected = pass.prepareDrawItem(options);
    expect(selected).toBe(first);
    expect(selected.isSelected).toBe(true);
    expect(device.createBindGroup).toHaveBeenCalledOnce();
    expect(device.queue.writeBuffer).toHaveBeenCalledTimes(3);

    pass.prepareDrawItem(options);
    expect(device.queue.writeBuffer).toHaveBeenCalledTimes(3);

    pass.destroy();
    expect(uniformBuffer.destroy).toHaveBeenCalledOnce();
    if (entity.mediaSource.type === "image") releaseImageAsset(entity.mediaSource.asset);
  });
});
