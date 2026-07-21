import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ExportService, type ApplyShaderFn } from "#renderer/export-service.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

const uploadExternalImageToTexture = vi.hoisted(() =>
  vi.fn<
    (
      device: GPUDevice,
      source: ImageBitmapSource,
      texture: GPUTexture,
      width: number,
      height: number,
      colorConfig: unknown,
    ) => void
  >(),
);
const readRgba8TextureToPixels = vi.hoisted(() =>
  vi.fn<
    (
      device: GPUDevice,
      texture: GPUTexture,
      options: { width: number; height: number },
    ) => Promise<Uint8ClampedArray>
  >(
    async (_device, _texture, options) => new Uint8ClampedArray(options.width * options.height * 4),
  ),
);

vi.mock("#renderer/gpu-texture-io.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("#renderer/gpu-texture-io.ts")>();
  return {
    ...original,
    uploadExternalImageToTexture,
    readRgba8TextureToPixels,
  };
});

describe("ExportService native source rendering", () => {
  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1, VERTEX: 2 });
    vi.stubGlobal("GPUTextureUsage", {
      TEXTURE_BINDING: 1,
      COPY_DST: 2,
      RENDER_ATTACHMENT: 4,
      COPY_SRC: 8,
    });
    vi.stubGlobal(
      "ImageData",
      class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          readonly width: number,
          readonly height: number,
        ) {}

        getContext() {
          return { putImageData: vi.fn<(imageData: ImageData, dx: number, dy: number) => void>() };
        }

        async convertToBlob() {
          return new Blob(["export"], { type: "image/png" });
        }
      },
    );
  });

  afterAll(() => vi.unstubAllGlobals());

  test("renders from source at the requested native dimensions", async () => {
    const textures: GPUTexture[] = [];
    const device = createDevice(textures);
    const applyShader = vi.fn<ApplyShaderFn>();
    const service = new ExportService(device, null, applyShader, {
      supportsP3: false,
      canvasFormat: "bgra8unorm",
      canvasColorSpace: "srgb",
      intermediateFormat: "rgba16float",
      textureColorSpace: "srgb",
    });
    const entity = createTestEntity({ size: { width: 800, height: 600 } });
    if (entity.mediaSource.type !== "image") throw new Error("Expected image entity");

    await service.renderSourceToBlob(
      entity,
      entity.mediaSource.asset.imageBitmap,
      entity.originalSize.width,
      entity.originalSize.height,
    );

    expect(uploadExternalImageToTexture).toHaveBeenCalledWith(
      device,
      entity.mediaSource.asset.imageBitmap,
      textures[0],
      800,
      600,
      expect.any(Object),
    );
    expect(device.createTexture).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Export output texture", size: [800, 600] }),
    );
    expect(applyShader).toHaveBeenCalledWith(entity, textures[0], textures[1]);
  });
});

function createTexture(width = 800, height = 600): GPUTexture {
  return {
    width,
    height,
    createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
    destroy: vi.fn<() => void>(),
  } as unknown as GPUTexture;
}

function createDevice(textures: GPUTexture[]): GPUDevice {
  return {
    queue: {
      submit: vi.fn<GPUQueue["submit"]>(),
    },
    createSampler: vi.fn<GPUDevice["createSampler"]>(() => ({}) as GPUSampler),
    createBindGroupLayout: vi.fn<GPUDevice["createBindGroupLayout"]>(
      () => ({}) as GPUBindGroupLayout,
    ),
    createShaderModule: vi.fn<GPUDevice["createShaderModule"]>(() => ({}) as GPUShaderModule),
    createPipelineLayout: vi.fn<GPUDevice["createPipelineLayout"]>(() => ({}) as GPUPipelineLayout),
    createRenderPipeline: vi.fn<GPUDevice["createRenderPipeline"]>(() => ({}) as GPURenderPipeline),
    createBindGroup: vi.fn<GPUDevice["createBindGroup"]>(() => ({}) as GPUBindGroup),
    createCommandEncoder: vi.fn<GPUDevice["createCommandEncoder"]>(
      () =>
        ({
          beginRenderPass: vi.fn<GPUCommandEncoder["beginRenderPass"]>(
            () =>
              ({
                setPipeline: vi.fn<GPURenderPassEncoder["setPipeline"]>(),
                setBindGroup: vi.fn<GPURenderPassEncoder["setBindGroup"]>(),
                draw: vi.fn<GPURenderPassEncoder["draw"]>(),
                end: vi.fn<GPURenderPassEncoder["end"]>(),
              }) as unknown as GPURenderPassEncoder,
          ),
          finish: vi.fn<GPUCommandEncoder["finish"]>(() => ({}) as GPUCommandBuffer),
        }) as unknown as GPUCommandEncoder,
    ),
    createTexture: vi.fn<GPUDevice["createTexture"]>((descriptor) => {
      const [width, height] = descriptor.size as [number, number];
      const texture = createTexture(width, height);
      textures.push(texture);
      return texture;
    }),
  } as unknown as GPUDevice;
}
