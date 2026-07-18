import { AwsClient } from "aws4fetch";
import {
  ApiErrorCode,
  type AssetDownloadGrantResponse,
  type AssetResponse,
  type AssetUploadGrantResponse,
  type ReserveAssetUploadRequest,
  type WorkspaceAssetListResponse,
  type WorkspaceAssetSummary,
} from "@voidmesh/api-contract";
import {
  WorkspaceRole,
  canEditWorkspace,
  effectiveWorkspaceRole,
  type UserId,
  type WorkspaceId,
} from "@voidmesh/domain";
import { errorResponse, json } from "./http.ts";
import { readIdempotencyKey } from "./idempotency.ts";
import { trustedRequestOrigin } from "./web-origins.ts";

const IDENTIFIER = "[A-Za-z0-9_-]{1,128}";
const GRANT_TTL_SECONDS = 5 * 60;
const ASSET_PAGE_SIZE = 30;
const MAX_THUMBNAIL_BYTES = 128 * 1024;
const VIDEO_CONTENT_TYPES = new Set([
  "video/matroska",
  "video/mp4",
  "video/mpeg",
  "video/ogg",
  "video/quicktime",
  "video/webm",
]);

interface AssetAccessRow {
  byte_length: number;
  content_hash: string | null;
  content_type: string;
  id: string;
  lifecycle: string;
  media_type: string;
  object_key: string;
  original_filename: string;
  role: string;
  workspace_id: string;
}

interface ReservationRow extends AssetAccessRow {
  can_edit_collaborate: number;
  expires_at: number;
  expected_bytes: number;
  grant_id?: string;
  reservation_id: string;
  state: string;
  thumbnail_byte_length: number;
  thumbnail_content_hash: string | null;
  thumbnail_content_type: string | null;
  thumbnail_expected_bytes: number;
  thumbnail_object_key: string | null;
}

type AssetReadPurpose = "download" | "render";

export function isAssetPath(pathname: string): boolean {
  return /^\/v1\/workspaces\/[A-Za-z0-9_-]{1,128}\/assets(?:\/|$)/.test(pathname);
}

export function isObjectGrantPath(pathname: string): boolean {
  return /^\/v1\/object-grants\/[A-Za-z0-9_-]{1,128}$/.test(pathname);
}

export async function handleObjectGrantRequest(
  request: Request,
  env: Env,
  userId: UserId,
  requestId: string,
): Promise<Response> {
  const grantId = new URL(request.url).pathname.split("/").at(-1)!;
  const grant = await env.DB.prepare(
    `SELECT
      asset_transfer_grants.id,
      asset_transfer_grants.asset_id,
      asset_transfer_grants.operation,
      asset_transfer_grants.purpose,
      asset_transfer_grants.object_key,
      asset_transfer_grants.expected_bytes,
      asset_transfer_grants.expires_at,
      asset_transfer_grants.completed_at,
      assets.content_hash,
      assets.content_type,
      assets.original_filename,
      assets.workspace_id,
      workspaces.lifecycle AS workspace_lifecycle,
      workspace_members.removed_at,
      workspace_members.role
    FROM asset_transfer_grants
    INNER JOIN assets ON assets.id = asset_transfer_grants.asset_id
    INNER JOIN workspaces ON workspaces.id = assets.workspace_id
    LEFT JOIN workspace_members
      ON workspace_members.workspace_id = assets.workspace_id
      AND workspace_members.user_id = asset_transfer_grants.user_id
    WHERE asset_transfer_grants.id = ? AND asset_transfer_grants.user_id = ?
    `,
  )
    .bind(grantId, userId)
    .first<{
      asset_id: string;
      completed_at: number | null;
      content_hash: string | null;
      content_type: string;
      expected_bytes: number;
      expires_at: number;
      id: string;
      object_key: string;
      operation: string;
      original_filename: string;
      purpose: string;
      removed_at: number | null;
      role: string | null;
      workspace_id: string;
      workspace_lifecycle: string;
    }>();
  if (!grant) {
    return errorResponse(ApiErrorCode.notFound, "Transfer grant not found", requestId, 404);
  }
  if (
    grant.expires_at < Date.now() ||
    grant.workspace_lifecycle !== "active" ||
    grant.removed_at !== null ||
    grant.role === null
  ) {
    await auditStatement(
      env.DB,
      userId,
      grant.workspace_id as WorkspaceId,
      grant.asset_id,
      "asset.read-denied",
      requestId,
      {
        grantId,
        purpose: grant.purpose,
        reason:
          grant.expires_at < Date.now()
            ? "expired-grant"
            : grant.workspace_lifecycle !== "active"
              ? "inactive-workspace"
              : "inactive-membership",
      },
      "denied",
    ).run();
    return errorResponse(ApiErrorCode.notFound, "Transfer grant not found", requestId, 404);
  }
  if (grant.operation === "upload" && request.method === "PUT") {
    if (grant.completed_at !== null) {
      return errorResponse(
        ApiErrorCode.invalidRequest,
        "Transfer grant already used",
        requestId,
        409,
      );
    }
    const expectedChecksum = grant.content_hash ? hexToBase64(grant.content_hash) : null;
    if (expectedChecksum && request.headers.get("x-amz-checksum-sha256") !== expectedChecksum) {
      return errorResponse(
        ApiErrorCode.invalidRequest,
        "Upload checksum does not match the reservation",
        requestId,
        400,
      );
    }
    let object: R2Object;
    try {
      object = await env.ASSETS.put(grant.object_key, request.body, {
        ...(grant.content_hash ? { sha256: grant.content_hash } : {}),
        httpMetadata: { contentType: grant.content_type },
      });
    } catch {
      return errorResponse(
        ApiErrorCode.invalidRequest,
        "Uploaded bytes failed checksum verification",
        requestId,
        400,
      );
    }
    if (object.size !== grant.expected_bytes) {
      await env.ASSETS.delete(grant.object_key);
      return errorResponse(
        ApiErrorCode.invalidRequest,
        "Upload size does not match the reservation",
        requestId,
        400,
      );
    }
    return new Response(null, { status: 204 });
  }
  if (grant.operation === "download" && request.method === "GET") {
    const requestedRange = parseRange(request.headers.get("range"), grant.expected_bytes);
    if (requestedRange === false) {
      await auditStatement(
        env.DB,
        userId,
        grant.workspace_id as WorkspaceId,
        grant.asset_id,
        "asset.read-denied",
        requestId,
        { grantId, purpose: grant.purpose, reason: "invalid-range" },
        "denied",
      ).run();
      return new Response(null, {
        headers: { "content-range": `bytes */${grant.expected_bytes}` },
        status: 416,
      });
    }
    const object = await env.ASSETS.get(
      grant.object_key,
      requestedRange ? { range: requestedRange } : undefined,
    );
    if (!object) {
      await auditStatement(
        env.DB,
        userId,
        grant.workspace_id as WorkspaceId,
        grant.asset_id,
        "asset.read-denied",
        requestId,
        { grantId, purpose: grant.purpose, reason: "missing-object" },
        "denied",
      ).run();
      return errorResponse(ApiErrorCode.notFound, "Asset object not found", requestId, 404);
    }
    const servedRange = requestedRange ?? { length: object.size, offset: 0 };
    const actualBytes = servedRange.length;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE asset_transfer_grants
         SET completed_at = COALESCE(completed_at, ?), actual_bytes = ?
         WHERE id = ?`,
      ).bind(now, actualBytes, grant.id),
      auditStatement(
        env.DB,
        userId,
        grant.workspace_id as WorkspaceId,
        grant.asset_id,
        "asset.bytes-served",
        requestId,
        {
          actualBytes,
          grantId,
          purpose: grant.purpose,
          range: requestedRange
            ? `${servedRange.offset}-${servedRange.offset + servedRange.length - 1}`
            : null,
        },
      ),
    ]);
    const headers = new Headers({
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-length": String(actualBytes),
      "content-type": grant.content_type,
      "x-content-type-options": "nosniff",
    });
    if (requestedRange) {
      headers.set(
        "content-range",
        `bytes ${servedRange.offset}-${servedRange.offset + servedRange.length - 1}/${grant.expected_bytes}`,
      );
    }
    if (grant.content_type === "image/svg+xml") {
      headers.set("content-security-policy", "default-src 'none'; sandbox");
    }
    if (grant.purpose === "download") {
      headers.set("content-disposition", contentDisposition(grant.original_filename));
    }
    return new Response(object.body, {
      headers,
      status: requestedRange ? 206 : 200,
    });
  }
  return methodNotAllowed(requestId);
}

export async function handleAssetRequest(
  request: Request,
  env: Env,
  userId: UserId,
  requestId: string,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const list = pathname.match(new RegExp(`^/v1/workspaces/(${IDENTIFIER})/assets$`));
  if (list && request.method === "GET") {
    return listAssets(request, env, userId, list[1]!, requestId);
  }
  const reserve = pathname.match(new RegExp(`^/v1/workspaces/(${IDENTIFIER})/assets/uploads$`));
  if (reserve) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return reserveUpload(request, env, userId, reserve[1]!, requestId);
  }
  const finalize = pathname.match(
    new RegExp(`^/v1/workspaces/(${IDENTIFIER})/assets/uploads/(${IDENTIFIER})/finalize$`),
  );
  if (finalize) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return finalizeUpload(env, userId, finalize[1]!, finalize[2]!, requestId);
  }
  const asset = pathname.match(
    new RegExp(`^/v1/workspaces/(${IDENTIFIER})/assets/(${IDENTIFIER})$`),
  );
  if (asset) {
    if (request.method !== "DELETE") return methodNotAllowed(requestId);
    return deleteAsset(env, userId, asset[1]!, asset[2]!, requestId);
  }
  const download = pathname.match(
    new RegExp(`^/v1/workspaces/(${IDENTIFIER})/assets/(${IDENTIFIER})/download$`),
  );
  if (download) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return createReadGrant(request, env, userId, download[1]!, download[2]!, "download", requestId);
  }
  const content = pathname.match(
    new RegExp(`^/v1/workspaces/(${IDENTIFIER})/assets/(${IDENTIFIER})/content$`),
  );
  if (content) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return createReadGrant(request, env, userId, content[1]!, content[2]!, "render", requestId);
  }
  const thumbnail = pathname.match(
    new RegExp(`^/v1/workspaces/(${IDENTIFIER})/assets/(${IDENTIFIER})/thumbnail$`),
  );
  if (thumbnail) {
    if (request.method !== "GET") return methodNotAllowed(requestId);
    return readThumbnail(env, userId, thumbnail[1]!, thumbnail[2]!, requestId);
  }
  return errorResponse(ApiErrorCode.notFound, "Route not found", requestId, 404);
}

async function reserveUpload(
  request: Request,
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  requestId: string,
): Promise<Response> {
  const role = await readActiveRole(env.DB, userId, workspaceId);
  if (!role) return errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);
  if (!canEditWorkspace(role)) {
    return errorResponse(ApiErrorCode.forbidden, "Edit access required", requestId, 403);
  }
  const input = await readReserveRequest(request);
  if (!input) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "Invalid asset upload request",
      requestId,
      400,
    );
  }
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "A UUID Idempotency-Key header is required",
      requestId,
      400,
    );
  }
  const replay = await replayUploadReservation(
    request,
    env,
    userId,
    workspaceId,
    idempotencyKey,
    input,
    requestId,
  );
  if (replay) return replay;

  const assetId = crypto.randomUUID();
  const reservationId = crypto.randomUUID();
  const grantId = crypto.randomUUID();
  const objectKey = `assets/${workspaceId}/${assetId}/${crypto.randomUUID()}`;
  const thumbnailObjectKey = input.thumbnail
    ? `assets/${workspaceId}/${assetId}/thumbnail-${crypto.randomUUID()}.webp`
    : null;
  const now = Date.now();
  const expiresAt = now + GRANT_TTL_SECONDS * 1000;
  const uploadUrl = await signObjectUrl(
    env,
    objectKey,
    grantId,
    "PUT",
    trustedRequestOrigin(env, request),
    input.contentType,
    input.contentHash,
  );

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO assets (
          id, workspace_id, uploaded_by_user_id, object_key, content_hash, media_type, content_type,
          original_filename, byte_length, lifecycle, created_at, updated_at,
          thumbnail_object_key, thumbnail_content_hash, thumbnail_content_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'reserved', ?, ?, ?, ?, ?)`,
      ).bind(
        assetId,
        workspaceId,
        userId,
        objectKey,
        input.contentHash ?? null,
        input.mediaType,
        input.contentType,
        input.originalFilename,
        now,
        now,
        thumbnailObjectKey,
        input.thumbnail?.contentHash ?? null,
        input.thumbnail?.contentType ?? null,
      ),
      env.DB.prepare(
        `INSERT INTO upload_reservations (
          id, workspace_id, asset_id, actor_user_id, expected_bytes, reserved_bytes,
          thumbnail_expected_bytes, state, idempotency_key, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      ).bind(
        reservationId,
        workspaceId,
        assetId,
        userId,
        input.byteLength,
        input.byteLength + (input.thumbnail?.byteLength ?? 0),
        input.thumbnail?.byteLength ?? 0,
        idempotencyKey,
        expiresAt,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO asset_transfer_grants (
          id, workspace_id, asset_id, user_id, operation, purpose, object_key,
          expected_bytes, expires_at, created_at
        ) VALUES (?, ?, ?, ?, 'upload', 'upload', ?, ?, ?, ?)`,
      ).bind(grantId, workspaceId, assetId, userId, objectKey, input.byteLength, expiresAt, now),
      auditStatement(env.DB, userId, workspaceId, assetId, "asset.upload-reserve", requestId, {
        byteLength: input.byteLength,
        grantId,
        thumbnailByteLength: input.thumbnail?.byteLength ?? 0,
      }),
    ]);
  } catch (error) {
    if (isQuotaError(error)) {
      return errorResponse(ApiErrorCode.quotaExceeded, quotaMessage(error), requestId, 403);
    }
    const concurrentReplay = await replayUploadReservation(
      request,
      env,
      userId,
      workspaceId,
      idempotencyKey,
      input,
      requestId,
    );
    if (concurrentReplay) return concurrentReplay;
    throw error;
  }

  if (input.thumbnail && thumbnailObjectKey) {
    try {
      const bytes = decodeBase64(input.thumbnail.data);
      await env.ASSETS.put(thumbnailObjectKey, bytes, {
        sha256: input.thumbnail.contentHash,
        httpMetadata: { contentType: input.thumbnail.contentType },
      });
    } catch (error) {
      await env.DB.prepare(
        "UPDATE upload_reservations SET state = 'failed', updated_at = ? WHERE id = ?",
      )
        .bind(Date.now(), reservationId)
        .run();
      throw error;
    }
  }

  const body: AssetUploadGrantResponse = {
    assetId,
    expiresAt,
    headers: uploadHeaders(input.contentType, input.contentHash),
    reservationId,
    uploadUrl,
  };
  return json(body, 201);
}

async function replayUploadReservation(
  request: Request,
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  idempotencyKey: string,
  input: ReserveAssetUploadRequest,
  requestId: string,
): Promise<Response | null> {
  const reservation = await env.DB.prepare(
    `SELECT
      upload_reservations.id AS reservation_id,
      upload_reservations.expected_bytes,
      upload_reservations.thumbnail_expected_bytes,
      upload_reservations.state,
      upload_reservations.expires_at,
      assets.id,
      assets.workspace_id,
      assets.object_key,
      assets.content_hash,
      assets.media_type,
      assets.content_type,
      assets.original_filename,
      assets.byte_length,
      assets.lifecycle,
      assets.thumbnail_object_key,
      assets.thumbnail_content_hash,
      assets.thumbnail_content_type,
      assets.thumbnail_byte_length,
      asset_transfer_grants.id AS grant_id,
      1 AS can_edit_collaborate,
      'owner' AS role
    FROM upload_reservations
    INNER JOIN assets ON assets.id = upload_reservations.asset_id
    INNER JOIN asset_transfer_grants
      ON asset_transfer_grants.asset_id = assets.id
      AND asset_transfer_grants.operation = 'upload'
    WHERE upload_reservations.actor_user_id = ?
      AND upload_reservations.idempotency_key = ?`,
  )
    .bind(userId, idempotencyKey)
    .first<ReservationRow>();
  if (!reservation) return null;
  if (
    reservation.workspace_id !== workspaceId ||
    reservation.expected_bytes !== input.byteLength ||
    reservation.content_hash !== (input.contentHash ?? null) ||
    reservation.content_type !== input.contentType ||
    reservation.media_type !== input.mediaType ||
    reservation.original_filename !== input.originalFilename ||
    reservation.thumbnail_expected_bytes !== (input.thumbnail?.byteLength ?? 0) ||
    reservation.thumbnail_content_hash !== (input.thumbnail?.contentHash ?? null) ||
    reservation.thumbnail_content_type !== (input.thumbnail?.contentType ?? null)
  ) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "Idempotency-Key was already used with a different request",
      requestId,
      409,
    );
  }
  if (reservation.state !== "pending" || reservation.expires_at <= Date.now()) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "The original upload reservation is no longer pending",
      requestId,
      409,
    );
  }
  const uploadUrl = await signObjectUrl(
    env,
    reservation.object_key,
    reservation.grant_id!,
    "PUT",
    trustedRequestOrigin(env, request),
    reservation.content_type,
    reservation.content_hash ?? undefined,
    Math.max(1, Math.ceil((reservation.expires_at - Date.now()) / 1_000)),
  );
  return json({
    assetId: reservation.id,
    expiresAt: reservation.expires_at,
    headers: uploadHeaders(reservation.content_type, reservation.content_hash ?? undefined),
    reservationId: reservation.reservation_id,
    uploadUrl,
  } satisfies AssetUploadGrantResponse);
}

async function finalizeUpload(
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  reservationId: string,
  requestId: string,
): Promise<Response> {
  const reservation = await env.DB.prepare(
    `SELECT
      upload_reservations.id AS reservation_id,
      upload_reservations.expected_bytes,
      upload_reservations.thumbnail_expected_bytes,
      upload_reservations.state,
      upload_reservations.expires_at,
      assets.id,
      assets.workspace_id,
      assets.object_key,
      assets.content_hash,
      assets.media_type,
      assets.content_type,
      assets.original_filename,
      assets.byte_length,
      assets.lifecycle,
      assets.thumbnail_object_key,
      assets.thumbnail_content_hash,
      assets.thumbnail_content_type,
      assets.thumbnail_byte_length,
      workspace_members.role,
      account_entitlements.can_edit_collaborate
    FROM upload_reservations
    INNER JOIN assets ON assets.id = upload_reservations.asset_id
    INNER JOIN workspace_members
      ON workspace_members.workspace_id = upload_reservations.workspace_id
    INNER JOIN workspaces ON workspaces.id = upload_reservations.workspace_id
    INNER JOIN account_entitlements
      ON account_entitlements.account_id = workspaces.owner_account_id
    WHERE upload_reservations.id = ?
      AND upload_reservations.workspace_id = ?
      AND workspace_members.user_id = ?
      AND workspace_members.removed_at IS NULL
      AND workspaces.lifecycle = 'active'`,
  )
    .bind(reservationId, workspaceId, userId)
    .first<ReservationRow>();
  if (!reservation) {
    return errorResponse(ApiErrorCode.notFound, "Upload reservation not found", requestId, 404);
  }
  if (
    !canEditWorkspace(
      effectiveWorkspaceRole(toRole(reservation.role), reservation.can_edit_collaborate === 1),
    )
  ) {
    return errorResponse(ApiErrorCode.forbidden, "Edit access required", requestId, 403);
  }
  if (reservation.state !== "pending") {
    if (reservation.state === "finalized") {
      return assetResponse(reservation, workspaceId);
    }
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "Upload is no longer pending",
      requestId,
      409,
    );
  }

  const object = await env.ASSETS.head(reservation.object_key);
  if (!object) {
    return errorResponse(ApiErrorCode.invalidRequest, "Uploaded object not found", requestId, 409);
  }
  const now = Date.now();
  const thumbnail = reservation.thumbnail_object_key
    ? await env.ASSETS.head(reservation.thumbnail_object_key)
    : null;
  if (
    reservation.thumbnail_object_key &&
    (!thumbnail || thumbnail.size !== reservation.thumbnail_expected_bytes)
  ) {
    await env.ASSETS.delete([reservation.object_key, reservation.thumbnail_object_key]);
    await env.DB.prepare(
      "UPDATE upload_reservations SET state = 'failed', updated_at = ? WHERE id = ?",
    )
      .bind(now, reservationId)
      .run();
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "Uploaded thumbnail is missing or invalid",
      requestId,
      409,
    );
  }
  const objectContentType = object.httpMetadata?.contentType?.toLowerCase();
  if (objectContentType && objectContentType !== reservation.content_type) {
    await env.ASSETS.delete(reservation.object_key);
    await env.DB.prepare(
      "UPDATE upload_reservations SET state = 'failed', updated_at = ? WHERE id = ?",
    )
      .bind(now, reservationId)
      .run();
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "Uploaded object content type does not match the reservation",
      requestId,
      400,
    );
  }
  if (object.size !== reservation.expected_bytes) {
    await env.ASSETS.delete(reservation.object_key);
    await env.DB.prepare(
      "UPDATE upload_reservations SET state = 'failed', updated_at = ? WHERE id = ?",
    )
      .bind(now, reservationId)
      .run();
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "Uploaded object size does not match the reservation",
      requestId,
      400,
    );
  }
  const objectChecksum = object.checksums.sha256
    ? bytesToHex(new Uint8Array(object.checksums.sha256))
    : null;
  if (reservation.content_hash && objectChecksum !== reservation.content_hash) {
    await env.ASSETS.delete(reservation.object_key);
    await env.DB.prepare(
      "UPDATE upload_reservations SET state = 'failed', updated_at = ? WHERE id = ?",
    )
      .bind(now, reservationId)
      .run();
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "Uploaded bytes failed checksum verification",
      requestId,
      400,
    );
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE upload_reservations
       SET state = 'finalized', actual_bytes = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(object.size, now, reservationId),
    env.DB.prepare(
      `UPDATE assets
       SET thumbnail_byte_length = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(thumbnail?.size ?? 0, now, reservation.id),
    env.DB.prepare(
      `UPDATE workspaces
       SET used_bytes = used_bytes + ?, updated_at = ?
       WHERE id = ?`,
    ).bind(thumbnail?.size ?? 0, now, workspaceId),
    env.DB.prepare(
      `UPDATE asset_transfer_grants
       SET completed_at = ?, actual_bytes = ?
       WHERE asset_id = ? AND operation = 'upload' AND completed_at IS NULL`,
    ).bind(now, object.size, reservation.id),
    auditStatement(
      env.DB,
      userId,
      workspaceId,
      reservation.id,
      "asset.upload-finalize",
      requestId,
      {
        actualBytes: object.size,
        thumbnailBytes: thumbnail?.size ?? 0,
      },
    ),
  ]);

  return assetResponse({ ...reservation, byte_length: object.size }, workspaceId);
}

function assetResponse(reservation: ReservationRow, workspaceId: WorkspaceId): Response {
  const body: AssetResponse = {
    asset: {
      byteLength: reservation.byte_length,
      contentHash: reservation.content_hash,
      contentType: reservation.content_type,
      id: reservation.id,
      mediaType: reservation.media_type,
      originalFilename: reservation.original_filename,
      workspaceId,
    },
  };
  return json(body);
}

async function listAssets(
  request: Request,
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  requestId: string,
): Promise<Response> {
  const role = await readActiveRole(env.DB, userId, workspaceId);
  if (!role) return errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);
  const url = new URL(request.url);
  const usage = url.searchParams.get("usage") ?? "all";
  if (usage !== "all" && usage !== "active" && usage !== "unused") {
    return errorResponse(ApiErrorCode.invalidRequest, "Invalid asset usage filter", requestId, 400);
  }
  const cursor = readAssetCursor(url.searchParams.get("cursor"));
  if (url.searchParams.has("cursor") && !cursor) {
    return errorResponse(ApiErrorCode.invalidRequest, "Invalid asset cursor", requestId, 400);
  }
  const lifecycleClause =
    usage === "active"
      ? "assets.lifecycle = 'active'"
      : usage === "unused"
        ? "assets.lifecycle IN ('verified', 'unreferenced')"
        : "assets.lifecycle IN ('verified', 'active', 'unreferenced')";
  const rows = await env.DB.prepare(
    `SELECT
       assets.id, assets.workspace_id, assets.content_hash, assets.media_type,
       assets.content_type, assets.original_filename, assets.byte_length,
       assets.lifecycle, assets.created_at, assets.unreferenced_at,
       assets.thumbnail_object_key
     FROM assets
     WHERE assets.workspace_id = ? AND ${lifecycleClause}
       AND (? IS NULL OR assets.created_at < ? OR (assets.created_at = ? AND assets.id < ?))
     ORDER BY assets.created_at DESC, assets.id DESC
     LIMIT ?`,
  )
    .bind(
      workspaceId,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      ASSET_PAGE_SIZE + 1,
    )
    .all<{
      byte_length: number;
      content_hash: string | null;
      content_type: string;
      created_at: number;
      id: string;
      lifecycle: string;
      media_type: string;
      original_filename: string;
      thumbnail_object_key: string | null;
      unreferenced_at: number | null;
      workspace_id: WorkspaceId;
    }>();
  const page = rows.results.slice(0, ASSET_PAGE_SIZE);
  const assets: WorkspaceAssetSummary[] = page.map((asset) => ({
    byteLength: asset.byte_length,
    contentHash: asset.content_hash,
    contentType: asset.content_type,
    createdAt: asset.created_at,
    id: asset.id,
    mediaType: asset.media_type,
    originalFilename: asset.original_filename,
    thumbnailUrl: asset.thumbnail_object_key
      ? `/v1/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(asset.id)}/thumbnail`
      : null,
    unreferencedAt: asset.unreferenced_at,
    usage: asset.lifecycle === "active" ? "active" : "unused",
    workspaceId: asset.workspace_id,
  }));
  const totals = await env.DB.prepare(
    `SELECT
       workspaces.used_bytes,
       workspaces.reserved_bytes,
       COALESCE(SUM(CASE WHEN assets.lifecycle = 'active'
         THEN assets.byte_length + assets.thumbnail_byte_length ELSE 0 END), 0) AS active_bytes,
       COALESCE(SUM(CASE WHEN assets.lifecycle IN ('verified', 'unreferenced')
         THEN assets.byte_length + assets.thumbnail_byte_length ELSE 0 END), 0) AS unused_bytes
     FROM workspaces
     LEFT JOIN assets ON assets.workspace_id = workspaces.id
     WHERE workspaces.id = ?
     GROUP BY workspaces.id`,
  )
    .bind(workspaceId)
    .first<{
      active_bytes: number;
      reserved_bytes: number;
      unused_bytes: number;
      used_bytes: number;
    }>();
  const last = page.at(-1);
  const body: WorkspaceAssetListResponse = {
    assets,
    nextCursor:
      rows.results.length > ASSET_PAGE_SIZE && last ? `${last.created_at}:${last.id}` : null,
    storage: {
      activeBytes: totals?.active_bytes ?? 0,
      reservedBytes: totals?.reserved_bytes ?? 0,
      totalUsedBytes: totals?.used_bytes ?? 0,
      unusedBytes: totals?.unused_bytes ?? 0,
    },
  };
  return json(body);
}

async function readThumbnail(
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  assetId: string,
  requestId: string,
): Promise<Response> {
  const asset = await env.DB.prepare(
    `SELECT assets.thumbnail_object_key, assets.thumbnail_content_type
     FROM assets
     INNER JOIN workspace_members ON workspace_members.workspace_id = assets.workspace_id
     INNER JOIN workspaces ON workspaces.id = assets.workspace_id
     WHERE assets.id = ? AND assets.workspace_id = ?
       AND assets.lifecycle IN ('verified', 'active', 'unreferenced')
       AND assets.thumbnail_object_key IS NOT NULL
       AND workspace_members.user_id = ? AND workspace_members.removed_at IS NULL
       AND workspaces.lifecycle = 'active'`,
  )
    .bind(assetId, workspaceId, userId)
    .first<{ thumbnail_content_type: string; thumbnail_object_key: string }>();
  if (!asset) return errorResponse(ApiErrorCode.notFound, "Thumbnail not found", requestId, 404);
  const object = await env.ASSETS.get(asset.thumbnail_object_key);
  if (!object) return errorResponse(ApiErrorCode.notFound, "Thumbnail not found", requestId, 404);
  return new Response(object.body, {
    headers: {
      "cache-control": "private, max-age=3600",
      "content-length": String(object.size),
      "content-type": asset.thumbnail_content_type,
      "x-content-type-options": "nosniff",
    },
  });
}

async function deleteAsset(
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  assetId: string,
  requestId: string,
): Promise<Response> {
  const asset = await env.DB.prepare(
    `SELECT
       assets.object_key, assets.thumbnail_object_key, assets.byte_length,
       assets.thumbnail_byte_length, assets.lifecycle, workspace_members.role
     FROM assets
     INNER JOIN workspace_members ON workspace_members.workspace_id = assets.workspace_id
     INNER JOIN workspaces ON workspaces.id = assets.workspace_id
     WHERE assets.id = ? AND assets.workspace_id = ?
       AND workspace_members.user_id = ? AND workspace_members.removed_at IS NULL
       AND workspaces.lifecycle = 'active'`,
  )
    .bind(assetId, workspaceId, userId)
    .first<{
      byte_length: number;
      lifecycle: string;
      object_key: string;
      role: string;
      thumbnail_byte_length: number;
      thumbnail_object_key: string | null;
    }>();
  if (!asset) return errorResponse(ApiErrorCode.notFound, "Asset not found", requestId, 404);
  if (asset.role !== WorkspaceRole.owner) {
    return errorResponse(ApiErrorCode.forbidden, "Owner access required", requestId, 403);
  }
  if (asset.lifecycle !== "verified" && asset.lifecycle !== "unreferenced") {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "Only unused media can be deleted",
      requestId,
      409,
    );
  }
  const keys = [asset.object_key, asset.thumbnail_object_key].filter(
    (key): key is string => key !== null,
  );
  await env.ASSETS.delete(keys);
  const bytes = asset.byte_length + asset.thumbnail_byte_length;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM asset_transfer_grants WHERE asset_id = ?").bind(assetId),
    env.DB.prepare("DELETE FROM upload_reservations WHERE asset_id = ?").bind(assetId),
    env.DB.prepare("DELETE FROM assets WHERE id = ? AND workspace_id = ?").bind(
      assetId,
      workspaceId,
    ),
    env.DB.prepare(
      `UPDATE workspaces
       SET used_bytes = MAX(0, used_bytes - ?), updated_at = ?
       WHERE id = ?`,
    ).bind(bytes, Date.now(), workspaceId),
    auditStatement(env.DB, userId, workspaceId, assetId, "asset.deleted", requestId, { bytes }),
  ]);
  return new Response(null, { status: 204 });
}

function readAssetCursor(value: string | null): { createdAt: number; id: string } | null {
  if (!value) return null;
  const separator = value.indexOf(":");
  const createdAt = Number(value.slice(0, separator));
  const id = value.slice(separator + 1);
  return separator > 0 && Number.isSafeInteger(createdAt) && createdAt >= 0 && isIdentifierValue(id)
    ? { createdAt, id }
    : null;
}

async function createReadGrant(
  request: Request,
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  assetId: string,
  purpose: AssetReadPurpose,
  requestId: string,
): Promise<Response> {
  const asset = await env.DB.prepare(
    `SELECT
      assets.id, assets.workspace_id, assets.object_key, assets.media_type,
      assets.content_type, assets.original_filename, assets.byte_length,
      assets.lifecycle, workspace_members.role
    FROM assets
    INNER JOIN workspace_members ON workspace_members.workspace_id = assets.workspace_id
    INNER JOIN workspaces ON workspaces.id = assets.workspace_id
    WHERE assets.id = ? AND assets.workspace_id = ?
      AND (
        assets.lifecycle = 'active'
        OR (
          assets.lifecycle IN ('verified', 'unreferenced')
          AND ? = 'render'
        )
      )
      AND workspace_members.user_id = ? AND workspace_members.removed_at IS NULL
      AND workspaces.lifecycle = 'active'`,
  )
    .bind(assetId, workspaceId, purpose, userId)
    .first<AssetAccessRow>();
  if (!asset) {
    await auditStatement(
      env.DB,
      userId,
      workspaceId,
      assetId,
      "asset.read-denied",
      requestId,
      { purpose, reason: "asset-or-membership-not-found" },
      "denied",
    ).run();
    return errorResponse(ApiErrorCode.notFound, "Asset not found", requestId, 404);
  }

  const grantId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + GRANT_TTL_SECONDS * 1000;
  const downloadUrl = objectGrantUrl(trustedRequestOrigin(env, request), grantId);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO asset_transfer_grants (
        id, workspace_id, asset_id, user_id, operation, purpose, object_key,
        expected_bytes, expires_at, created_at
      ) VALUES (?, ?, ?, ?, 'download', ?, ?, ?, ?, ?)`,
    ).bind(
      grantId,
      workspaceId,
      assetId,
      userId,
      purpose,
      asset.object_key,
      asset.byte_length,
      expiresAt,
      now,
    ),
    auditStatement(env.DB, userId, workspaceId, assetId, "asset.read-authorized", requestId, {
      byteLength: asset.byte_length,
      grantId,
      purpose,
      role: asset.role,
    }),
    ...(purpose === "download"
      ? [
          auditStatement(
            env.DB,
            userId,
            workspaceId,
            assetId,
            "asset.download-requested",
            requestId,
            { grantId, role: asset.role },
          ),
        ]
      : []),
  ]);
  const body: AssetDownloadGrantResponse = { downloadUrl, expiresAt, grantId };
  return json(body, 201);
}

function objectGrantUrl(origin: string, grantId: string): string {
  return new URL(`/v1/object-grants/${encodeURIComponent(grantId)}`, origin).toString();
}

function parseRange(
  header: string | null,
  totalBytes: number,
): { length: number; offset: number } | false | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return false;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    const length = Math.min(suffix, totalBytes);
    return { length, offset: totalBytes - length };
  }
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalBytes - 1;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(requestedEnd) ||
    offset < 0 ||
    offset >= totalBytes ||
    requestedEnd < offset
  ) {
    return false;
  }
  const end = Math.min(requestedEnd, totalBytes - 1);
  return { length: end - offset + 1, offset };
}

function contentDisposition(filename: string): string {
  const ascii = filename.replaceAll(/[^\x20-\x7e]/g, "_").replaceAll(/["\\]/g, "_");
  return `attachment; filename="${ascii || "asset"}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function readActiveRole(
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
): Promise<WorkspaceRole | null> {
  const row = await db
    .prepare(
      `SELECT workspace_members.role, account_entitlements.can_edit_collaborate
       FROM workspace_members
       INNER JOIN workspaces ON workspaces.id = workspace_members.workspace_id
       INNER JOIN account_entitlements
         ON account_entitlements.account_id = workspaces.owner_account_id
       WHERE workspace_members.workspace_id = ? AND workspace_members.user_id = ?
         AND workspace_members.removed_at IS NULL AND workspaces.lifecycle = 'active'`,
    )
    .bind(workspaceId, userId)
    .first<{ can_edit_collaborate: number; role: string }>();
  return row ? effectiveWorkspaceRole(toRole(row.role), row.can_edit_collaborate === 1) : null;
}

async function readReserveRequest(request: Request): Promise<ReserveAssetUploadRequest | null> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object") return null;
    const byteLength = Reflect.get(value, "byteLength");
    const contentHash = Reflect.get(value, "contentHash");
    const contentType = Reflect.get(value, "contentType");
    const mediaType = Reflect.get(value, "mediaType");
    const originalFilename = Reflect.get(value, "originalFilename");
    const thumbnailValue = Reflect.get(value, "thumbnail");
    if (!Number.isSafeInteger(byteLength) || (byteLength as number) <= 0) return null;
    if (
      typeof contentType !== "string" ||
      contentType.length < 1 ||
      contentType.length > 200 ||
      contentType !== contentType.toLowerCase() ||
      contentType.includes(";")
    )
      return null;
    if (!isMediaType(mediaType)) return null;
    if (!isMediaContentType(mediaType, contentType)) return null;
    if (
      contentHash !== undefined &&
      (typeof contentHash !== "string" || !/^[a-f0-9]{64}$/.test(contentHash))
    )
      return null;
    if (
      typeof originalFilename !== "string" ||
      originalFilename.length < 1 ||
      originalFilename.length > 255
    )
      return null;
    let thumbnail: ReserveAssetUploadRequest["thumbnail"];
    if (thumbnailValue !== undefined) {
      if (!thumbnailValue || typeof thumbnailValue !== "object") return null;
      const thumbnailByteLength = Reflect.get(thumbnailValue, "byteLength");
      const thumbnailContentHash = Reflect.get(thumbnailValue, "contentHash");
      const thumbnailContentType = Reflect.get(thumbnailValue, "contentType");
      const thumbnailData = Reflect.get(thumbnailValue, "data");
      if (
        !Number.isSafeInteger(thumbnailByteLength) ||
        (thumbnailByteLength as number) <= 0 ||
        (thumbnailByteLength as number) > MAX_THUMBNAIL_BYTES ||
        thumbnailContentType !== "image/webp" ||
        typeof thumbnailContentHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(thumbnailContentHash) ||
        typeof thumbnailData !== "string"
      )
        return null;
      const bytes = decodeBase64(thumbnailData);
      if (
        bytes.byteLength !== thumbnailByteLength ||
        (await sha256Hex(bytes)) !== thumbnailContentHash
      )
        return null;
      thumbnail = {
        byteLength: thumbnailByteLength as number,
        contentHash: thumbnailContentHash,
        contentType: "image/webp",
        data: thumbnailData,
      };
    }
    return {
      byteLength: byteLength as number,
      ...(typeof contentHash === "string" ? { contentHash } : {}),
      contentType,
      mediaType,
      originalFilename,
      ...(thumbnail ? { thumbnail } : {}),
    };
  } catch {
    return null;
  }
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

function isMediaType(value: unknown): value is string {
  return value === "image" || value === "video" || value === "gif" || value === "svg";
}

function isIdentifierValue(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isMediaContentType(mediaType: string, contentType: string): boolean {
  if (mediaType === "video") return VIDEO_CONTENT_TYPES.has(contentType);
  if (mediaType === "gif") return contentType === "image/gif";
  if (mediaType === "svg") return contentType === "image/svg+xml";
  return (
    /^image\/[a-z0-9][a-z0-9.+-]{0,126}$/.test(contentType) &&
    contentType !== "image/gif" &&
    contentType !== "image/svg+xml"
  );
}

async function signObjectUrl(
  env: Env,
  objectKey: string,
  grantId: string,
  method: "GET" | "PUT",
  webOrigin: string,
  contentType?: string,
  contentHash?: string,
  ttlSeconds = GRANT_TTL_SECONDS,
): Promise<string> {
  const config = readR2Configuration(env);
  if (config.accountId === "local") {
    return new URL(`/v1/object-grants/${encodeURIComponent(grantId)}`, webOrigin).toString();
  }
  const url = new URL(
    `https://${config.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(config.bucketName)}/${objectKey
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  );
  url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
  url.searchParams.set("voidmesh-grant", grantId);
  const headers = contentType ? uploadHeaders(contentType, contentHash) : undefined;
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    region: "auto",
    secretAccessKey: config.secretAccessKey,
    service: "s3",
  });
  const signed = await client.sign(new Request(url, { headers, method }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

function uploadHeaders(contentType: string, contentHash?: string): Record<string, string> {
  return {
    "content-type": contentType,
    ...(contentHash ? { "x-amz-checksum-sha256": hexToBase64(contentHash) } : {}),
  };
}

function hexToBase64(value: string): string {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return btoa(String.fromCharCode(...bytes));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readR2Configuration(env: Env) {
  const bindings = env as unknown as Record<string, unknown>;
  const read = (name: string): string => {
    const value = bindings[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Missing required Worker binding: ${name}`);
    }
    return value;
  };
  return {
    accessKeyId: read("R2_ACCESS_KEY_ID"),
    accountId: read("R2_ACCOUNT_ID"),
    bucketName: read("R2_BUCKET_NAME"),
    secretAccessKey: read("R2_SECRET_ACCESS_KEY"),
  };
}

function toRole(role: string): WorkspaceRole {
  if (role === WorkspaceRole.owner) return WorkspaceRole.owner;
  if (role === WorkspaceRole.editor) return WorkspaceRole.editor;
  if (role === WorkspaceRole.viewer) return WorkspaceRole.viewer;
  throw new Error(`Invalid persisted workspace role: ${role}`);
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("_storage_limit_exceeded") ||
      error.message.includes("hard_asset_limit_exceeded"))
  );
}

function quotaMessage(error: unknown): string {
  return error instanceof Error && error.message.includes("hard_asset")
    ? "Asset exceeds the plan's per-asset limit"
    : "Hosted storage limit reached";
}

function auditStatement(
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
  assetId: string,
  action: string,
  requestId: string,
  metadata: Record<string, unknown>,
  outcome: "denied" | "success" = "success",
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
        id, actor_user_id, account_id, workspace_id, action, target_type,
        target_id, outcome, request_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, 'asset', ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      userId,
      userId,
      workspaceId,
      action,
      assetId,
      outcome,
      requestId,
      JSON.stringify(metadata),
      Date.now(),
    );
}

function methodNotAllowed(requestId: string): Response {
  return errorResponse(ApiErrorCode.invalidRequest, "Method not allowed", requestId, 405);
}
