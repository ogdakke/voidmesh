import type { WorkspaceId } from "@voidmesh/domain";

const DATABASE_NAME = "voidmesh-hosted-assets";
const DATABASE_VERSION = 1;
const STORE_NAME = "assets";
const FALLBACK_MAX_BYTES = 128 * 1024 * 1024;

interface CachedAssetRecord {
  assetId: string;
  blob: Blob;
  byteLength: number;
  key: string;
  savedAt: number;
  workspaceId: WorkspaceId;
}

export interface HostedAssetCache {
  delete(assetId: string): Promise<void>;
  get(assetId: string, contentType: string): Promise<Blob | null>;
  put(assetId: string, blob: Blob): Promise<void>;
}

/**
 * Persists original hosted media in OPFS so an opened workspace can be
 * reconstructed without the network. Browsers without OPFS use a bounded
 * IndexedDB cache to avoid consuming origin storage without limit.
 */
export class BrowserHostedAssetCache implements HostedAssetCache {
  readonly #workspaceId: WorkspaceId;
  #directory: Promise<FileSystemDirectoryHandle | null> | null = null;

  constructor(workspaceId: WorkspaceId) {
    this.#workspaceId = workspaceId;
  }

  async delete(assetId: string): Promise<void> {
    const directory = await this.#getDirectory();
    if (directory) {
      try {
        await directory.removeEntry(assetId);
        return;
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }
    const database = await openFallbackDatabase();
    if (!database) return;
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(this.#key(assetId));
      await transactionDone(transaction);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  async get(assetId: string, contentType: string): Promise<Blob | null> {
    const directory = await this.#getDirectory();
    if (directory) {
      try {
        const handle = await directory.getFileHandle(assetId);
        const file = await handle.getFile();
        return new Blob([file], { type: contentType });
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
    }

    const database = await openFallbackDatabase();
    if (!database) return null;
    const record = await request<CachedAssetRecord | undefined>(
      database.transaction(STORE_NAME).objectStore(STORE_NAME).get(this.#key(assetId)),
    );
    return record ? new Blob([record.blob], { type: contentType }) : null;
  }

  async put(assetId: string, blob: Blob): Promise<void> {
    const directory = await this.#getDirectory();
    if (directory) {
      const handle = await directory.getFileHandle(assetId, { create: true });
      const writable = await handle.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
        return;
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
    }

    if (blob.size > FALLBACK_MAX_BYTES) return;
    const database = await openFallbackDatabase();
    if (!database) return;
    const record: CachedAssetRecord = {
      assetId,
      blob,
      byteLength: blob.size,
      key: this.#key(assetId),
      savedAt: Date.now(),
      workspaceId: this.#workspaceId,
    };
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await transactionDone(transaction);
    await pruneFallback(database, record.key);
  }

  #key(assetId: string): string {
    return `${this.#workspaceId}:${assetId}`;
  }

  #getDirectory(): Promise<FileSystemDirectoryHandle | null> {
    this.#directory ??= openWorkspaceDirectory(this.#workspaceId);
    return this.#directory;
  }
}

async function openWorkspaceDirectory(
  workspaceId: WorkspaceId,
): Promise<FileSystemDirectoryHandle | null> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (!storage.getDirectory) return null;
  try {
    const root = await storage.getDirectory();
    const assets = await root.getDirectoryHandle("voidmesh-hosted-assets", { create: true });
    return await assets.getDirectoryHandle(workspaceId, { create: true });
  } catch {
    return null;
  }
}

function openFallbackDatabase(): Promise<IDBDatabase | null> {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    opening.onupgradeneeded = () => {
      const database = opening.result;
      if (database.objectStoreNames.contains(STORE_NAME)) return;
      const store = database.createObjectStore(STORE_NAME, { keyPath: "key" });
      store.createIndex("savedAt", "savedAt");
    };
    opening.onerror = () => reject(opening.error ?? new Error("Unable to open asset cache"));
    opening.onsuccess = () => resolve(opening.result);
  });
}

async function pruneFallback(database: IDBDatabase, newestKey: string): Promise<void> {
  const records = await request<CachedAssetRecord[]>(
    database.transaction(STORE_NAME).objectStore(STORE_NAME).getAll(),
  );
  let total = records.reduce((sum, record) => sum + record.byteLength, 0);
  if (total <= FALLBACK_MAX_BYTES) return;
  records.sort((left, right) => left.savedAt - right.savedAt);
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  for (const record of records) {
    if (total <= FALLBACK_MAX_BYTES) break;
    if (record.key === newestKey && records.length > 1) continue;
    store.delete(record.key);
    total -= record.byteLength;
  }
  await transactionDone(transaction);
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onerror = () => reject(value.error ?? new Error("Asset cache request failed"));
    value.onsuccess = () => resolve(value.result);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.onabort = () => reject(transaction.error ?? new Error("Asset cache aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Asset cache failed"));
    transaction.oncomplete = () => resolve();
  });
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}
