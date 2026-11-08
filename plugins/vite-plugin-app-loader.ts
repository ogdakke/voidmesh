import { resolve } from "path";
import { build } from "rolldown";
import type { Plugin } from "vite";

const PLACEHOLDER = "<!-- app-loader:first-paint -->";
const ENTRY = resolve(import.meta.dirname, "../renderer/app-loader/first-paint.ts");

/**
 * Bundles renderer/app-loader/first-paint.ts into a minified classic script. Inlined
 * (not a module) because it must run while the document parses: module scripts are
 * deferred, and the first paint would show the blue without the wordmark.
 */
export async function bundleFirstPaintScript() {
  const result = await build({
    input: ENTRY,
    write: false,
    output: { format: "iife", minify: true },
  });
  const chunk = result.output.find((item) => item.type === "chunk");
  if (!chunk) throw new Error("app-loader first-paint bundle produced no chunk");
  // `</script` inside the code would close the inline element.
  return chunk.code.trim().replaceAll("</script", "<\\/script");
}

/** Replaces the first-paint placeholder in any served/built HTML page with the inline script. */
export default function appLoaderPlugin(): Plugin {
  return {
    name: "voidmesh-app-loader-first-paint",
    async transformIndexHtml(html) {
      if (!html.includes(PLACEHOLDER)) return html;
      return html.replace(PLACEHOLDER, `<script>${await bundleFirstPaintScript()}</script>`);
    },
  };
}
