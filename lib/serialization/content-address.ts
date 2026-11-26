import type { StudioManifest } from "./types.ts";

/** A media file's v7 archive path: `media/<sha256>.<ext>`, keeping the original extension. */
export async function contentMediaPath(path: string, bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  const hash = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "bin";
  return `media/${hash}.${ext}`;
}

/** Point a manifest's media references at their content-addressed paths. */
export function renameMediaPaths(
  manifest: StudioManifest,
  renamed: ReadonlyMap<string, string>,
): StudioManifest {
  if (manifest.mediaFiles) {
    manifest.mediaFiles = manifest.mediaFiles.map((path) => renamed.get(path) ?? path);
  }
  for (const entity of manifest.entities) {
    if (entity.mediaFile) entity.mediaFile = renamed.get(entity.mediaFile) ?? entity.mediaFile;
  }
  return manifest;
}
