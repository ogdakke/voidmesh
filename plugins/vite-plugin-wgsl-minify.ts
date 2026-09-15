import type { Plugin, ResolvedConfig } from "vite";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { initialize, minify, type InitializeOptions, type MinifyOptions } from "miniray";

const INCLUDE_RE = /^[ \t]*\/\/ @include "([^"\n]+)"[ \t]*$/gm;

function assembleShader(
  filePath: string,
  watch: (path: string) => void,
  stack: string[] = [],
): string {
  if (stack.includes(filePath))
    throw new Error(`Circular WGSL include: ${[...stack, filePath].join(" -> ")}`);
  watch(filePath);
  return readFileSync(filePath, "utf-8").replace(INCLUDE_RE, (_match, include: string) =>
    assembleShader(resolve(dirname(filePath), include), watch, [...stack, filePath]),
  );
}

const WGSL_RAW_RE = /\.wgsl\?raw$/;
let initPromise: Promise<void> | null = null;

const RUNTIME_REWRITE_KEEP_NAMES = [
  "sourceTexture",
  "sourceSampler",
  "inputTexture",
  "entityTexture",
  "entitySampler",
  "src_texture",
  "src_sampler",
  "loadAtUV",
];

type WgslMinifyOptions = {
  initialize?: InitializeOptions;
  minify?: MinifyOptions;
};
export default function wgslMinifyPlugin(
  options: WgslMinifyOptions = {
    initialize: {},
  },
): Plugin {
  let config: ResolvedConfig;

  return {
    name: "wgsl-minify",
    enforce: "pre",

    configResolved(resolved) {
      config = resolved;
    },

    async load(id) {
      if (!WGSL_RAW_RE.test(id)) return null;
      const then = performance.now();

      const filePath = id.replace(/\?raw$/, "");
      const source = assembleShader(filePath, (path) => this.addWatchFile(path));
      if (config.command !== "build") return `export default ${JSON.stringify(source)}`;

      initPromise ??= initialize(options.initialize ?? {});
      await initPromise;

      const result = minify(source, {
        ...options.minify,
        keepNames: [
          ...new Set([...RUNTIME_REWRITE_KEEP_NAMES, ...(options.minify?.keepNames ?? [])]),
        ],
      });

      if (result.errors.length > 0) {
        for (const err of result.errors) {
          this.warn(`${filePath}:${err.line}:${err.column}: ${err.message}`);
        }
        return `export default ${JSON.stringify(source)}`;
      }

      this.debug(
        `${filePath.split("/").pop()}: ${result.originalSize}B → ${result.minifiedSize}B in ${(performance.now() - then).toFixed(2)}ms`,
      );
      return `export default ${JSON.stringify(result.code)}`;
    },
  };
}
