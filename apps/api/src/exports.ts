import {
  ApiErrorCode,
  type WorkspaceExportResponse,
  type WorkspaceExportSummary,
} from "@voidmesh/api-contract";
import {
  WorkspaceExportState,
  WorkspaceLifecycle,
  WorkspaceRole,
  effectiveWorkspaceRole,
  type ExportId,
  type UserId,
  type WorkspaceId,
} from "@voidmesh/domain";
import {
  archiveMediaPath,
  createVdmshManifest,
  readHostedArchiveEntities,
  type HostedArchiveAsset,
} from "@voidmesh/workspace-format";
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";
import { errorResponse, json } from "./http.ts";

const EXPORT_PATH =
  /^\/v1\/workspaces\/([A-Za-z0-9_-]{1,128})\/exports(?:\/([A-Za-z0-9_-]{1,128})(\/download)?)?$/;
const CREATE_EXPORT_PATH = /^\/v1\/workspaces\/([A-Za-z0-9_-]{1,128})\/export$/;
const EXPORT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const R2_MULTIPART_PART_BYTES = 5 * 1024 * 1024;

interface ExportAccessRow {
  can_edit_collaborate: number;
  lifecycle: string;
  owner_account_id: string;
  purge_after: number | null;
  role: string;
  title: string;
  viewport_offset_x: number | null;
  viewport_offset_y: number | null;
  viewport_zoom: number | null;
}

interface ExportRow {
  archive_object_key: string | null;
  byte_length: number | null;
  completed_at: number | null;
  created_at: number;
  filename: string;
  id: string;
  room_sequence: number;
  snapshot_object_key: string;
  state: string;
  viewport_offset_x: number;
  viewport_offset_y: number;
  viewport_zoom: number;
  workspace_id: string;
}

interface AssetRow {
  byte_length: number;
  content_type: string;
  id: string;
  lifecycle: string;
  media_type: string;
  object_key: string;
  original_filename: string;
}

export interface WorkspaceExportQueueMessage {
  exportId: ExportId;
  kind: "workspace-export";
}

export function isWorkspaceExportPath(pathname: string): boolean {
  return CREATE_EXPORT_PATH.test(pathname) || EXPORT_PATH.test(pathname);
}

export async function handleWorkspaceExportRequest(
  request: Request,
  env: Env,
  userId: UserId,
  requestId: string,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const createMatch = pathname.match(CREATE_EXPORT_PATH);
  if (createMatch) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return createWorkspaceExport(request, env, userId, createMatch[1]!, requestId);
  }
  const match = pathname.match(EXPORT_PATH);
  if (!match || !match[2]) {
    return errorResponse(ApiErrorCode.notFound, "Export not found", requestId, 404);
  }
  if (request.method !== "GET") return methodNotAllowed(requestId);
  return match[3] === "/download"
    ? downloadWorkspaceExport(env, userId, match[1]!, match[2]!, requestId)
    : getWorkspaceExport(env.DB, userId, match[1]!, match[2]!, requestId);
}

async function createWorkspaceExport(
  request: Request,
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  requestId: string,
): Promise<Response> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "A valid Idempotency-Key header is required",
      requestId,
      400,
    );
  }
  const access = await readExportAccess(env.DB, userId, workspaceId);
  if (!canCreateExport(access, userId)) {
    if (access) {
      await writeExportAudit(env.DB, {
        action: "workspace.export.create",
        actorUserId: userId,
        exportId: null,
        outcome: "denied",
        requestId,
        workspaceId,
      });
    }
    return accessError(access, requestId);
  }
  const existing = await env.DB.prepare(
    `SELECT * FROM workspace_exports
     WHERE workspace_id = ? AND requested_by_user_id = ? AND idempotency_key = ?`,
  )
    .bind(workspaceId, userId, idempotencyKey)
    .first<ExportRow>();
  if (existing) {
    if (existing.state === WorkspaceExportState.failed) {
      await env.DB.prepare(
        `UPDATE workspace_exports SET state = 'queued', error_code = NULL, updated_at = ?
         WHERE id = ?`,
      )
        .bind(Date.now(), existing.id)
        .run();
      await env.WORKSPACE_EXPORTS.send({
        exportId: existing.id,
        kind: "workspace-export",
      } satisfies WorkspaceExportQueueMessage);
      existing.state = WorkspaceExportState.queued;
    }
    return json({ export: toSummary(existing) } satisfies WorkspaceExportResponse);
  }

  const exportId = crypto.randomUUID();
  const snapshot = await env.WORKSPACE_ROOMS.getByName(workspaceId).createExportSnapshot(
    workspaceId,
    exportId,
  );
  const now = Date.now();
  const filename = exportFilename(access.title);
  const viewport = {
    offset: {
      x: access.viewport_offset_x ?? 0,
      y: access.viewport_offset_y ?? 0,
    },
    zoom: access.viewport_zoom ?? 1,
  };
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspace_exports (
            id, workspace_id, requested_by_user_id, room_sequence,
            snapshot_object_key, filename, idempotency_key,
            viewport_offset_x, viewport_offset_y, viewport_zoom,
            state, created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      ).bind(
        exportId,
        workspaceId,
        userId,
        snapshot.roomSequence,
        snapshot.objectKey,
        filename,
        idempotencyKey,
        viewport.offset.x,
        viewport.offset.y,
        viewport.zoom,
        now,
        now,
        now + EXPORT_RETENTION_MS,
      ),
      exportAuditStatement(env.DB, {
        action: "workspace.export.create",
        actorUserId: userId,
        exportId,
        outcome: "success",
        requestId,
        timestamp: now,
        workspaceId,
      }),
    ]);
    await env.WORKSPACE_EXPORTS.send({
      exportId,
      kind: "workspace-export",
    } satisfies WorkspaceExportQueueMessage);
  } catch (error) {
    await env.ASSETS.delete(snapshot.objectKey);
    throw error;
  }
  const row: ExportRow = {
    archive_object_key: null,
    byte_length: null,
    completed_at: null,
    created_at: now,
    filename,
    id: exportId,
    room_sequence: snapshot.roomSequence,
    snapshot_object_key: snapshot.objectKey,
    state: WorkspaceExportState.queued,
    viewport_offset_x: viewport.offset.x,
    viewport_offset_y: viewport.offset.y,
    viewport_zoom: viewport.zoom,
    workspace_id: workspaceId,
  };
  return json({ export: toSummary(row) } satisfies WorkspaceExportResponse, 202);
}

async function getWorkspaceExport(
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
  exportId: ExportId,
  requestId: string,
): Promise<Response> {
  const [access, row] = await Promise.all([
    readExportAccess(db, userId, workspaceId),
    readExport(db, workspaceId, exportId),
  ]);
  if (!canReadExport(access, userId) || !row) {
    return errorResponse(ApiErrorCode.notFound, "Export not found", requestId, 404);
  }
  return json({ export: toSummary(row) } satisfies WorkspaceExportResponse);
}

async function downloadWorkspaceExport(
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  exportId: ExportId,
  requestId: string,
): Promise<Response> {
  const [access, row] = await Promise.all([
    readExportAccess(env.DB, userId, workspaceId),
    readExport(env.DB, workspaceId, exportId),
  ]);
  if (!canReadExport(access, userId) || !row) {
    return errorResponse(ApiErrorCode.notFound, "Export not found", requestId, 404);
  }
  if (row.state !== WorkspaceExportState.completed || !row.archive_object_key) {
    return errorResponse(ApiErrorCode.invalidRequest, "Export is not ready", requestId, 409);
  }
  const object = await env.ASSETS.get(row.archive_object_key);
  if (!object) throw new Error("Completed workspace export object is missing");
  await writeExportAudit(env.DB, {
    action: "workspace.export.download",
    actorUserId: userId,
    exportId,
    outcome: "success",
    requestId,
    workspaceId,
  });
  return new Response(object.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": contentDisposition(row.filename),
      "content-length": String(object.size),
      "content-type": "application/vdmsh",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function processWorkspaceExport(env: Env, exportId: ExportId): Promise<void> {
  const row = await env.DB.prepare("SELECT * FROM workspace_exports WHERE id = ?")
    .bind(exportId)
    .first<ExportRow>();
  if (!row || row.state === WorkspaceExportState.completed) return;
  const startedAt = Date.now();
  await env.DB.prepare(
    `UPDATE workspace_exports SET state = 'processing', updated_at = ? WHERE id = ?`,
  )
    .bind(startedAt, exportId)
    .run();
  const archiveObjectKey = `exports/${row.workspace_id}/${row.id}/workspace.vdmsh`;
  try {
    const snapshot = await env.ASSETS.get(row.snapshot_object_key);
    if (!snapshot) throw new Error("Export source snapshot is missing");
    const source: unknown = JSON.parse(await snapshot.text());
    const entities = readHostedArchiveEntities(source, startedAt);
    const assets = await readWorkspaceAssets(env.DB, row.workspace_id);
    const referencedAssets = validateReferencedAssets(entities, assets);
    const manifest = createVdmshManifest(
      entities,
      {
        offset: {
          x: row.viewport_offset_x,
          y: row.viewport_offset_y,
        },
        zoom: row.viewport_zoom,
      },
      new Date(startedAt).toISOString(),
    );
    const object = await writeZipArchive(env.ASSETS, archiveObjectKey, manifest, referencedAssets);
    const completedAt = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workspace_exports SET
             archive_object_key = ?, byte_length = ?, state = 'completed',
             completed_at = ?, updated_at = ?, error_code = NULL
           WHERE id = ?`,
      ).bind(archiveObjectKey, object.size, completedAt, completedAt, exportId),
      exportAuditStatement(env.DB, {
        action: "workspace.export.complete",
        actorUserId: null,
        exportId,
        outcome: "success",
        requestId: `queue:${exportId}`,
        timestamp: completedAt,
        workspaceId: row.workspace_id,
      }),
    ]);
  } catch (error) {
    const failedAt = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workspace_exports SET state = 'failed', error_code = ?, updated_at = ?
           WHERE id = ?`,
      ).bind("archive-build-failed", failedAt, exportId),
      exportAuditStatement(env.DB, {
        action: "workspace.export.complete",
        actorUserId: null,
        exportId,
        outcome: "denied",
        requestId: `queue:${exportId}`,
        timestamp: failedAt,
        workspaceId: row.workspace_id,
      }),
    ]);
    await env.ASSETS.delete(archiveObjectKey);
    throw error;
  }
}

async function writeZipArchive(
  bucket: R2Bucket,
  objectKey: string,
  manifest: unknown,
  assets: readonly AssetRow[],
): Promise<R2Object> {
  const multipart = await bucket.createMultipartUpload(objectKey, {
    httpMetadata: {
      contentDisposition: "attachment",
      contentType: "application/vdmsh",
    },
  });
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let zipError: Error | null = null;
  const uploadedParts: R2UploadedPart[] = [];
  const zip = new Zip((error, bytes, final) => {
    if (error) {
      zipError = error;
      return;
    }
    if (bytes.byteLength > 0) {
      pending.push(bytes);
      pendingBytes += bytes.byteLength;
    }
    if (final && pendingBytes === 0) {
      zipError = new Error("Workspace export archive is empty");
    }
  });
  const flushParts = async (final: boolean): Promise<void> => {
    if (zipError) throw zipError;
    while (pendingBytes >= R2_MULTIPART_PART_BYTES || (final && pendingBytes > 0)) {
      const byteLength = final
        ? Math.min(pendingBytes, R2_MULTIPART_PART_BYTES)
        : R2_MULTIPART_PART_BYTES;
      const bytes = consumeBytes(pending, byteLength);
      pendingBytes -= byteLength;
      uploadedParts.push(await multipart.uploadPart(uploadedParts.length + 1, bytes));
    }
  };
  try {
    const manifestEntry = new ZipDeflate("manifest.json", { level: 6 });
    zip.add(manifestEntry);
    manifestEntry.push(strToU8(JSON.stringify(manifest, null, 2)), true);
    await flushParts(false);

    for (const asset of assets) {
      const object = await bucket.get(asset.object_key);
      if (!object) throw new Error(`Hosted asset object is missing: ${asset.id}`);
      const entry = new ZipPassThrough(
        archiveMediaPath({
          byteLength: asset.byte_length,
          contentType: asset.content_type,
          id: asset.id,
          mediaType: toMediaType(asset.media_type),
          originalFilename: asset.original_filename,
        }),
      );
      zip.add(entry);
      const reader = object.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        entry.push(chunk.value, false);
        await flushParts(false);
      }
      entry.push(new Uint8Array(), true);
      await flushParts(false);
    }
    zip.end();
    await flushParts(true);
    return await multipart.complete(uploadedParts);
  } catch (error) {
    await multipart.abort().catch(() => {});
    throw error;
  }
}

function consumeBytes(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const chunk = chunks[0];
    if (!chunk) throw new Error("ZIP output accounting mismatch");
    const count = Math.min(chunk.byteLength, byteLength - offset);
    output.set(chunk.subarray(0, count), offset);
    offset += count;
    if (count === chunk.byteLength) chunks.shift();
    else chunks[0] = chunk.subarray(count);
  }
  return output;
}

async function readWorkspaceAssets(
  db: D1Database,
  workspaceId: WorkspaceId,
): Promise<Map<string, AssetRow>> {
  const result = await db
    .prepare(
      `SELECT id, object_key, media_type, content_type, original_filename,
              byte_length, lifecycle
       FROM assets WHERE workspace_id = ? AND lifecycle IN ('active', 'unreferenced')`,
    )
    .bind(workspaceId)
    .all<AssetRow>();
  return new Map(result.results.map((asset) => [asset.id, asset]));
}

function validateReferencedAssets(
  entities: readonly { asset: HostedArchiveAsset }[],
  assets: ReadonlyMap<string, AssetRow>,
): AssetRow[] {
  const referenced = new Map<string, AssetRow>();
  for (const entity of entities) {
    const row = assets.get(entity.asset.id);
    if (
      !row ||
      row.byte_length !== entity.asset.byteLength ||
      row.content_type !== entity.asset.contentType ||
      row.media_type !== entity.asset.mediaType ||
      row.original_filename !== entity.asset.originalFilename
    ) {
      throw new Error(`Invalid hosted asset reference: ${entity.asset.id}`);
    }
    referenced.set(row.id, row);
  }
  return [...referenced.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function readExportAccess(
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
): Promise<ExportAccessRow | null> {
  return db
    .prepare(
      `SELECT
         workspaces.owner_account_id,
         workspaces.title,
         workspaces.lifecycle,
         workspaces.purge_after,
         workspace_members.role,
         account_entitlements.can_edit_collaborate,
         workspace_view_states.offset_x AS viewport_offset_x,
         workspace_view_states.offset_y AS viewport_offset_y,
         workspace_view_states.zoom AS viewport_zoom
       FROM workspace_members
       INNER JOIN workspaces ON workspaces.id = workspace_members.workspace_id
       INNER JOIN account_entitlements
         ON account_entitlements.account_id = workspaces.owner_account_id
       LEFT JOIN workspace_view_states
         ON workspace_view_states.workspace_id = workspaces.id
         AND workspace_view_states.user_id = workspace_members.user_id
       WHERE workspace_members.workspace_id = ?
         AND workspace_members.user_id = ?
         AND workspace_members.removed_at IS NULL`,
    )
    .bind(workspaceId, userId)
    .first<ExportAccessRow>();
}

function canCreateExport(
  access: ExportAccessRow | null,
  userId: UserId,
): access is ExportAccessRow {
  return canReadExport(access, userId);
}

function canReadExport(access: ExportAccessRow | null, userId: UserId): access is ExportAccessRow {
  if (!access) return false;
  if (access.lifecycle === WorkspaceLifecycle.active) {
    const role = effectiveWorkspaceRole(toRole(access.role), access.can_edit_collaborate === 1);
    return role === WorkspaceRole.owner || role === WorkspaceRole.editor;
  }
  return (
    access.lifecycle === WorkspaceLifecycle.deleted &&
    access.owner_account_id === userId &&
    access.purge_after !== null &&
    access.purge_after > Date.now()
  );
}

function accessError(access: ExportAccessRow | null, requestId: string): Response {
  return access && access.lifecycle === WorkspaceLifecycle.active
    ? errorResponse(ApiErrorCode.forbidden, "Owner or editor access required", requestId, 403)
    : errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);
}

async function readExport(
  db: D1Database,
  workspaceId: WorkspaceId,
  exportId: ExportId,
): Promise<ExportRow | null> {
  return db
    .prepare(
      `SELECT * FROM workspace_exports
       WHERE id = ? AND workspace_id = ? AND expires_at > ?`,
    )
    .bind(exportId, workspaceId, Date.now())
    .first<ExportRow>();
}

function toSummary(row: ExportRow): WorkspaceExportSummary {
  return {
    byteLength: row.byte_length,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    filename: row.filename,
    id: row.id,
    roomSequence: row.room_sequence,
    state: toExportState(row.state),
    workspaceId: row.workspace_id,
  };
}

function toExportState(value: string): WorkspaceExportState {
  if (value === WorkspaceExportState.queued) return WorkspaceExportState.queued;
  if (value === WorkspaceExportState.processing) return WorkspaceExportState.processing;
  if (value === WorkspaceExportState.completed) return WorkspaceExportState.completed;
  if (value === WorkspaceExportState.failed) return WorkspaceExportState.failed;
  throw new Error(`Invalid persisted workspace export state: ${value}`);
}

function toRole(value: string): WorkspaceRole {
  if (value === WorkspaceRole.owner) return WorkspaceRole.owner;
  if (value === WorkspaceRole.editor) return WorkspaceRole.editor;
  if (value === WorkspaceRole.viewer) return WorkspaceRole.viewer;
  throw new Error(`Invalid persisted workspace role: ${value}`);
}

function toMediaType(value: string): HostedArchiveAsset["mediaType"] {
  if (value === "gif" || value === "image" || value === "svg" || value === "video") {
    return value;
  }
  throw new Error(`Invalid persisted asset media type: ${value}`);
}

function exportFilename(title: string): string {
  const printableTitle = [...title.normalize("NFKC")]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("");
  const basename = printableTitle
    .replaceAll(/[/\\:*?"<>|]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return `${basename || "Voidmesh workspace"}.vdmsh`;
}

function contentDisposition(filename: string): string {
  const ascii = filename.replaceAll(/[^\x20-\x7e]/g, "_").replaceAll(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function methodNotAllowed(requestId: string): Response {
  return errorResponse(ApiErrorCode.invalidRequest, "Method not allowed", requestId, 405);
}

async function writeExportAudit(
  db: D1Database,
  input: {
    action: string;
    actorUserId: UserId;
    exportId: ExportId | null;
    outcome: "denied" | "success";
    requestId: string;
    workspaceId: WorkspaceId;
  },
): Promise<void> {
  await exportAuditStatement(db, {
    ...input,
    timestamp: Date.now(),
  }).run();
}

function exportAuditStatement(
  db: D1Database,
  input: {
    action: string;
    actorUserId: UserId | null;
    exportId: ExportId | null;
    outcome: "denied" | "success";
    requestId: string;
    timestamp: number;
    workspaceId: WorkspaceId;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
         id, actor_user_id, workspace_id, action, target_type, target_id,
         outcome, request_id, created_at
       ) VALUES (?, ?, ?, ?, 'workspace-export', ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.actorUserId,
      input.workspaceId,
      input.action,
      input.exportId,
      input.outcome,
      input.requestId,
      input.timestamp,
    );
}
