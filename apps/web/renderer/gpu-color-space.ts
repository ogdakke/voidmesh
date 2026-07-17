/**
 * GPU color space capability detection and context storage.
 * Probes whether the device supports Display P3 canvas output (rgba16float + display-p3).
 * Returns a frozen config used by all rendering and export subsystems.
 * Also stores the GPU context singleton for components that need direct GPU access (e.g. color picker).
 */

// ── GPU context singleton (set once by renderer at init) ─────────────

export interface GpuContext {
  readonly device: GPUDevice;
  readonly canvasFormat: GPUTextureFormat;
  readonly canvasColorSpace: PredefinedColorSpace;
}

let _gpuContext: GpuContext | null = null;

/** Set by renderer after GPU capability detection. */
export function setGpuContext(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
  canvasColorSpace: PredefinedColorSpace,
): void {
  _gpuContext = { device, canvasFormat, canvasColorSpace };
}

/** Get the GPU context set by the renderer. Returns null before init. */
export function getGpuContext(): GpuContext | null {
  return _gpuContext;
}

// ── GPU color config ─────────────────────────────────────────────────

export interface GpuColorConfig {
  /** Whether the GPU supports Display P3 canvas output */
  readonly supportsP3: boolean;
  /** Canvas format: "rgba16float" for P3, preferred format for sRGB */
  readonly canvasFormat: GPUTextureFormat;
  /** Canvas color space for context.configure() */
  readonly canvasColorSpace: PredefinedColorSpace;
  /** Intermediate texture format for shader pipeline (always rgba16float) */
  readonly intermediateFormat: GPUTextureFormat;
  /** Color space for copyExternalImageToTexture and OffscreenCanvas 2D contexts */
  readonly textureColorSpace: PredefinedColorSpace;
}

/**
 * Detect GPU Display P3 capability by probing canvas configuration.
 * Must be called after device creation. Creates a temporary OffscreenCanvas
 * to test if rgba16float + display-p3 is supported as a canvas format.
 */
export function detectGpuColorConfig(device: GPUDevice): GpuColorConfig {
  let supportsP3Canvas = false;

  try {
    const testCanvas = new OffscreenCanvas(1, 1);
    const testCtx = testCanvas.getContext("webgpu");

    if (testCtx) {
      testCtx.configure({
        device,
        format: "rgba16float",
        colorSpace: "display-p3",
        alphaMode: "premultiplied",
      });
      supportsP3Canvas = true;
      testCtx.unconfigure();
    }
  } catch {
    supportsP3Canvas = false;
  }

  if (supportsP3Canvas) {
    return Object.freeze({
      supportsP3: true,
      canvasFormat: "rgba16float",
      canvasColorSpace: "display-p3",
      intermediateFormat: "rgba16float",
      textureColorSpace: "display-p3",
    } satisfies GpuColorConfig);
  }

  return Object.freeze({
    supportsP3: false,
    canvasFormat: navigator.gpu.getPreferredCanvasFormat(),
    canvasColorSpace: "srgb",
    intermediateFormat: "rgba16float",
    textureColorSpace: "srgb",
  } satisfies GpuColorConfig);
}
