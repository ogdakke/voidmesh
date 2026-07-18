import { isIdentifier } from "@voidmesh/api-contract";

const OUTBOX_BATCH_SIZE = 100;
const REQUEUE_AFTER_MS = 15 * 60 * 1000;
const DELIVERED_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SecurityAuditQueueMessage {
  eventIds: string[];
  kind: "security-audit";
}

interface SecurityAuditClaimRow {
  event_id: string;
}

export interface SecurityAuditFlushResult {
  enqueuedEventCount: number;
}

export async function flushSecurityAuditOutbox(
  env: Env,
  now = Date.now(),
): Promise<SecurityAuditFlushResult> {
  const rows = await env.DB.prepare(
    `UPDATE security_audit_outbox
     SET enqueued_at = ?
     WHERE event_id IN (
       SELECT event_id
       FROM security_audit_outbox
       WHERE delivered_at IS NULL
         AND (enqueued_at IS NULL OR enqueued_at <= ?)
       ORDER BY created_at ASC, event_id ASC
       LIMIT ?
     )
       AND delivered_at IS NULL
       AND (enqueued_at IS NULL OR enqueued_at <= ?)
     RETURNING event_id`,
  )
    .bind(now, now - REQUEUE_AFTER_MS, OUTBOX_BATCH_SIZE, now - REQUEUE_AFTER_MS)
    .all<SecurityAuditClaimRow>();
  if (rows.results.length === 0) return { enqueuedEventCount: 0 };

  await env.SECURITY_AUDIT_EVENTS.send({
    eventIds: rows.results.map((row) => row.event_id),
    kind: "security-audit",
  } satisfies SecurityAuditQueueMessage);
  return { enqueuedEventCount: rows.results.length };
}

export async function processSecurityAuditEvent(env: Env, eventId: string): Promise<void> {
  if (!isIdentifier(eventId)) throw new Error("Invalid security audit event ID");
  const row = await env.DB.prepare(
    `SELECT event_id, payload_json, created_at
     FROM security_audit_outbox WHERE event_id = ?`,
  )
    .bind(eventId)
    .first<{ created_at: number; event_id: string; payload_json: string }>();
  if (!row) return;

  const objectKey = securityAuditObjectKey(row.event_id, row.created_at);
  await env.SECURITY_AUDIT.put(objectKey, row.payload_json, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  await env.DB.prepare(
    `UPDATE security_audit_outbox SET delivered_at = ?
     WHERE event_id = ? AND delivered_at IS NULL`,
  )
    .bind(Date.now(), eventId)
    .run();
}

export async function cleanupDeliveredSecurityAuditOutbox(
  db: D1Database,
  now = Date.now(),
): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM security_audit_outbox
       WHERE delivered_at IS NOT NULL AND delivered_at <= ?`,
    )
    .bind(now - DELIVERED_OUTBOX_RETENTION_MS)
    .run();
  return result.meta.changes;
}

export function securityAuditObjectKey(eventId: string, createdAt: number): string {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.valueOf())) throw new Error("Invalid security audit timestamp");
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `security-audit/${year}/${month}/${day}/${eventId}.json`;
}
