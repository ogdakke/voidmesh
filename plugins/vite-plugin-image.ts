import type { Plugin, ResolvedConfig } from "vite";
import sharp from "sharp";
import { rgbaToThumbHash, thumbHashToDataURL } from "thumbhash";
import { basename, extname } from "path";

const IMG_RE = /[?&]img(?:&|$)/;
const THUMB_MAX = 100;

type ImageFormat = "avif" | "webp" | "jpeg" | "png" | "jxl";

const MIME: Record<ImageFormat, string> = {
  avif: "image/avif",
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png",
  jxl: "image/jxl",
};

interface ImagePluginOptions {
  widths?: number[];
  /** Formats in preference order. Last format is the `<img>` fallback. */
  formats?: ImageFormat[];
}

export default function imagePlugin(options: ImagePluginOptions = {}): Plugin {
  const { widths = [768, 1152], formats = ["avif", "webp"] } = options;
  let config: ResolvedConfig;

  return {
    name: "voidmesh:image",
    enforce: "pre",

    configResolved(resolved) {
      config = resolved;
    },

    async resolveId(source, importer) {
      if (!IMG_RE.test(source)) return null;
      const clean = source.replace(/[?&]img(&|$)/, "$1").replace(/\?$/, "");
      const resolved = await this.resolve(clean, importer, { skipSelf: true });
      if (!resolved) return null;
      return `${resolved.id}?img`;
    },

    async load(id) {
      if (!IMG_RE.test(id)) return null;
      const filePath = id.replace(/\?img$/, "");
      const isDev = config.command === "serve";

      const meta = await sharp(filePath).metadata();
      const origW = meta.width!;
      const origH = meta.height!;

      // Generate thumbhash from small version
      const thumbImg = await sharp(filePath)
        .resize(THUMB_MAX, THUMB_MAX, { fit: "inside" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const hash = rgbaToThumbHash(thumbImg.info.width, thumbImg.info.height, thumbImg.data);
      const thumbDataURL = thumbHashToDataURL(hash);

      if (isDev) {
        const devUrl = `/@fs/${filePath}`;
        return `
          export const src = ${JSON.stringify(devUrl)};
          export const sources = [];
          export const thumbhash = ${JSON.stringify(thumbDataURL)};
          export const width = ${origW};
          export const height = ${origH};
          export default { src, sources, thumbhash, width, height };
        `;
      }

      const name = basename(filePath, extname(filePath));
      const sourcesArr: { srcSet: string; type: string }[] = [];
      let fallbackUrl = "";

      for (const fmt of formats) {
        const srcSetParts: string[] = [];

        for (const w of widths) {
          if (w >= origW) continue;
          srcSetParts.push(`/m/${name}/${name}-${w}w.${fmt} ${w}w`);
        }

        // Full-size
        const fullUrl = `/m/${name}/${name}.${fmt}`;
        srcSetParts.push(`${fullUrl} ${origW}w`);

        sourcesArr.push({ srcSet: srcSetParts.join(", "), type: MIME[fmt] });
        fallbackUrl = fullUrl;
      }

      return `
        export const src = ${JSON.stringify(fallbackUrl)};
        export const sources = ${JSON.stringify(sourcesArr)};
        export const thumbhash = ${JSON.stringify(thumbDataURL)};
        export const width = ${origW};
        export const height = ${origH};
        export default { src, sources, thumbhash, width, height };
      `;
    },
  };
}
