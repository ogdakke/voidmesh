import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExportEntitySnapshot } from "#renderer/export-snapshot.ts";
import { ShaderType } from "#types/canvas.ts";

const runtime = vi.hoisted(() => ({
  beginFrame: vi.fn<() => void>(),
  encode: vi.fn<() => void>(),
  endFrame: vi.fn<() => void>(),
  flushTextureReleases: vi.fn<() => void>(),
}));

vi.mock("#renderer/entity-shader-runtime.ts", () => ({
  EntityShaderRuntime: class {
    initialize = vi.fn<() => Promise<void>>(async () => {});
    beginFrame = runtime.beginFrame;
    encode = runtime.encode;
    endFrame = runtime.endFrame;
    flushTextureReleases = runtime.flushTextureReleases;
    destroy = vi.fn<() => void>();
  },
}));

vi.mock("#renderer/copy-pass.ts", () => ({
  CopyPass: class {
    encode = vi.fn<() => void>();
  },
}));

const { HeadlessExportRenderer } = await import("#renderer/headless-export-renderer.ts");

describe("HeadlessExportRenderer", () => {
  const sourceTexture = createTexture();
  const outputTexture = createTexture();
  const currentTexture = createTexture();
  const encoder = {
    finish: vi.fn<GPUCommandEncoder["finish"]>(() => ({}) as GPUCommandBuffer),
  } as unknown as GPUCommandEncoder;
  const device = {
    queue: {
      copyExternalImageToTexture: vi.fn<GPUQueue["copyExternalImageToTexture"]>(),
      onSubmittedWorkDone: vi.fn<GPUQueue["onSubmittedWorkDone"]>(async () => {}),
      submit: vi.fn<GPUQueue["submit"]>(),
    },
    createCommandEncoder: vi.fn<GPUDevice["createCommandEncoder"]>(() => encoder),
    createTexture: vi
      .fn<GPUDevice["createTexture"]>()
      .mockReturnValueOnce(sourceTexture)
      .mockReturnValue(outputTexture),
  } as unknown as GPUDevice;
  const context = {
    configure: vi.fn<GPUCanvasContext["configure"]>(),
    getCurrentTexture: vi.fn<GPUCanvasContext["getCurrentTexture"]>(() => currentTexture),
    unconfigure: vi.fn<GPUCanvasContext["unconfigure"]>(),
  } as unknown as GPUCanvasContext;

  beforeAll(() => {
    vi.stubGlobal("GPUShaderStage", { FRAGMENT: 1, VERTEX: 2 });
    vi.stubGlobal("GPUTextureUsage", {
      TEXTURE_BINDING: 1,
      COPY_DST: 2,
      COPY_SRC: 4,
      RENDER_ATTACHMENT: 8,
    });
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;

        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }

        getContext(kind: string) {
          if (kind === "webgpu") return context;
          return {
            clearRect: vi.fn<OffscreenCanvasRenderingContext2D["clearRect"]>(),
            drawImage: vi.fn<OffscreenCanvasRenderingContext2D["drawImage"]>(),
            imageSmoothingEnabled: false,
            imageSmoothingQuality: "low",
          };
        }
      },
    );
    vi.stubGlobal("navigator", {
      gpu: {
        getPreferredCanvasFormat: () => "bgra8unorm",
        requestAdapter: async () => ({
          limits: {
            maxBufferSize: 268435456,
            maxStorageBufferBindingSize: 134217728,
          },
          requestDevice: async () => device,
        }),
      },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  test("resets pooled runtime resources for every exported frame", async () => {
    const renderer = await HeadlessExportRenderer.create(64, 64);
    const snapshot = {
      id: "export-entity",
      shaderType: ShaderType.dithering,
      shaderParams: { showOriginal: true },
    } as ExportEntitySnapshot;
    const source = {} as ImageBitmap;

    await renderer.renderToCanvas(snapshot, source, 64, 64);
    await renderer.renderToCanvas(snapshot, source, 64, 64);

    expect(runtime.beginFrame).toHaveBeenCalledTimes(2);
    expect(runtime.encode).toHaveBeenCalledTimes(2);
    expect(runtime.endFrame).toHaveBeenCalledTimes(2);
    expect(runtime.beginFrame.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.encode.mock.invocationCallOrder[0]!,
    );
    expect(runtime.encode.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.endFrame.mock.invocationCallOrder[0]!,
    );
    expect(runtime.beginFrame.mock.invocationCallOrder[1]).toBeLessThan(
      runtime.encode.mock.invocationCallOrder[1]!,
    );
    expect(runtime.encode.mock.invocationCallOrder[1]).toBeLessThan(
      runtime.endFrame.mock.invocationCallOrder[1]!,
    );
  });
});

function createTexture(): GPUTexture {
  return {
    createView: vi.fn<GPUTexture["createView"]>(() => ({}) as GPUTextureView),
    destroy: vi.fn<GPUTexture["destroy"]>(),
    height: 64,
    width: 64,
  } as unknown as GPUTexture;
}
