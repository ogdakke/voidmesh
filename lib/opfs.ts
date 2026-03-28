export const VIDEO_EDIT_CACHE_ROOT = "video-edit-cache";

export function isOpfsSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

export async function getOpfsRootDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsSupported()) {
    throw new Error("OPFS is not supported in this browser");
  }
  return await navigator.storage.getDirectory();
}

export async function getVideoEditCacheRootDirectory(
  create = true,
): Promise<FileSystemDirectoryHandle> {
  const root = await getOpfsRootDirectory();
  return await root.getDirectoryHandle(VIDEO_EDIT_CACHE_ROOT, { create });
}

export async function getVideoEditCacheDirectory(
  cacheKey: string,
  create = true,
): Promise<FileSystemDirectoryHandle> {
  const root = await getVideoEditCacheRootDirectory(create);
  return await root.getDirectoryHandle(cacheKey, { create });
}

export async function getNestedDirectoryHandle(
  parent: FileSystemDirectoryHandle,
  name: string,
  create = true,
): Promise<FileSystemDirectoryHandle> {
  return await parent.getDirectoryHandle(name, { create });
}

export async function readJsonFile<T>(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<T | null> {
  try {
    const handle = await parent.getFileHandle(name);
    const file = await handle.getFile();
    return JSON.parse(await file.text()) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(
  parent: FileSystemDirectoryHandle,
  name: string,
  value: unknown,
): Promise<void> {
  const handle = await parent.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(JSON.stringify(value));
  } finally {
    await writable.close();
  }
}

export async function writeBlobFile(
  parent: FileSystemDirectoryHandle,
  name: string,
  blob: Blob,
): Promise<void> {
  const handle = await parent.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
}

export async function writeArrayBufferFile(
  parent: FileSystemDirectoryHandle,
  name: string,
  buffer: ArrayBuffer,
): Promise<void> {
  const handle = await parent.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(buffer);
  } finally {
    await writable.close();
  }
}

export async function readBlobFile(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<File | null> {
  try {
    const handle = await parent.getFileHandle(name);
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function readArrayBufferFile(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<ArrayBuffer | null> {
  try {
    const handle = await parent.getFileHandle(name);
    return await (await handle.getFile()).arrayBuffer();
  } catch {
    return null;
  }
}

export async function removeDirectoryEntry(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  try {
    await parent.removeEntry(name, { recursive: true });
  } catch {
    // Ignore missing entries.
  }
}

export async function removeFileEntry(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  try {
    await parent.removeEntry(name);
  } catch {
    // Ignore missing entries.
  }
}

export async function listDirectoryEntries(
  parent: FileSystemDirectoryHandle,
): Promise<FileSystemHandle[]> {
  const entries: FileSystemHandle[] = [];
  for await (const handle of parent.values()) {
    entries.push(handle);
  }
  return entries;
}

export async function getStorageEstimate(): Promise<StorageEstimate | null> {
  if (typeof navigator === "undefined" || typeof navigator.storage?.estimate !== "function") {
    return null;
  }
  return await navigator.storage.estimate();
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof navigator.storage?.persist !== "function") {
    return false;
  }
  return await navigator.storage.persist();
}
