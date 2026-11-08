/**
 * Renders iOS PWA startup images from an HTML page in headless Chrome.
 *
 *   bun run pwa:splash [--page scripts/pwa-splash/splash.html] [--keep-browser]
 *
 * The page is served by Vite with the project config (so CSS and the app-loader
 * first-paint script are processed exactly as in index.html), then captured at each
 * device's CSS viewport and pixel ratio, in both orientations. Chrome renders with an
 * sRGB profile (screenshots are sRGB-encoded either way) and the PNGs are tagged
 * Display P3, so the page should write colours as P3 channel values in rgb() syntax
 * (see splash.html): they pass through verbatim and match the P3 loader blue.
 * Writes public/assets/splash/ and rewrites the startup-image block in index.html.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import sharp from "sharp";
import { createServer } from "vite";
import { CdpClient, resolveChromePath } from "./lib/chrome.ts";

interface Device {
  /** CSS viewport in portrait. */
  width: number;
  height: number;
  dpr: number;
}

/** Devices with a distinct screen (CSS size × pixel ratio); several models share each. */
const DEVICES: Device[] = [
  // iPad
  { width: 1032, height: 1376, dpr: 2 },
  { width: 1024, height: 1366, dpr: 2 },
  { width: 834, height: 1210, dpr: 2 },
  { width: 834, height: 1194, dpr: 2 },
  { width: 820, height: 1180, dpr: 2 },
  { width: 834, height: 1112, dpr: 2 },
  { width: 810, height: 1080, dpr: 2 },
  { width: 768, height: 1024, dpr: 2 },
  { width: 744, height: 1133, dpr: 2 },
  // iPhone
  { width: 440, height: 956, dpr: 3 },
  { width: 430, height: 932, dpr: 3 },
  { width: 428, height: 926, dpr: 3 },
  { width: 420, height: 912, dpr: 3 },
  { width: 414, height: 896, dpr: 3 },
  { width: 414, height: 896, dpr: 2 },
  { width: 414, height: 736, dpr: 3 },
  { width: 402, height: 874, dpr: 3 },
  { width: 393, height: 852, dpr: 3 },
  { width: 390, height: 844, dpr: 3 },
  { width: 375, height: 812, dpr: 3 },
  { width: 375, height: 667, dpr: 2 },
  { width: 320, height: 568, dpr: 2 },
];

const ROOT = resolve(import.meta.dirname, "..");
const OUT_DIR = join(ROOT, "public/assets/splash");
const INDEX_HTML = join(ROOT, "index.html");
const BLOCK_START = "<!-- apple-touch-startup-image:start (bun run pwa:splash) -->";
const BLOCK_END = "<!-- apple-touch-startup-image:end -->";
const HOST = "127.0.0.1";

interface Shot {
  device: Device;
  orientation: "portrait" | "landscape";
  file: string;
}

async function main() {
  const args = process.argv.slice(2);
  const pageArg = valueOf(args, "--page") ?? "scripts/pwa-splash/splash.html";
  const keepBrowser = args.includes("--keep-browser");

  const profileDir = join(tmpdir(), `voidmesh-pwa-splash-${process.pid}`);
  const server = await createServer({
    root: ROOT,
    configFile: join(ROOT, "vite.config.ts"),
    // Own dependency cache: sharing node_modules/.vite would re-optimize deps under a
    // running dev server and break its open pages.
    cacheDir: join(profileDir, "vite"),
    logLevel: "warn",
    server: { host: HOST, port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not bind a port");
  const pageUrl = `http://${HOST}:${address.port}/${relative(ROOT, resolve(ROOT, pageArg))}`;

  const cdpPort = 9300 + Math.floor(Math.random() * 500);
  const chrome = Bun.spawn(
    [
      await resolveChromePath(),
      "--headless=new",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      // No host display conversion: rgb() channels land in the PNG unchanged.
      "--force-color-profile=srgb",
      "about:blank",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );

  try {
    const page = await CdpClient.connect(await pageTarget(cdpPort));
    await page.send("Page.enable");
    await mkdir(OUT_DIR, { recursive: true });
    const shots: Shot[] = [];
    for (const device of DEVICES) {
      for (const orientation of ["portrait", "landscape"] as const) {
        shots.push(await capture(page, pageUrl, device, orientation));
      }
    }
    page.close();
    await removeStale(new Set(shots.map((shot) => shot.file)));
    await rewriteIndexHtml(shots);
    console.log(`Wrote ${shots.length} startup images to ${relative(ROOT, OUT_DIR)}/`);
  } finally {
    if (!keepBrowser) chrome.kill();
    await server.close();
    await chrome.exited;
    await rm(profileDir, { recursive: true, force: true });
  }
}

async function capture(
  page: CdpClient,
  pageUrl: string,
  device: Device,
  orientation: Shot["orientation"],
): Promise<Shot> {
  const portrait = orientation === "portrait";
  const width = portrait ? device.width : device.height;
  const height = portrait ? device.height : device.width;
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: device.dpr,
    mobile: true,
    screenOrientation: portrait
      ? { type: "portraitPrimary", angle: 0 }
      : { type: "landscapePrimary", angle: 90 },
  });
  await page.send("Page.navigate", { url: `${pageUrl}?w=${width}&h=${height}&dpr=${device.dpr}` });
  await page.send("Runtime.evaluate", {
    awaitPromise: true,
    expression: `new Promise((done) => {
      const settle = () => requestAnimationFrame(() => requestAnimationFrame(done));
      if (document.readyState === "complete") settle();
      else addEventListener("load", settle, { once: true });
    })`,
  });
  const { data } = (await page.send("Page.captureScreenshot", { format: "png" })) as {
    data: string;
  };

  const pixelWidth = width * device.dpr;
  const pixelHeight = height * device.dpr;
  const image = sharp(Buffer.from(data, "base64"));
  const meta = await image.metadata();
  if (meta.width !== pixelWidth || meta.height !== pixelHeight) {
    throw new Error(
      `${width}×${height}@${device.dpr}: captured ${meta.width}×${meta.height}, expected ${pixelWidth}×${pixelHeight}`,
    );
  }
  const png = await image
    .withIccProfile("p3")
    .png({ palette: true, colours: 16, dither: 0, compressionLevel: 9, effort: 10 })
    .toBuffer();
  const hash = new Bun.CryptoHasher("sha256").update(png).digest("hex").slice(0, 8);
  // Hashed: /assets/* is served immutable for a year.
  const file = `apple-splash-${pixelWidth}-${pixelHeight}.${hash}.png`;
  await writeFile(join(OUT_DIR, file), png);
  console.log(`  ${file}  ${(png.byteLength / 1024).toFixed(1)} KB`);
  return { device, orientation, file };
}

async function pageTarget(cdpPort: number) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const targets = (await (await fetch(`http://${HOST}:${cdpPort}/json/list`)).json()) as Array<{
        type: string;
        webSocketDebuggerUrl?: string;
      }>;
      const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await Bun.sleep(200);
  }
  throw new Error("Timed out waiting for Chrome DevTools");
}

async function removeStale(keep: Set<string>) {
  for (const name of await readdir(OUT_DIR)) {
    if (name.startsWith("apple-splash-") && !keep.has(name)) await rm(join(OUT_DIR, name));
  }
}

async function rewriteIndexHtml(shots: Shot[]) {
  const html = await Bun.file(INDEX_HTML).text();
  const start = html.indexOf(BLOCK_START);
  const end = html.indexOf(BLOCK_END);
  if (start < 0 || end < start) {
    throw new Error(`index.html needs the ${BLOCK_START} … ${BLOCK_END} block`);
  }
  const lineStart = html.lastIndexOf("\n", start) + 1;
  const indent = html.slice(lineStart, start);
  const links = shots.map(({ device, orientation, file }) =>
    [
      `${indent}<link`,
      `${indent}  rel="apple-touch-startup-image"`,
      `${indent}  href="/assets/splash/${file}"`,
      `${indent}  media="(device-width: ${device.width}px) and (device-height: ${device.height}px) and (-webkit-device-pixel-ratio: ${device.dpr}) and (orientation: ${orientation})"`,
      `${indent}/>`,
    ].join("\n"),
  );
  const block = [BLOCK_START, ...links, `${indent}${BLOCK_END}`].join("\n");
  await writeFile(INDEX_HTML, html.slice(0, start) + block + html.slice(end + BLOCK_END.length));
}

function valueOf(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

await main();
