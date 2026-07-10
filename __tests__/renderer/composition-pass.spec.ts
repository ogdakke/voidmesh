import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { releaseImageAsset, retainImageAsset } from "#lib/media-assets.ts";
import {
  CompositionPass,
  type CompositionDrawItem,
  type PrepareCompositionItemOptions,
} from "#renderer/composition-pass.ts";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

describe("CompositionPass instancing", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 });
  });

  afterAll(() => vi.unstubAllGlobals());

  test("draws adjacent entities sharing one texture as one instance batch", () => {
    const { device, instanceBuffer } = createDevice();
    const pass = createPass(device);
    const firstEntity = createTestEntity({ id: "instance-first", position: { x: 10, y: 20 } });
    const secondEntity = cloneImageEntity(firstEntity, "instance-second", { x: 30, y: 40 });
    const texture = createTexture();
    const first = prepare(pass, firstEntity, texture);
    const second = prepare(pass, secondEntity, texture);
    const renderPass = createRenderPass();

    pass.drawItems(renderPass, [first, second]);

    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    expect(device.createBuffer).toHaveBeenCalledOnce();
    expect(device.createBindGroup).toHaveBeenCalledOnce();
    expect(renderPass.setPipeline).toHaveBeenCalledOnce();
    expect(renderPass.setBindGroup).toHaveBeenCalledOnce();
    expect(renderPass.draw).toHaveBeenCalledWith(6, 2, 0, 0);

    const upload = device.queue.writeBuffer.mock.calls[0]![2] as ArrayBuffer;
    const floats = new Float32Array(upload);
    expect(Array.from(floats.slice(0, 5))).toEqual([10, 20, 200, 150, 0]);
    expect(Array.from(floats.slice(8, 13))).toEqual([30, 40, 200, 150, 0]);

    pass.destroy();
    expect(instanceBuffer.destroy).toHaveBeenCalledOnce();
    releaseImageEntity(firstEntity);
    releaseImageEntity(secondEntity);
  });

  test("preserves texture and selected-label boundaries in z order", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const base = createTestEntity({ id: "batch-base" });
    const second = cloneImageEntity(base, "batch-second", { x: 10, y: 0 });
    const selected = cloneImageEntity(base, "batch-selected", { x: 20, y: 0 });
    const fourth = cloneImageEntity(base, "batch-fourth", { x: 30, y: 0 });
    const final = cloneImageEntity(base, "batch-final", { x: 40, y: 0 });
    const textureA = createTexture();
    const textureB = createTexture();
    const items: CompositionDrawItem[] = [
      prepare(pass, base, textureA),
      prepare(pass, second, textureA),
      prepare(pass, selected, textureA, true),
      prepare(pass, fourth, textureA),
      prepare(pass, final, textureB),
    ];
    const renderPass = createRenderPass();
    const afterItem = vi.fn<(item: CompositionDrawItem) => void>();

    pass.drawItems(renderPass, items, afterItem);

    expect(renderPass.draw.mock.calls).toEqual([
      [6, 2, 0, 0],
      [6, 1, 0, 2],
      [6, 1, 0, 3],
      [6, 1, 0, 4],
    ]);
    expect(afterItem).toHaveBeenCalledOnce();
    expect(afterItem).toHaveBeenCalledWith(items[2]);
    expect(device.createBindGroup).toHaveBeenCalledTimes(2);
    expect(renderPass.setPipeline).toHaveBeenCalledOnce();

    pass.destroy();
    releaseImageEntity(base);
    releaseImageEntity(second);
    releaseImageEntity(selected);
    releaseImageEntity(fourth);
    releaseImageEntity(final);
  });

  test("appends multiple render phases into disjoint instance-buffer ranges", () => {
    const { device } = createDevice();
    const pass = createPass(device);
    const base = createTestEntity({ id: "phase-base" });
    const second = cloneImageEntity(base, "phase-second", { x: 10, y: 0 });
    const actionLayer = cloneImageEntity(base, "phase-action", { x: 20, y: 0 });
    const texture = createTexture();
    const sceneItems = [prepare(pass, base, texture), prepare(pass, second, texture)];
    const actionItems = [prepare(pass, actionLayer, texture)];
    const scenePass = createRenderPass();
    const actionPass = createRenderPass();

    pass.beginFrame(3);
    pass.drawItems(scenePass, sceneItems);
    pass.drawItems(actionPass, actionItems);

    expect(device.queue.writeBuffer.mock.calls[0]![1]).toBe(0);
    expect(device.queue.writeBuffer.mock.calls[1]![1]).toBe(2 * 32);
    expect(scenePass.draw).toHaveBeenCalledWith(6, 2, 0, 0);
    expect(actionPass.draw).toHaveBeenCalledWith(6, 1, 0, 2);

    pass.destroy();
    releaseImageEntity(base);
    releaseImageEntity(second);
    releaseImageEntity(actionLayer);
  });
});

function createPass(device: GPUDevice): CompositionPass {
  return new CompositionPass({
    device,
    format: "bgra8unorm",
    viewportUniformBuffer: {} as GPUBuffer,
  });
}

function prepare(
  pass: CompositionPass,
  entity: ShaderCanvasEntity,
  texture: GPUTexture,
  isSelected = false,
): CompositionDrawItem {
  const options: PrepareCompositionItemOptions = {
    entity,
    source: { kind: "texture", texture },
    isHovered: false,
    isSelected,
    debugMode: false,
    positionOffsetX: 0,
    positionOffsetY: 0,
    visualScale: 1,
  };
  return pass.prepareDrawItem(options);
}

function cloneImageEntity(
  entity: ShaderCanvasEntity,
  id: string,
  position: { x: number; y: number },
): ShaderCanvasEntity {
  if (entity.mediaSource.type !== "image") throw new Error("Expected image entity");
  retainImageAsset(entity.mediaSource.asset);
  return {
    ...entity,
    id,
    position,
    mediaSource: { type: "image", asset: entity.mediaSource.asset },
  };
}

function releaseImageEntity(entity: ShaderCanvasEntity): void {
  if (entity.mediaSource.type !== "image") throw new Error("Expected image entity");
  releaseImageAsset(entity.mediaSource.asset);
}

function createTexture(): GPUTexture {
  return {
    createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
  } as unknown as GPUTexture;
}

function createRenderPass(): GPURenderPassEncoder & {
  setPipeline: ReturnType<typeof vi.fn<GPURenderPassEncoder["setPipeline"]>>;
  setBindGroup: ReturnType<typeof vi.fn<GPURenderPassEncoder["setBindGroup"]>>;
  draw: ReturnType<typeof vi.fn<GPURenderPassEncoder["draw"]>>;
} {
  return {
    setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
    setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
    draw: vi.fn<GPURenderPassEncoder["draw"]>(),
  } as unknown as GPURenderPassEncoder & {
    setPipeline: ReturnType<typeof vi.fn<GPURenderPassEncoder["setPipeline"]>>;
    setBindGroup: ReturnType<typeof vi.fn<GPURenderPassEncoder["setBindGroup"]>>;
    draw: ReturnType<typeof vi.fn<GPURenderPassEncoder["draw"]>>;
  };
}

function createDevice(): {
  device: GPUDevice & {
    queue: { writeBuffer: ReturnType<typeof vi.fn<GPUQueue["writeBuffer"]>> };
    createBuffer: ReturnType<typeof vi.fn<GPUDevice["createBuffer"]>>;
    createBindGroup: ReturnType<typeof vi.fn<GPUDevice["createBindGroup"]>>;
  };
  instanceBuffer: GPUBuffer & { destroy: ReturnType<typeof vi.fn<GPUBuffer["destroy"]>> };
} {
  const instanceBuffer = {
    destroy: vi.fn<GPUBuffer["destroy"]>(),
  } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn<GPUBuffer["destroy"]>> };
  const device = {
    limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024 },
    queue: { writeBuffer: vi.fn<GPUQueue["writeBuffer"]>() },
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createBuffer: vi.fn<GPUDevice["createBuffer"]>(() => instanceBuffer),
    createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
  } as unknown as GPUDevice & {
    queue: { writeBuffer: ReturnType<typeof vi.fn<GPUQueue["writeBuffer"]>> };
    createBuffer: ReturnType<typeof vi.fn<GPUDevice["createBuffer"]>>;
    createBindGroup: ReturnType<typeof vi.fn<GPUDevice["createBindGroup"]>>;
  };
  return { device, instanceBuffer };
}
