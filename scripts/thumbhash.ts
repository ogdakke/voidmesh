#!/usr/bin/env bun
import sharp from "sharp";
import { rgbaToThumbHash, thumbHashToDataURL } from "thumbhash";

const THUMB_MAX = 100;

const [, , input, ...flags] = process.argv;

if (!input) {
  console.error("Usage: bun scripts/thumbhash.ts <image-path> [--dataurl]");
  process.exit(1);
}

const dataUrlOnly = flags.includes("--dataurl");

const img = await sharp(input)
  .resize(THUMB_MAX, THUMB_MAX, { fit: "inside" })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const hash = rgbaToThumbHash(img.info.width, img.info.height, img.data);

if (dataUrlOnly) {
  console.log(thumbHashToDataURL(hash));
} else {
  const dataURL = thumbHashToDataURL(hash);
  const b64 = Buffer.from(hash).toString("base64");
  console.log("base64: ", b64);
  console.log("dataURL:", dataURL);
}
