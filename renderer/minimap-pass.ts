import { getRotatedAABB } from "#lib/canvas-math.ts";
import type { Bounds, MinimapConfig, ShaderCanvasEntity, Viewport } from "#types/canvas.ts";
import { CopyPass } from "./copy-pass.ts";
import minimapShaderSource from "./minimap.wgsl?raw";

interface EncodeMinimapOptions {
  encoder: GPUCommandEncoder;
  sourceTexture: GPUTexture;
  targetView: GPUTextureView;
  entities: readonly ShaderCanvasEntity[];
  selectedEntityIds: ReadonlySet<string>;
  viewport: Viewport;
  width: number;
  height: number;
  devicePixelRatio: number;
}

const DESKTOP_MINIMAP_MIN_WIDTH_CSS = 768;
const MINIMAP_MAX_ENTITIES = 512;
const MINIMAP_UNIFORM_FLOATS = 36;
const MINIMAP_ENTITY_FLOATS = 8;
const MINIMAP_CIRCLE_FIT_PADDING = 1.04;

export class MinimapPass {
  readonly #device: GPUDevice;
  readonly #format: GPUTextureFormat;
  readonly #pipeline: GPURenderPipeline;
  readonly #bindGroupLayout: GPUBindGroupLayout;
  readonly #uniformBuffer: GPUBuffer;
  readonly #entityBuffer: GPUBuffer;
  readonly #sampler: GPUSampler;
  readonly #copyPass: CopyPass;
  readonly #uniformData = new ArrayBuffer(MINIMAP_UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT);
  readonly #uniformFloats = new Float32Array(this.#uniformData);
  readonly #entityData = new Float32Array(MINIMAP_MAX_ENTITIES * MINIMAP_ENTITY_FLOATS);

  #config: MinimapConfig;
  #bindGroup: GPUBindGroup | null = null;
  #texture: {
    width: number;
    height: number;
    texture: GPUTexture;
    view: GPUTextureView;
  } | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat, initialConfig: MinimapConfig) {
    this.#device = device;
    this.#format = format;
    this.#config = { ...initialConfig };
    this.#copyPass = new CopyPass(device, format);

    const shaderModule = device.createShaderModule({
      label: "Minimap orb shader",
      code: minimapShaderSource,
    });
    this.#bindGroupLayout = device.createBindGroupLayout({
      label: "Minimap bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" },
        },
      ],
    });
    this.#uniformBuffer = device.createBuffer({
      label: "Minimap uniforms",
      size: this.#uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#entityBuffer = device.createBuffer({
      label: "Minimap entity rects",
      size: this.#entityData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#sampler = device.createSampler({
      label: "Minimap backdrop sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.#pipeline = device.createRenderPipeline({
      label: "Minimap pipeline",
      layout: device.createPipelineLayout({
        label: "Minimap pipeline layout",
        bindGroupLayouts: [this.#bindGroupLayout],
      }),
      vertex: { module: shaderModule, entryPoint: "vs_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });
  }

  setConfig(config: MinimapConfig): void {
    const backdropScaleChanged = config.backdropScale !== this.#config.backdropScale;
    this.#config = { ...config };
    if (backdropScaleChanged) this.#destroyTexture();
  }

  get config(): MinimapConfig {
    return this.#config;
  }

  encode(options: EncodeMinimapOptions): boolean {
    const { devicePixelRatio: dpr, entities, height, viewport, width } = options;
    const minimap = this.#config;
    if (!minimap.enabled || width / dpr < DESKTOP_MINIMAP_MIN_WIDTH_CSS) return false;

    const inputTexture = this.#getOrCreateTexture(width, height);
    this.#copyPass.encode(options.encoder, options.sourceTexture, inputTexture.view);

    const viewportRect: Bounds = {
      x: viewport.offset.x,
      y: viewport.offset.y,
      width: width / viewport.zoom,
      height: height / viewport.zoom,
    };
    let minX = viewportRect.x;
    let minY = viewportRect.y;
    let maxX = viewportRect.x + viewportRect.width;
    let maxY = viewportRect.y + viewportRect.height;
    for (const entity of entities) {
      const bounds = getRotatedAABB(entity.position, entity.size, entity.rotation);
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.x + bounds.width);
      maxY = Math.max(maxY, bounds.y + bounds.height);
    }

    const worldWidth = Math.max(maxX - minX, 1);
    const worldHeight = Math.max(maxY - minY, 1);
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    const aspect = Math.max(minimap.width, 1) / Math.max(minimap.height, 1);
    const paddingScale = Math.max(minimap.worldPaddingScale, 1);
    let mapWorldWidth = worldWidth * paddingScale;
    let mapWorldHeight = worldHeight * paddingScale;
    if (mapWorldWidth / mapWorldHeight > aspect) mapWorldHeight = mapWorldWidth / aspect;
    else mapWorldWidth = mapWorldHeight * aspect;

    const isCircle =
      Math.abs(minimap.width - minimap.height) < 0.001 &&
      minimap.borderRadius >= Math.min(minimap.width, minimap.height) * 0.5;
    if (isCircle) {
      const maxCornerDistance = Math.max(
        Math.hypot(minX - centerX, minY - centerY),
        Math.hypot(maxX - centerX, minY - centerY),
        Math.hypot(maxX - centerX, maxY - centerY),
        Math.hypot(minX - centerX, maxY - centerY),
      );
      const circleSafeSize = maxCornerDistance * 2 * MINIMAP_CIRCLE_FIT_PADDING;
      mapWorldWidth = Math.max(mapWorldWidth, circleSafeSize);
      mapWorldHeight = Math.max(mapWorldHeight, circleSafeSize);
    }

    const minimapWidth = minimap.width * dpr;
    const minimapHeight = minimap.height * dpr;
    const halfWidth = minimapWidth * 0.5;
    const halfHeight = minimapHeight * 0.5;
    const v = this.#uniformFloats;
    v[0] = width - minimap.margin * dpr - halfWidth;
    v[1] = height - minimap.margin * dpr - halfHeight;
    v[2] = halfWidth;
    v[3] = halfHeight;
    v[4] = centerX - mapWorldWidth * 0.5;
    v[5] = centerY - mapWorldHeight * 0.5;
    v[6] = mapWorldWidth;
    v[7] = mapWorldHeight;
    v[8] = viewportRect.x;
    v[9] = viewportRect.y;
    v[10] = viewportRect.width;
    v[11] = viewportRect.height;
    v[12] = minimap.mapTint[0];
    v[13] = minimap.mapTint[1];
    v[14] = minimap.mapTint[2];
    v[15] = minimap.mapOpacity;
    v[16] = minimap.entityColor[0];
    v[17] = minimap.entityColor[1];
    v[18] = minimap.entityColor[2];
    v[19] = minimap.entityOpacity;
    v[20] = width;
    v[21] = height;
    v[22] = minimap.strength;
    v[23] = minimap.edgeWidth;
    v[24] = minimap.falloff;
    v[25] = minimap.dispersion;
    v[26] = minimap.scale;
    v[27] = minimap.reflectionIntensity;
    v[28] = minimap.reflectionFocus;
    v[29] = minimap.occlusion;
    v[30] = minimap.vignette;
    v[31] = minimap.backdropBlur;
    v[32] = minimap.borderRadius * dpr;
    v[33] = Math.min(entities.length, MINIMAP_MAX_ENTITIES);
    v[34] = 0;
    v[35] = 0;

    const entityCount = Math.min(entities.length, MINIMAP_MAX_ENTITIES);
    for (let i = 0; i < entityCount; i++) {
      const entity = entities[i]!;
      const bounds = getRotatedAABB(entity.position, entity.size, entity.rotation);
      const base = i * MINIMAP_ENTITY_FLOATS;
      this.#entityData[base] = bounds.x;
      this.#entityData[base + 1] = bounds.y;
      this.#entityData[base + 2] = bounds.width;
      this.#entityData[base + 3] = bounds.height;
      this.#entityData[base + 4] = options.selectedEntityIds.has(entity.id) ? 1 : 0;
      this.#entityData[base + 5] = 0;
      this.#entityData[base + 6] = 0;
      this.#entityData[base + 7] = 0;
    }
    this.#device.queue.writeBuffer(this.#uniformBuffer, 0, this.#uniformData);
    if (entityCount > 0) {
      this.#device.queue.writeBuffer(
        this.#entityBuffer,
        0,
        this.#entityData,
        0,
        entityCount * MINIMAP_ENTITY_FLOATS,
      );
    }

    if (!this.#bindGroup) {
      this.#bindGroup = this.#device.createBindGroup({
        label: "Minimap bind group",
        layout: this.#bindGroupLayout,
        entries: [
          { binding: 0, resource: inputTexture.view },
          { binding: 1, resource: this.#sampler },
          { binding: 2, resource: { buffer: this.#uniformBuffer } },
          { binding: 3, resource: { buffer: this.#entityBuffer } },
        ],
      });
    }

    const pass = options.encoder.beginRenderPass({
      label: "Minimap orb pass",
      colorAttachments: [{ view: options.targetView, loadOp: "load", storeOp: "store" }],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#bindGroup);
    const shadowPad = Math.ceil(Math.min(halfWidth, halfHeight) * 0.95);
    const scissorX = Math.max(0, Math.floor(v[0]! - halfWidth - shadowPad));
    const scissorY = Math.max(0, Math.floor(v[1]! - halfHeight - shadowPad));
    const scissorRight = Math.min(width, Math.ceil(v[0]! + halfWidth + shadowPad));
    const scissorBottom = Math.min(height, Math.ceil(v[1]! + halfHeight + shadowPad));
    pass.setScissorRect(
      scissorX,
      scissorY,
      Math.max(1, scissorRight - scissorX),
      Math.max(1, scissorBottom - scissorY),
    );
    pass.draw(3);
    pass.end();
    return true;
  }

  destroy(): void {
    this.#destroyTexture();
    this.#uniformBuffer.destroy();
    this.#entityBuffer.destroy();
  }

  #destroyTexture(): void {
    this.#texture?.texture.destroy();
    this.#texture = null;
    this.#bindGroup = null;
  }

  #getOrCreateTexture(
    width: number,
    height: number,
  ): { texture: GPUTexture; view: GPUTextureView } {
    const scale = Math.max(0.05, Math.min(this.#config.backdropScale, 1));
    const textureWidth = Math.max(1, Math.floor(width * scale));
    const textureHeight = Math.max(1, Math.floor(height * scale));
    if (this.#texture?.width === textureWidth && this.#texture.height === textureHeight) {
      return this.#texture;
    }

    this.#destroyTexture();
    const texture = this.#device.createTexture({
      label: `Minimap backdrop (${textureWidth}x${textureHeight})`,
      size: [textureWidth, textureHeight],
      format: this.#format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC,
    });
    this.#texture = {
      width: textureWidth,
      height: textureHeight,
      texture,
      view: texture.createView(),
    };
    return this.#texture;
  }
}
