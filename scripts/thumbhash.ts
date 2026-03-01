#!/usr/bin/env bun
import sharp from "sharp";
import { rgbaToThumbHash, thumbHashToDataURL } from "thumbhash";
import { execFile } from "node:child_process";

const THUMB_MAX = 100;
const VIDEO_EXTS = /\.(mp4|mov|webm|mkv|avi)$/i;

const [, , input, ...flags] = process.argv;

if (!input) {
  console.error("Usage: bun scripts/thumbhash.ts <image-or-video-path> [--dataurl]");
  process.exit(1);
}

const dataUrlOnly = flags.includes("--dataurl");
const isVideo = VIDEO_EXTS.test(input);
const frameFlag = flags.find((f) => f.startsWith("--frame="));
const frameNumber = frameFlag ? Number(frameFlag.split("=")[1]) : 0;

const inputBuffer = isVideo ? await extractFirstFrame(input, frameNumber) : input;

const img = await sharp(inputBuffer)
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

function extractFirstFrame(videoPath: string, frame: number): Promise<Buffer> {
  const args =
    frame > 0
      ? [
          "-i",
          videoPath,
          "-vf",
          `select=gte(n\\,${frame})`,
          "-vframes",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "png",
          "pipe:1",
        ]
      : ["-i", videoPath, "-vframes", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"];

  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(`ffmpeg failed: ${err.message}`));
      else resolve(stdout);
    });
  });
}
