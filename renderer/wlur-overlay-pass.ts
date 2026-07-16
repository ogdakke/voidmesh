import { WlurPass } from "#wlur";
import { CopyPass } from "./copy-pass.ts";
import {
  resolveWlurOverlayRuntimeConfig,
  type ResolvedWlurOverlayConfig,
  type WlurOverlayConfig,
} from "./wlur-overlay.ts";

interface WlurOverlayPassOptions {
  device: GPUDevice;
  canvasFormat: GPUTextureFormat;
  intermediateFormat: GPUTextureFormat;
}

interface EncodeWlurOverlayOptions {
  encoder: GPUCommandEncoder;
  sourceTexture: GPUTexture;
  targetTexture: GPUTexture;
  targetView: GPUTextureView;
  width: number;
  height: number;
  devicePixelRatio: number;
  contentDirty: boolean;
}

export class WlurOverlayPass {
  readonly #device: GPUDevice;
  readonly #canvasFormat: GPUTextureFormat;
  readonly #intermediateFormat: GPUTextureFormat;
  readonly #wlurPass: WlurPass;
  readonly #sourceCopyPass: CopyPass;
  readonly #presentCopyPass: CopyPass;

  #config: WlurOverlayConfig | null = null;
  #textures: {
    width: number;
    height: number;
    input: GPUTexture | null;
    output: GPUTexture;
  } | null = null;
  #cacheValid = false;
  #cacheKey = "";
  #lastQualityKey = "";

  constructor(options: WlurOverlayPassOptions) {
    this.#device = options.device;
    this.#canvasFormat = options.canvasFormat;
    this.#intermediateFormat = options.intermediateFormat;
    this.#sourceCopyPass = new CopyPass(this.#device, this.#intermediateFormat);
    this.#presentCopyPass = new CopyPass(this.#device, this.#canvasFormat);
    this.#wlurPass = new WlurPass({
      device: this.#device,
      format: this.#intermediateFormat,
      label: "Wlur",
    });
    this.#wlurPass.initialize();
  }

  setConfig(config: WlurOverlayConfig | null): void {
    this.#config = config;
    this.#lastQualityKey = "";
    if (config?.quality) {
      this.#wlurPass.updateConfig({ quality: config.quality });
    } else if (!config) {
      this.#destroyTextures();
    }
    this.invalidateCache();
  }

  invalidateCache(): void {
    this.#cacheValid = false;
    this.#cacheKey = "";
  }

  encode(options: EncodeWlurOverlayOptions): boolean {
    const resolvedConfig = resolveWlurOverlayRuntimeConfig(
      this.#config,
      options.height,
      options.devicePixelRatio,
    );
    if (!resolvedConfig) {
      this.invalidateCache();
      return false;
    }

    const textures = this.#getOrCreateTextures(options.width, options.height);
    const cacheKey = this.#buildCacheKey(options.width, options.height, resolvedConfig);
    const needsUpdate =
      !resolvedConfig.cache ||
      !this.#cacheValid ||
      this.#cacheKey !== cacheKey ||
      options.contentDirty;

    const qualityKey = [
      resolvedConfig.quality.kernelSize,
      resolvedConfig.quality.resolutionScale,
    ].join("|");
    if (qualityKey !== this.#lastQualityKey) {
      this.#wlurPass.updateConfig({ quality: resolvedConfig.quality });
      this.#lastQualityKey = qualityKey;
    }

    if (needsUpdate) {
      let wlurSource = options.sourceTexture;
      if (this.#canvasFormat !== this.#intermediateFormat) {
        if (!textures.input) {
          throw new Error("Wlur format conversion texture is unavailable");
        }
        this.#sourceCopyPass.encode(options.encoder, options.sourceTexture, textures.input);
        wlurSource = textures.input;
      }

      // Matching formats sample the texture-bindable canvas directly before
      // the later present copy writes back to that canvas texture.
      this.#wlurPass.encode(
        options.encoder,
        wlurSource,
        textures.output,
        options.width,
        options.height,
        resolvedConfig.params,
      );

      if (resolvedConfig.cache) {
        this.#cacheValid = true;
        this.#cacheKey = cacheKey;
      } else {
        this.invalidateCache();
      }
    }

    if (this.#canvasFormat === this.#intermediateFormat) {
      options.encoder.copyTextureToTexture(
        { texture: textures.output },
        { texture: options.targetTexture },
        { width: options.width, height: options.height },
      );
    } else {
      this.#presentCopyPass.encode(options.encoder, textures.output, options.targetView);
    }

    return true;
  }

  destroy(): void {
    this.#wlurPass.destroy();
    this.#config = null;
    this.#lastQualityKey = "";
    this.#destroyTextures();
    this.invalidateCache();
  }

  #destroyTextures(): void {
    if (!this.#textures) return;

    this.#textures.input?.destroy();
    this.#textures.output.destroy();
    this.#textures = null;
  }

  #getOrCreateTextures(
    width: number,
    height: number,
  ): { input: GPUTexture | null; output: GPUTexture } {
    const cached = this.#textures;
    if (cached && cached.width === width && cached.height === height) {
      return cached;
    }

    this.#destroyTextures();
    this.invalidateCache();

    const input =
      this.#canvasFormat === this.#intermediateFormat
        ? null
        : this.#device.createTexture({
            label: `Wlur format conversion (${width}x${height})`,
            size: [width, height],
            format: this.#intermediateFormat,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
          });

    const output = this.#device.createTexture({
      label: `Wlur output (${width}x${height})`,
      size: [width, height],
      format: this.#intermediateFormat,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC,
    });

    this.#textures = { width, height, input, output };
    return this.#textures;
  }

  #buildCacheKey(width: number, height: number, resolvedConfig: ResolvedWlurOverlayConfig): string {
    const { params, quality } = resolvedConfig;
    return [
      width,
      height,
      quality.kernelSize,
      quality.resolutionScale,
      params.radius,
      params.offset,
      params.interpolation,
      params.direction,
      params.noise,
      params.curve?.join(",") ?? "",
      params.mixCurve?.join(",") ?? "",
      params.tint?.color.join(",") ?? "",
      params.tint?.amount ?? "",
      params.tint?.curve?.join(",") ?? "",
    ].join("|");
  }
}
