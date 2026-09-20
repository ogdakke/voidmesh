import {
  getWlurSourceDependencyRegion,
  WlurPass,
  type WlurEncodeOptions,
  type WlurPixelRegion,
} from "#wlur";
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
  blurDirtyMask: number;
  blurDirtyRegion?: WlurPixelRegion | null;
}

export const WLUR_BLUR_DIRTY_GLOBAL = 1 << 0;
export const WLUR_BLUR_DIRTY_ANIMATED = 1 << 1;
export const WLUR_BLUR_DIRTY_ACTION = 1 << 2;
export const WLUR_BLUR_DIRTY_DRAG = 1 << 3;
export const WLUR_BLUR_DIRTY_AUXILIARY = 1 << 4;
export const WLUR_BLUR_DIRTY_LENS = 1 << 5;
export const WLUR_BLUR_DIRTY_DISINTEGRATION = 1 << 6;
export const WLUR_BLUR_DIRTY_LABEL = 1 << 7;
export const WLUR_BLUR_DIRTY_CALLOUT = 1 << 8;
export const WLUR_BLUR_DIRTY_SELECTION = 1 << 9;

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
  blurPixels: number;
  fullBlurPixels: number;
  globalInvalidations: number;
  animatedInvalidations: number;
  actionInvalidations: number;
  dragInvalidations: number;
  auxiliaryInvalidations: number;
  lensInvalidations: number;
  disintegrationInvalidations: number;
  labelInvalidations: number;
  calloutInvalidations: number;
  selectionInvalidations: number;
  cacheInvalidations: number;
  partialBlurRefreshes: number;
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
  #globalInvalidations = 0;
  #animatedInvalidations = 0;
  #actionInvalidations = 0;
  #dragInvalidations = 0;
  #auxiliaryInvalidations = 0;
  #lensInvalidations = 0;
  #disintegrationInvalidations = 0;
  #labelInvalidations = 0;
  #calloutInvalidations = 0;
  #selectionInvalidations = 0;
  #cacheInvalidations = 0;
  #partialBlurRefreshes = 0;

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

  getSourceDependencyRegion(
    width: number,
    height: number,
    devicePixelRatio: number,
    paddingPx = 0,
  ): WlurPixelRegion | null {
    const config = resolveWlurOverlayRuntimeConfig(this.#config, height, devicePixelRatio);
    if (!config) return null;

    const region = getWlurSourceDependencyRegion(width, height, config.params, config.quality);
    const x = Math.max(0, region.x - paddingPx);
    const y = Math.max(0, region.y - paddingPx);
    const right = Math.min(width, region.x + region.width + paddingPx);
    const bottom = Math.min(height, region.y + region.height + paddingPx);
    return { x, y, width: right - x, height: bottom - y };
  }

  invalidateCache(): void {
    if (this.#cacheValid) this.#cacheInvalidations++;
    this.#cacheValid = false;
    this.#cacheKey = "";
  }

  getStats(): WlurOverlayPassStats {
    const passStats = this.#wlurPass.getStats();
    return {
      blurRefreshes: this.#blurRefreshes,
      blurReuses: this.#blurReuses,
      composites: this.#composites,
      directPresents: this.#directPresents,
      convertedPresents: this.#convertedPresents,
      blurPixels: passStats.blurPixels,
      fullBlurPixels: passStats.fullBlurPixels,
      globalInvalidations: this.#globalInvalidations,
      animatedInvalidations: this.#animatedInvalidations,
      actionInvalidations: this.#actionInvalidations,
      dragInvalidations: this.#dragInvalidations,
      auxiliaryInvalidations: this.#auxiliaryInvalidations,
      lensInvalidations: this.#lensInvalidations,
      disintegrationInvalidations: this.#disintegrationInvalidations,
      labelInvalidations: this.#labelInvalidations,
      calloutInvalidations: this.#calloutInvalidations,
      selectionInvalidations: this.#selectionInvalidations,
      cacheInvalidations: this.#cacheInvalidations,
      partialBlurRefreshes: this.#partialBlurRefreshes,
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
    const cacheChanged = !this.#cacheValid || this.#cacheKey !== cacheKey;
    const refreshBlur = !resolvedConfig.cache || cacheChanged || options.blurDirtyMask !== 0;
    const partialDirtyMask = WLUR_BLUR_DIRTY_ACTION | WLUR_BLUR_DIRTY_DRAG;
    const partialBlurRegion =
      refreshBlur &&
      resolvedConfig.cache &&
      this.#cacheValid &&
      !cacheChanged &&
      options.blurDirtyRegion &&
      (options.blurDirtyMask & ~partialDirtyMask) === 0
        ? options.blurDirtyRegion
        : undefined;
    const needsComposite =
      directPresentation || !resolvedConfig.cache || cacheChanged || options.contentDirty;

    if (needsComposite) {
      if ((options.blurDirtyMask & WLUR_BLUR_DIRTY_GLOBAL) !== 0) this.#globalInvalidations++;
      if ((options.blurDirtyMask & WLUR_BLUR_DIRTY_ANIMATED) !== 0) this.#animatedInvalidations++;
      if ((options.blurDirtyMask & WLUR_BLUR_DIRTY_ACTION) !== 0) this.#actionInvalidations++;
      if ((options.blurDirtyMask & WLUR_BLUR_DIRTY_DRAG) !== 0) this.#dragInvalidations++;
      if ((options.blurDirtyMask & WLUR_BLUR_DIRTY_AUXILIARY) !== 0) this.#auxiliaryInvalidations++;
      if ((options.blurDirtyMask & WLUR_BLUR_DIRTY_LENS) !== 0) this.#lensInvalidations++;
      if ((options.blurDirtyMask & WLUR_BLUR_DIRTY_DISINTEGRATION) !== 0)
        this.#disintegrationInvalidations++;
      if ((options.blurDirtyMask & WLUR_BLUR_DIRTY_LABEL) !== 0) this.#labelInvalidations++;
      if ((options.blurDirtyMask & WLUR_BLUR_DIRTY_CALLOUT) !== 0) this.#calloutInvalidations++;
      if ((options.blurDirtyMask & WLUR_BLUR_DIRTY_SELECTION) !== 0) this.#selectionInvalidations++;
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
        if (!this.#cacheValid || options.contentDirty) {
          this.#sourceCopyPass.encode(options.encoder, options.sourceTexture, textures.input);
        }
        wlurSource = textures.input;
        wlurOutput = textures.output;
      }

      const wlurEncodeOptions: WlurEncodeOptions = directPresentation
        ? { outputView: options.targetView, refreshBlur }
        : { refreshBlur };
      if (partialBlurRegion) wlurEncodeOptions.refreshRegion = partialBlurRegion;
      this.#wlurPass.encode(
        options.encoder,
        wlurSource,
        wlurOutput,
        options.width,
        options.height,
        resolvedConfig.params,
        wlurEncodeOptions,
      );
      if (refreshBlur) {
        this.#blurRefreshes++;
        if (partialBlurRegion) this.#partialBlurRefreshes++;
      } else this.#blurReuses++;
      this.#composites++;

      if (resolvedConfig.cache) {
        this.#cacheValid = true;
        this.#cacheKey = cacheKey;
      } else {
        this.invalidateCache();
      }
    } else this.#blurReuses++;

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
