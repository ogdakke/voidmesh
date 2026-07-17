import { sha256 } from "@noble/hashes/sha2.js";
import type { WorkspaceId } from "@voidmesh/domain";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import type { HostedAssetRegistry } from "#application/canvas/hosted-canvas-sync.ts";
import type { HostedAssetReference } from "#lib/hosted-workspace-document.ts";
import { HostedApiClient } from "#lib/hosted-api-client.ts";
import { HostedApiError } from "#lib/hosted-api-client.ts";
import type { HostedAssetCache } from "#lib/hosted-asset-cache.ts";
import type { HostedWorkspaceDocument } from "#lib/hosted-workspace-document.ts";

const LOCAL_ASSET_PREFIX = "local_";

export class R2HostedAssetRegistry implements HostedAssetRegistry {
  readonly #api: HostedApiClient;
  readonly #cache: HostedAssetCache;
  readonly #onCacheError: (error: unknown) => void;
  readonly #onPendingUpload: () => void;
  readonly #workspaceId: WorkspaceId;
  readonly #references = new Map<string, HostedAssetReference>();
  readonly #entityBlobs = new Map<string, Blob>();
  readonly #hashes = new WeakMap<Blob, Promise<string>>();
  readonly #uploadKeys = new WeakMap<Blob, string>();
  readonly #uploads = new WeakMap<Blob, Promise<HostedAssetReference>>();

  constructor(
    api: HostedApiClient,
    workspaceId: WorkspaceId,
    cache: HostedAssetCache,
    onCacheError: (error: unknown) => void,
    onPendingUpload: () => void,
  ) {
    this.#api = api;
    this.#workspaceId = workspaceId;
    this.#cache = cache;
    this.#onCacheError = onCacheError;
    this.#onPendingUpload = onPendingUpload;
  }

  getReference(entityId: string): HostedAssetReference | undefined {
    return this.#references.get(entityId);
  }

  release(entityId: string): void {
    this.#entityBlobs.delete(entityId);
    this.#references.delete(entityId);
  }

  async register(entity: ShaderCanvasEntity, signal: AbortSignal): Promise<HostedAssetReference> {
    const blob = getEntityBlob(entity);
    const existing = this.#references.get(entity.id);
    if (existing && this.#entityBlobs.get(entity.id) === blob) return existing;
    this.#entityBlobs.set(entity.id, blob);
    this.#references.delete(entity.id);
    let upload = this.#uploads.get(blob);
    if (!upload) {
      upload = this.#uploadOrQueue(blob, entity.name, entity.mediaSource.type, signal);
      this.#uploads.set(blob, upload);
    }
    let reference: HostedAssetReference;
    try {
      reference = await upload;
    } catch (error) {
      this.#uploads.delete(blob);
      throw error;
    }
    signal.throwIfAborted();
    if (this.#entityBlobs.get(entity.id) === blob) this.#references.set(entity.id, reference);
    return reference;
  }

  adopt(entityId: string, reference: HostedAssetReference, blob: Blob): void {
    this.#entityBlobs.set(entityId, blob);
    this.#references.set(entityId, reference);
  }

  async flushPending(document: HostedWorkspaceDocument): Promise<void> {
    const pending = new Map<string, HostedAssetReference>();
    for (const entity of document.getEntities()) {
      if (entity.asset.id.startsWith(LOCAL_ASSET_PREFIX))
        pending.set(entity.asset.id, entity.asset);
    }
    for (const reference of pending.values()) {
      const blob = await this.#cache.get(reference.id, reference.contentType);
      if (!blob || blob.size !== reference.byteLength) {
        throw new Error(
          `The offline original for ${reference.originalFilename} is unavailable. Its local workspace copy was preserved and was not synchronized.`,
        );
      }
      const uploaded = await this.#upload(
        blob,
        reference.originalFilename,
        reference.mediaType,
        new AbortController().signal,
      );
      document.replaceAssetReference(reference.id, uploaded);
      for (const [entityId, current] of this.#references) {
        if (current.id === reference.id) this.#references.set(entityId, uploaded);
      }
      this.#uploads.set(blob, Promise.resolve(uploaded));
      await this.#cache.delete(reference.id);
    }
  }

  async createOriginalDownload(entityId: string): Promise<{ filename: string; url: string }> {
    const reference = this.#references.get(entityId);
    if (!reference) throw new Error("This entity does not have a hosted original");
    const grant = await this.#api.createAssetDownload(this.#workspaceId, reference.id);
    return { filename: reference.originalFilename, url: grant.downloadUrl };
  }

  async #upload(
    blob: Blob,
    filename: string,
    mediaType: string,
    signal: AbortSignal,
  ): Promise<HostedAssetReference> {
    if (!blob.type) throw new Error(`Cannot host ${filename}: its media type is missing`);
    let idempotencyKey = this.#uploadKeys.get(blob);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      this.#uploadKeys.set(blob, idempotencyKey);
    }
    let contentHash = this.#hashes.get(blob);
    if (!contentHash) {
      contentHash = sha256Blob(blob, signal);
      this.#hashes.set(blob, contentHash);
    }
    const grant = await this.#api.reserveAssetUpload(
      this.#workspaceId,
      {
        byteLength: blob.size,
        contentHash: await contentHash,
        contentType: blob.type,
        mediaType,
        originalFilename: filename,
      },
      idempotencyKey,
    );
    signal.throwIfAborted();
    const response = await fetch(grant.uploadUrl, {
      body: blob,
      headers: grant.headers,
      method: "PUT",
      signal,
    });
    if (!response.ok) throw new Error(`Object upload failed with HTTP ${response.status}`);
    const finalized = await retryOnce(() =>
      this.#api.finalizeAssetUpload(this.#workspaceId, grant.reservationId),
    );
    void this.#cache.put(finalized.asset.id, blob).catch(this.#onCacheError);
    return finalized.asset;
  }

  async #uploadOrQueue(
    blob: Blob,
    filename: string,
    mediaType: string,
    signal: AbortSignal,
  ): Promise<HostedAssetReference> {
    if (navigator.onLine !== false) {
      try {
        return await this.#upload(blob, filename, mediaType, signal);
      } catch (error) {
        if (!isRetryableUploadError(error)) throw error;
      }
    }
    signal.throwIfAborted();
    const reference: HostedAssetReference = {
      byteLength: blob.size,
      contentType: blob.type,
      id: `${LOCAL_ASSET_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`,
      mediaType,
      originalFilename: filename,
    };
    await this.#cache.put(reference.id, blob);
    signal.throwIfAborted();
    this.#onPendingUpload();
    return reference;
  }
}

async function sha256Blob(blob: Blob, signal: AbortSignal): Promise<string> {
  const hash = sha256.create();
  const reader = blob.stream().getReader();
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
    }
    signal.throwIfAborted();
    return [...hash.digest()].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    reader.releaseLock();
  }
}

async function retryOnce<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isRetryableUploadError(error)) throw error;
    return operation();
  }
}

function isRetryableUploadError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof HostedApiError && (error.status === 429 || error.status >= 500))
  );
}

function getEntityBlob(entity: ShaderCanvasEntity): Blob {
  return entity.mediaSource.type === "image"
    ? entity.mediaSource.asset.blob
    : entity.mediaSource.blob;
}
