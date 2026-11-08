import { describe, expect, it } from "vitest";
import appLoaderPlugin, { bundleFirstPaintScript } from "../../plugins/vite-plugin-app-loader.ts";

describe("app-loader first-paint plugin", () => {
  it("bundles the first-paint script as a self-contained classic script", async () => {
    const code = await bundleFirstPaintScript();
    expect(code).not.toMatch(/\bimport\b|\bexport\b/);
    expect(code).not.toContain("</script");
    expect(code).toContain("app-loader");
  });

  it("inlines the script in place of the placeholder", async () => {
    const plugin = appLoaderPlugin();
    const transform = plugin.transformIndexHtml as (html: string) => Promise<string>;
    const html = await transform(`<div><svg></svg><!-- app-loader:first-paint --><canvas></div>`);
    expect(html).toMatch(
      /^<div><svg><\/svg><script>\(function\(\)\{.+\}\)\(\);?<\/script><canvas><\/div>$/s,
    );
    expect(await transform("<p>no placeholder</p>")).toBe("<p>no placeholder</p>");
  });
});
