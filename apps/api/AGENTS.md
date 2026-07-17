# Hosted API

Cloudflare Worker providing the authoritative hosted-workspace control plane and one Durable Object per live workspace.

## Ownership

- D1 owns accounts, memberships, invitation redemptions, entitlements, quota counters, asset metadata, audit events, and deletion lifecycle.
- R2 stores opaque media and snapshot bytes. R2 keys never grant access.
- `WorkspaceRoom` serializes Yjs updates and owns ephemeral WebSocket presence. Persisted snapshots are internal recovery data, not user-visible history.
- A workspace owns every uploaded asset; `uploaded_by_user_id` is attribution only. The immutable original workspace owner is billed.

## Request Invariants

- Authenticate before loading hosted resources, including view links and asset bytes.
- Authorize every workspace and asset operation from active D1 membership; re-check access when opening a socket and on permission-sensitive actions.
- Treat invitation tokens and download grants as secrets: store hashes, make grants short-lived and scoped, and never log raw values.
- Reserve quota transactionally before issuing an upload grant. One asset may cross a soft quota; after that, block further reservations.
- Write audit events for authentication, invitation, membership, upload, download, deletion, restoration, billing, and authorization outcomes.
- Treat billing-provider webhooks as signed, idempotent inputs. D1 `account_entitlements` is the authority consumed by product features; provider identifiers and SDK types stay inside the billing adapter.

## Worker Conventions

- Keep request-scoped state out of module globals.
- Generate `Env` with `wrangler types`; do not hand-write binding types.
- Use `ctx.waitUntil()` for required post-response work and handle every promise.
- Prefer streaming bodies for R2 transfers and structured JSON logs with request IDs.
- Durable Object schema migration may use `blockConcurrencyWhile`; ordinary request work may not.
