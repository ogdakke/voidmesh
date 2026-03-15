import type { Plugin, ResolvedConfig } from "vite-plus";
import { readFileSync } from "fs";
import { initialize, minify, type InitializeOptions, type MinifyOptions } from "miniray";

const WGSL_RAW_RE = /\.wgsl\?raw$/;
let initPromise: Promise<void> | null = null;

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
      if (config.command !== "build") return null;
      const then = performance.now();

      const filePath = id.replace(/\?raw$/, "");
      const source = readFileSync(filePath, "utf-8");

      initPromise ??= initialize(options.initialize ?? {});
      await initPromise;

      const result = minify(source, options.minify);

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
