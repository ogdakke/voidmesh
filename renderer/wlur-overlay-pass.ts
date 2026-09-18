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

export interface WlurSceneTarget {
  texture: GPUTexture;
  view: GPUTextureView;
}

export interface WlurOverlayPassStats {
  blurRefreshes: number;
  blurReuses: number;
  composites: number;
  directPresents: number;
  convertedPresents: number;
}

interface WlurOverlayTextures {
  width: number;
  height: number;
  sceneTarget: WlurSceneTarget | null;
  input: GPUTexture | null;
  output: GPUTexture | null;
}

export class WlurOverlayPass {
  readonly #device: GPUDevice;
  readonly #canvasFormat: GPUTextureFormat;
  readonly #intermediateFormat: GPUTextureFormat;
  readonly #wlurPass: WlurPass;
  readonly #sourceCopyPass: CopyPass;
  readonly #presentCopyPass: CopyPass;

  #config: WlurOverlayConfig | null = null;
  #textures: WlurOverlayTextures | null = null;
  #cacheValid = false;
  #cacheKey = "";
  #lastQualityKey = "";
  #blurRefreshes = 0;
  #blurReuses = 0;
  #composites = 0;
  #directPresents = 0;
  #convertedPresents = 0;

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

  getSceneTarget(width: number, height: number, devicePixelRatio: number): WlurSceneTarget | null {
    const config = resolveWlurOverlayRuntimeConfig(this.#config, height, devicePixelRatio);
    if (!config || this.#canvasFormat !== this.#intermediateFormat) return null;
    const textures = this.#getOrCreateTextures(width, height);
    if (!textures.sceneTarget) {
      throw new Error("Wlur direct scene target is unavailable");
    }
    return textures.sceneTarget;
  }

  invalidateCache(): void {
    this.#cacheValid = false;
    this.#cacheKey = "";
  }

  getStats(): WlurOverlayPassStats {
    return {
      blurRefreshes: this.#blurRefreshes,
      blurReuses: this.#blurReuses,
      composites: this.#composites,
      directPresents: this.#directPresents,
      convertedPresents: this.#convertedPresents,
    };
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

    const qualityKey = [
      resolvedConfig.quality.kernelSize,
      resolvedConfig.quality.resolutionScale,
    ].join("|");
    if (qualityKey !== this.#lastQualityKey) {
      this.#wlurPass.updateConfig({ quality: resolvedConfig.quality });
      this.#lastQualityKey = qualityKey;
    }

    const textures = this.#getOrCreateTextures(options.width, options.height);
    const cacheKey = this.#buildCacheKey(options.width, options.height, resolvedConfig);
    const directPresentation = this.#canvasFormat === this.#intermediateFormat;
    const needsUpdate =
      directPresentation ||
      !resolvedConfig.cache ||
      !this.#cacheValid ||
      this.#cacheKey !== cacheKey ||
      options.contentDirty;

    if (needsUpdate) {
      let wlurSource = options.sourceTexture;
      let wlurOutput = options.targetTexture;
      if (directPresentation) {
        if (wlurSource !== textures.sceneTarget?.texture) {
          throw new Error("Wlur direct presentation requires its renderer-owned scene target");
        }
      } else {
        if (!textures.input || !textures.output) {
          throw new Error("Wlur format conversion textures are unavailable");
        }
        this.#sourceCopyPass.encode(options.encoder, options.sourceTexture, textures.input);
        wlurSource = textures.input;
        wlurOutput = textures.output;
      }

      this.#wlurPass.encode(
        options.encoder,
        wlurSource,
        wlurOutput,
        options.width,
        options.height,
        resolvedConfig.params,
        directPresentation ? { outputView: options.targetView } : {},
      );
      this.#blurRefreshes++;
      this.#composites++;

      if (resolvedConfig.cache) {
        this.#cacheValid = true;
        this.#cacheKey = cacheKey;
      } else {
        this.invalidateCache();
      }
    } else {
      this.#blurReuses++;
    }

    if (directPresentation) {
      this.#directPresents++;
    } else {
      this.#presentCopyPass.encode(options.encoder, textures.output!, options.targetView);
      this.#convertedPresents++;
    }

    return true;
  }

  destroy(): void {
    this.#wlurPass.destroy();
    this.#sourceCopyPass.destroy();
    this.#presentCopyPass.destroy();
    this.#config = null;
    this.#lastQualityKey = "";
    this.#destroyTextures();
    this.invalidateCache();
  }

  #destroyTextures(): void {
    if (!this.#textures) return;

    this.#textures.sceneTarget?.texture.destroy();
    this.#textures.input?.destroy();
    this.#textures.output?.destroy();
    this.#textures = null;
  }

  #getOrCreateTextures(width: number, height: number): WlurOverlayTextures {
    const cached = this.#textures;
    if (cached && cached.width === width && cached.height === height) {
      return cached;
    }

    this.#destroyTextures();
    this.invalidateCache();

    const directPresentation = this.#canvasFormat === this.#intermediateFormat;
    const sceneTexture = directPresentation
      ? this.#device.createTexture({
          label: `Wlur scene (${width}x${height})`,
          size: [width, height],
          format: this.#intermediateFormat,
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.COPY_SRC,
        })
      : null;
    const sceneTarget = sceneTexture
      ? { texture: sceneTexture, view: sceneTexture.createView() }
      : null;
    const input = directPresentation
      ? null
      : this.#device.createTexture({
          label: `Wlur format conversion (${width}x${height})`,
          size: [width, height],
          format: this.#intermediateFormat,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
    const output = directPresentation
      ? null
      : this.#device.createTexture({
          label: `Wlur output (${width}x${height})`,
          size: [width, height],
          format: this.#intermediateFormat,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });

    this.#textures = {
      width,
      height,
      sceneTarget,
      input,
      output,
    };
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
