import { sha256 } from "@noble/hashes/sha2.js";
import type { WorkspaceId } from "@voidmesh/domain";
import type { ClientDurableMessage, HostedAssetReference } from "@voidmesh/collaboration";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import type { HostedAssetRegistry } from "#application/canvas/hosted-canvas-sync.ts";
import { HostedApiClient } from "#lib/hosted-api-client.ts";
import { HostedApiError } from "#lib/hosted-api-client.ts";
import type { HostedAssetCache } from "#lib/hosted-asset-cache.ts";
import {
  blobToBase64,
  createHostedAssetThumbnail,
  createHostedAssetThumbnailFromBlob,
} from "./hosted-asset-thumbnail.ts";

const LOCAL_ASSET_PREFIX = "local_";

export class R2HostedAssetRegistry implements HostedAssetRegistry {
  readonly #api: HostedApiClient;
  readonly #cache: HostedAssetCache;
  readonly #onCacheError: (error: unknown) => void;
  readonly #onPendingUpload: () => void;
  readonly #onUploadComplete: () => void;
  readonly #workspaceId: WorkspaceId;
  readonly #references = new Map<string, HostedAssetReference>();
  readonly #entityBlobs = new Map<string, Blob>();
  readonly #hashes = new WeakMap<Blob, Promise<string>>();
  readonly #uploadKeys = new WeakMap<Blob, string>();
  readonly #uploads = new WeakMap<Blob, Promise<HostedAssetReference>>();
  readonly #uploadsByContentHash = new Map<string, Promise<HostedAssetReference>>();
  readonly #adoptedBlobs = new WeakMap<
    Blob,
    { needsThumbnail: boolean; reference: HostedAssetReference }
  >();
  readonly #thumbnailBackfills = new Map<string, Promise<void>>();

  constructor(
    api: HostedApiClient,
    workspaceId: WorkspaceId,
    cache: HostedAssetCache,
    onCacheError: (error: unknown) => void,
    onPendingUpload: () => void,
    onUploadComplete: () => void = () => {},
  ) {
    this.#api = api;
    this.#workspaceId = workspaceId;
    this.#cache = cache;
    this.#onCacheError = onCacheError;
    this.#onPendingUpload = onPendingUpload;
    this.#onUploadComplete = onUploadComplete;
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
    const adopted = this.#adoptedBlobs.get(blob);
    if (adopted) {
      this.#entityBlobs.set(entity.id, blob);
      this.#references.set(entity.id, adopted.reference);
      if (adopted.needsThumbnail) {
        void this.backfillThumbnail(entity, adopted.reference).catch(this.#onCacheError);
      }
      return adopted.reference;
    }
    const existing = this.#references.get(entity.id);
    if (existing && this.#entityBlobs.get(entity.id) === blob) return existing;
    this.#entityBlobs.set(entity.id, blob);
    this.#references.delete(entity.id);
    let upload = this.#uploads.get(blob);
    if (!upload) {
      const contentHash = await this.#getContentHash(blob, signal);
      signal.throwIfAborted();
      upload = this.#uploadsByContentHash.get(contentHash);
      if (!upload) {
        upload = createHostedAssetThumbnail(entity).then((thumbnail) =>
          this.#uploadOrQueue(blob, entity.name, entity.mediaSource.type, thumbnail, signal),
        );
        this.#uploadsByContentHash.set(contentHash, upload);
        void upload.catch(() => {
          if (this.#uploadsByContentHash.get(contentHash) === upload) {
            this.#uploadsByContentHash.delete(contentHash);
          }
        });
      }
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

  adoptBlob(reference: HostedAssetReference, blob: Blob, needsThumbnail: boolean): void {
    this.#adoptedBlobs.set(blob, { needsThumbnail, reference });
  }

  backfillThumbnail(entity: ShaderCanvasEntity, reference: HostedAssetReference): Promise<void> {
    if (reference.id.startsWith(LOCAL_ASSET_PREFIX)) return Promise.resolve();
    const existing = this.#thumbnailBackfills.get(reference.id);
    if (existing) return existing;
    const pending = createHostedAssetThumbnail(entity)
      .then(async (thumbnail) => {
        if (!thumbnail)
          throw new Error(`Unable to create a thumbnail for ${reference.originalFilename}`);
        await this.#api.uploadAssetThumbnail(
          this.#workspaceId,
          reference.id,
          await thumbnailRequest(thumbnail),
        );
        this.#onUploadComplete();
      })
      .finally(() => this.#thumbnailBackfills.delete(reference.id));
    this.#thumbnailBackfills.set(reference.id, pending);
    return pending;
  }

  async flushPendingCommands(
    commands: readonly ClientDurableMessage[],
  ): Promise<readonly ClientDurableMessage[]> {
    const rewritten = structuredClone(commands);
    const pending = new Map<string, HostedAssetReference>();
    for (const message of rewritten) collectPendingReferences(message, pending);
    const replacements = new Map<string, HostedAssetReference>();
    for (const reference of pending.values()) {
      const blob = await this.#cache.get(reference.id, reference.contentType);
      if (!blob || blob.size !== reference.byteLength) {
        throw new Error(
          `The offline original for ${reference.originalFilename} is unavailable. Its local workspace copy was preserved and was not synchronized.`,
        );
      }
      let thumbnail: Blob | undefined;
      try {
        thumbnail = await createHostedAssetThumbnailFromBlob(blob, reference.mediaType);
      } catch (error) {
        // A derived preview must not strand an otherwise recoverable original.
        this.#onCacheError(error);
      }
      const uploaded = await this.#upload(
        blob,
        reference.originalFilename,
        reference.mediaType,
        thumbnail,
        new AbortController().signal,
      );
      replacements.set(reference.id, uploaded);
      for (const [entityId, current] of this.#references) {
        if (current.id === reference.id) this.#references.set(entityId, uploaded);
      }
      this.#uploads.set(blob, Promise.resolve(uploaded));
      try {
        await this.#cache.delete(reference.id);
      } catch (error) {
        this.#onCacheError(error);
      }
    }
    for (const message of rewritten) replacePendingReferences(message, replacements);
    return rewritten;
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
    thumbnail: Blob | undefined,
    signal: AbortSignal,
  ): Promise<HostedAssetReference> {
    if (!blob.type) throw new Error(`Cannot host ${filename}: its media type is missing`);
    let idempotencyKey = this.#uploadKeys.get(blob);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      this.#uploadKeys.set(blob, idempotencyKey);
    }
    const contentHash = this.#getContentHash(blob, signal);
    const grant = await this.#api.reserveAssetUpload(
      this.#workspaceId,
      {
        byteLength: blob.size,
        contentHash: await contentHash,
        contentType: blob.type,
        mediaType,
        originalFilename: filename,
        ...(thumbnail
          ? {
              thumbnail: {
                byteLength: thumbnail.size,
                contentHash: await sha256Blob(thumbnail, signal),
                contentType: "image/webp" as const,
                data: await blobToBase64(thumbnail),
              },
            }
          : {}),
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
    this.#onUploadComplete();
    return { ...finalized.asset, mediaType: parseMediaType(finalized.asset.mediaType) };
  }

  #getContentHash(blob: Blob, signal: AbortSignal): Promise<string> {
    let contentHash = this.#hashes.get(blob);
    if (!contentHash) {
      contentHash = sha256Blob(blob, signal);
      this.#hashes.set(blob, contentHash);
    }
    return contentHash;
  }

  async #uploadOrQueue(
    blob: Blob,
    filename: string,
    mediaType: HostedAssetReference["mediaType"],
    thumbnail: Blob | undefined,
    signal: AbortSignal,
  ): Promise<HostedAssetReference> {
    if (navigator.onLine !== false) {
      try {
        return await this.#upload(blob, filename, mediaType, thumbnail, signal);
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

function parseMediaType(value: string): HostedAssetReference["mediaType"] {
  if (value === "gif" || value === "image" || value === "svg" || value === "video") return value;
  throw new Error(`Unsupported hosted media type: ${value}`);
}

async function thumbnailRequest(thumbnail: Blob) {
  return {
    byteLength: thumbnail.size,
    contentHash: await sha256Blob(thumbnail, new AbortController().signal),
    contentType: "image/webp" as const,
    data: await blobToBase64(thumbnail),
  };
}

function collectPendingReferences(
  message: ClientDurableMessage,
  output: Map<string, HostedAssetReference>,
): void {
  if (message.type !== "scene-command") return;
  const command = message.command;
  if (command.kind === "entity.create") addPendingReference(command.entity.asset, output);
  else if (command.kind === "entity.patch" && command.patch.asset) {
    addPendingReference(command.patch.asset.asset, output);
  } else if (command.kind === "scene.replace") {
    for (const entity of command.entities) addPendingReference(entity.asset, output);
  }
}

function addPendingReference(
  reference: HostedAssetReference,
  output: Map<string, HostedAssetReference>,
): void {
  if (reference.id.startsWith(LOCAL_ASSET_PREFIX)) output.set(reference.id, reference);
}

function replacePendingReferences(
  message: ClientDurableMessage,
  replacements: ReadonlyMap<string, HostedAssetReference>,
): void {
  if (message.type !== "scene-command") return;
  const command = message.command;
  if (command.kind === "entity.create") {
    command.entity.asset = replacements.get(command.entity.asset.id) ?? command.entity.asset;
  } else if (command.kind === "entity.patch" && command.patch.asset) {
    command.patch.asset.asset =
      replacements.get(command.patch.asset.asset.id) ?? command.patch.asset.asset;
  } else if (command.kind === "scene.replace") {
    for (const entity of command.entities) {
      entity.asset = replacements.get(entity.asset.id) ?? entity.asset;
    }
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
