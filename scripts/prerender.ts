import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type PrerenderModule = {
  render: () => string;
};

const distIndexPath = resolve("dist/index.html");
const prerenderBundlePath = resolve(".tmp/prerender/entry-prerender.js");
const prerenderOutDir = resolve(".tmp/prerender");

const { render } = (await import(pathToFileURL(prerenderBundlePath).href)) as PrerenderModule;
const shell = render();

let html = await readFile(distIndexPath, "utf8");

if (!html.includes("<!--ssg-outlet-->")) {
  throw new Error("Missing <!--ssg-outlet--> marker in dist/index.html");
}

html = html
  .replace("<!--ssg-outlet-->", shell)
  .replace('<html lang="en">', '<html lang="en" data-prerendered="true">')
  .replace('<div id="root">', '<div id="root" data-prerendered="true">');

await writeFile(distIndexPath, html);
await rm(prerenderOutDir, { recursive: true, force: true });
