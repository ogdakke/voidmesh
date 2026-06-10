import type { ShaderType } from "#types/canvas.ts";
import type { TexturePool } from "../texture-pool.ts";
import type { EffectRenderEntity } from "../effect-render-entity.ts";
import type { ShaderPass } from "./shader-pass.ts";

export class ShaderRegistry {
  #passes: Map<string, ShaderPass> = new Map();

  /** Register a shader pass for a given type */
  register(shaderType: ShaderType, pass: ShaderPass): void {
    this.#passes.set(shaderType, pass);
  }

  /** Get a shader pass by type */
  get(shaderType: ShaderType): ShaderPass | undefined {
    return this.#passes.get(shaderType);
  }

  /** Check if a shader type is registered */
  has(shaderType: ShaderType): boolean {
    return this.#passes.has(shaderType);
  }

  /** Execute a single shader pass: source -> output */
  applyShader(
    entity: EffectRenderEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
    encoder: GPUCommandEncoder,
  ): void {
    const pass = this.#passes.get(entity.shaderType);
    if (!pass) throw new Error(`Shader pass not registered: ${entity.shaderType}`);
    pass.execute(entity, sourceTexture, outputTexture, encoder);
  }

  /**
   * Execute a chain of shader passes using ping-pong textures.
   * Each pass reads from one texture and writes to the other, alternating.
   * The final result ends up in `outputTexture`.
   */
  applyShaderChain(
    entity: EffectRenderEntity,
    sourceTexture: GPUTexture,
    outputTexture: GPUTexture,
    chain: ShaderType[],
    texturePool: TexturePool,
    encoder: GPUCommandEncoder,
  ): void {
    if (chain.length === 0) return;
    if (chain.length === 1) {
      const pass = this.#passes.get(chain[0]!);
      if (!pass) throw new Error(`Shader pass not registered: ${chain[0]}`);
      pass.execute(entity, sourceTexture, outputTexture, encoder);
      return;
    }

    const width = entity.originalSize.width;
    const height = entity.originalSize.height;
    const intermediateUsage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC;

    // Acquire a ping-pong texture for intermediate results
    const pingPong = texturePool.acquire(
      width,
      height,
      intermediateUsage,
      "Shader chain ping-pong",
    );

    let readFrom = sourceTexture;

    for (let i = 0; i < chain.length; i++) {
      const pass = this.#passes.get(chain[i]!);
      if (!pass) throw new Error(`Shader pass not registered: ${chain[i]}`);

      const isLast = i === chain.length - 1;
      const writeTo = isLast ? outputTexture : pingPong;

      pass.execute(entity, readFrom, writeTo, encoder);

      // Next pass reads from what we just wrote
      readFrom = writeTo;
    }

    texturePool.release(pingPong, width, height, intermediateUsage);
  }

  /** Destroy all passes */
  destroy(): void {
    for (const pass of this.#passes.values()) {
      pass.destroy();
    }
    this.#passes.clear();
  }
}
