import { list, put } from "@vercel/blob";
import sharp from "sharp";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

const MEDIA_DIR = join(import.meta.dirname, "..", "media");
const WIDTHS = [768, 1152];
const FORMATS = ["avif", "webp"] as const;
const QUALITY = 80;
const BLOB_PREFIX = "media";

const dryRun = process.argv.includes("--dry-run");
const MAX_CONCURRENT_UPLOADS = 6;
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 500;

interface Variant {
  imageName: string;
  blobPath: string;
  buffer: Buffer;
  contentType: string;
}

async function uploadWithRetry(v: Variant): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await put(v.blobPath, v.buffer, {
        access: "public",
        addRandomSuffix: false,
        contentType: v.contentType,
      });
      return;
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      const delay = BASE_DELAY_MS * 2 ** attempt;
      const status =
        err instanceof Error && "status" in err ? (err as { status: number }).status : "?";
      console.log(
        `  retry ${v.blobPath} (${status}, attempt ${attempt + 1}/${MAX_RETRIES}, waiting ${delay}ms)`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function runConcurrent<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = [];
  let i = 0;

  async function next(): Promise<void> {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]!();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => next()));
  return results;
}

async function getExistingBlobs(): Promise<Map<string, number>> {
  const existing = new Map<string, number>();
  let cursor: string | undefined;

  do {
    const result = await list({ prefix: `${BLOB_PREFIX}/`, cursor, limit: 1000 });
    for (const blob of result.blobs) {
      existing.set(blob.pathname, blob.size);
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  return existing;
}

function progress(done: number, total: number, label: string) {
  const width = 20;
  const filled = Math.round((done / total) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  process.stderr.write(`\r  ${bar} ${done}/${total} ${label}`);
  if (done === total) process.stderr.write("\n");
}

async function generateAllVariants(files: string[]): Promise<Variant[]> {
  let done = 0;
  const total = files.length;
  progress(0, total, "images transformed");

  const results = await Promise.all(
    files.map(async (file) => {
      const variants = await generateVariantsForFile(file);
      progress(++done, total, "images transformed");
      return variants;
    }),
  );

  return results.flat();
}

async function generateVariantsForFile(file: string): Promise<Variant[]> {
  const filePath = join(MEDIA_DIR, file);
  const name = basename(file, extname(file));
  const meta = await sharp(filePath).metadata();
  const origW = meta.width!;

  const tasks: Promise<Variant>[] = [];

  for (const fmt of FORMATS) {
    for (const w of WIDTHS) {
      if (w >= origW) continue;
      tasks.push(
        sharp(filePath)
          .resize(w)
          [fmt]({ quality: QUALITY })
          .toBuffer()
          .then((buffer) => ({
            imageName: name,
            blobPath: `${BLOB_PREFIX}/${name}/${name}-${w}w.${fmt}`,
            buffer,
            contentType: fmt === "avif" ? "image/avif" : "image/webp",
          })),
      );
    }
    tasks.push(
      sharp(filePath)
        [fmt]({ quality: QUALITY })
        .toBuffer()
        .then((buffer) => ({
          imageName: name,
          blobPath: `${BLOB_PREFIX}/${name}/${name}.${fmt}`,
          buffer,
          contentType: fmt === "avif" ? "image/avif" : "image/webp",
        })),
    );
  }

  return Promise.all(tasks);
}

async function sync() {
  const files = (await readdir(MEDIA_DIR)).filter((f) => /\.(webp|png|jpe?g)$/i.test(f));
  console.log(`Found ${files.length} source images\n`);

  // Phase 1: generate all variants in parallel (CPU-bound sharp work)
  const allVariants = await generateAllVariants(files);

  // Phase 2: diff against existing blobs
  const existing = dryRun ? new Map<string, number>() : await getExistingBlobs();
  if (!dryRun && existing.size > 0) {
    console.log(`Found ${existing.size} existing blobs\n`);
  }

  const toUpload: Variant[] = [];
  let skipped = 0;
  let totalBytes = 0;

  // Group by image name for display
  const byImage = Map.groupBy(allVariants, (v) => v.imageName);

  for (const [imageName, variants] of byImage) {
    console.log(imageName);

    for (const v of variants) {
      const sizeKB = (v.buffer.byteLength / 1024).toFixed(1);
      const existingSize = existing.get(v.blobPath);

      if (existingSize === v.buffer.byteLength) {
        console.log(`  skip ${v.blobPath} (${sizeKB}KB, unchanged)`);
        skipped++;
        continue;
      }

      totalBytes += v.buffer.byteLength;
      if (dryRun) {
        console.log(`  would upload ${v.blobPath} (${sizeKB}KB)`);
      } else {
        toUpload.push(v);
      }
    }
    console.log();
  }

  // Phase 3: upload with concurrency limit + retry
  if (toUpload.length > 0) {
    let uploaded = 0;
    progress(0, toUpload.length, "blobs uploaded");
    await runConcurrent(
      toUpload.map(
        (v) => () =>
          uploadWithRetry(v).then(() => {
            progress(++uploaded, toUpload.length, "blobs uploaded");
          }),
      ),
      MAX_CONCURRENT_UPLOADS,
    );
  }

  const totalKB = (totalBytes / 1024).toFixed(1);
  const putCount = dryRun
    ? toUpload.length + (allVariants.length - skipped - toUpload.length)
    : toUpload.length;
  const action = dryRun ? "Would upload" : "Uploaded";
  console.log(`${action}: ${putCount} blobs (${totalKB}KB total)`);
  if (skipped > 0) console.log(`Skipped: ${skipped} unchanged blobs`);
}

sync();
