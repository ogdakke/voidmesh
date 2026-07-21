# Voidmesh hosted workspaces

Status: V2 rewrite product and technical specification

## 1. Purpose

Voidmesh hosted workspaces add an account-backed cloud product to the existing local-first canvas. The hosted product persists workspaces and media, supports controlled sharing, and lets multiple authorized clients edit the same canvas in real time.

The existing local application remains useful without a hosted account. A `.vdmsh` archive remains the portable import/export format. Hosted workspaces use a decomposed document and asset model rather than treating the archive as the live storage unit.

The local canvas is the behavioral and performance reference. Hosted mode adds a sequenced command stream, remote presence, and progressive asset hydration around that canvas; it does not introduce a second resource-owning scene model. Earlier Yjs-based hosted implementations are explicitly not a compatibility target.

## 2. Product principles

- Local workspaces must not require an account or network connection.
- A hosted workspace has one stable ID and one authoritative access policy.
- The API is the only public authorization and entitlement boundary.
- Collaborators see changes quickly, but durable recovery is more important than preserving an individual connection.
- Media bytes are stored independently from the workspace document and are not retransmitted between peers.
- Presence is ephemeral. It never becomes part of workspace history or billing usage.
- Portable formats and the object-store boundary must not depend on R2-specific APIs where the S3-compatible API is sufficient.
- Limits are represented as account entitlements, not scattered product-tier conditionals.

## 3. Scope

### 3.1 Initial scope

- Account signup, login, email verification, password reset, and sessions.
- Hosted workspace creation, listing, rename, open, autosave, export, soft delete, restore, and permanent deletion.
- Direct media upload through short-lived object-store credentials and authenticated media delivery through the API.
- Workspace and account storage quotas.
- Owner, editor, and viewer access.
- Revocable view and edit invitations.
- Real-time typed scene synchronization through WebSockets.
- Offline editing through a persisted typed-command queue with explicit conflict recovery.
- Cursor and selection presence.
- Synchronized video, GIF, and animated shader playback.
- Subscription and entitlement enforcement.
- Audit records for security- and ownership-relevant actions.

### 3.2 Explicitly out of scope for the first release

- Peer-to-peer WebRTC transport, Nostr signaling, or TURN credentials.
- Anonymous workspace access.
- Branching, comments, chat, voice, or presentation mode.
- Organizations, teams, or custom roles beyond owner/editor/viewer.
- End-to-end encryption.
- A public plugin or third-party API.

## 4. Product tiers and entitlements

The commercial limits are intentionally data-driven. Exact Pro limits remain a product decision.

| Capability            |           Local free | Cloud free, proposed |             Pro, TBD |
| --------------------- | -------------------: | -------------------: | -------------------: |
| Account required      |                   No |                  Yes |                  Yes |
| Local workspaces      | Unlimited by product | Unlimited by product | Unlimited by product |
| Hosted workspaces     |                    0 |                    1 |          Entitlement |
| Hosted storage        |                    0 |  1 GiB account total |          Entitlement |
| Per-workspace storage |                    0 |                1 GiB |          Entitlement |
| Editors               |                    0 |           Owner only |          Entitlement |
| View sharing          |    Local file export |                  Yes |                  Yes |
| Edit sharing          |                   No |                   No |                  Yes |
| User-visible history  |                   No |                   No |                   No |

Cloud free is a distinct hosted tier; it does not limit the permanently free local application. Every account has exactly one active plan. Limits are enforced from an entitlement snapshot derived from that plan and its subscription state. Plans may independently raise the account-wide workspace count, account-wide storage, and per-workspace storage limits. Edit collaboration is a paid entitlement; authenticated view sharing is available on Cloud Free.

An upload may start while both the account and workspace are at or below quota, and that one asset may finish even if it crosses a soft quota. Once either scope is over quota, new uploads and asset replacements that increase stored bytes are blocked. A separate hard per-asset safety limit always applies. Existing workspaces remain readable and exportable, and byte-neutral edits, destructive operations, and operations that reduce storage remain available. A lapsed paid subscription therefore degrades to read-only-over-quota behavior rather than making customer data inaccessible.

## 5. System architecture

```mermaid
flowchart LR
    Client["React web app"] -->|HTTPS| API["Workers API"]
    Client -->|WebSocket| API
    API --> Auth["Better Auth"]
    API --> D1["D1: identity, metadata, access, billing"]
    API --> R2["R2 via object-store adapter: assets and snapshots"]
    API --> Room["Durable Object: one live workspace room"]
    Room --> RoomStorage["Durable Object SQLite: scene, operations, playback"]
    Room -.->|bounded recovery/export snapshots| R2
    Room -->|broadcast| Client
```

### 5.1 Authority boundaries

There is no single database that owns every kind of state:

- **Workers API:** public trust boundary. Authenticates the caller, resolves entitlements, authorizes requests, issues upload/download grants, and routes WebSockets.
- **D1:** authority for users, workspace metadata and lifecycle, memberships, invitations, subscriptions, entitlements, storage accounting, and audit records.
- **Workspace Durable Object:** authority for the hosted scene, grouped entity revisions, accepted command ordering, connection membership, presence routing, and playback anchors.
- **Durable Object storage:** primary strongly consistent scene storage. It contains normalized entities, idempotent operation records, room sequence, and current playback anchors. Critical state is written here before acknowledgement or broadcast.
- **R2:** durable immutable media objects, workspace snapshots, previews, and generated exports.
- **Client:** optimistic projection and local rendering only. It is never authoritative for access, quotas, revisions, or durable state.

D1 must not store the large workspace document or high-frequency presence/playback events. The Durable Object must not become the authority for billing or durable membership.

### 5.2 Monorepo target

```text
apps/
  web/                  React/Vite application
  api/                  Worker routes and workspace Durable Object
packages/
  domain/               IDs, roles, entitlements, operations, and policies
  api-contract/         Validated HTTP and WebSocket schemas plus typed client
  workspace-format/     Hosted document schema, migrations, import, and export
  collaboration/        Typed scene commands, presence, playback, and reconciliation protocol
  database/             D1 schema, queries, and migrations
  object-store/         Narrow S3-compatible asset and snapshot interface
```

The migration to a monorepo should preserve the current subsystem boundaries inside `apps/web`. Shared packages expose contracts and pure domain code; the web app must not import API, D1, or Durable Object implementations.

## 6. Hosted workspace representation

The current `.vdmsh` ZIP contains a manifest and media. Hosted storage decomposes those parts:

```text
assets/{asset-id}/{asset-revision-or-content-hash}
workspaces/{workspace-id}/snapshots/{room-sequence}.json
workspaces/{workspace-id}/previews/{room-sequence}.webp
workspaces/{workspace-id}/exports/{export-id}.vdmsh
```

The exact prefix is an implementation detail behind the object-store interface. Database rows store opaque object keys; application code must not derive authorization from a key name.

### 6.1 Workspace document

The hosted scene contains portable authored canvas state:

- Schema version and latest room sequence.
- Entity identity, geometry, layer order, locked state, and appearance.
- Shader parameters and palettes.
- Asset references and media metadata.

It excludes:

- User sessions and permissions.
- Cursor and selection presence.
- Upload reservations.
- Object-store URLs or credentials.
- Browser-only media elements, GPU resources, caches, or renderer state.
- Derived playback time, shader time, cursor state, or per-user audio preferences.

Every accepted command batch increments a monotonically increasing room sequence. Entities have independent revisions for identity, geometry, appearance, layering, and asset binding so independent edits can merge without replacing an entire entity. Commands carry stable operation IDs for retry deduplication and expected grouped revisions for conflict detection. Snapshots include the room sequence; reconnecting clients request either a bounded operation delta or a current snapshot.

The live `CanvasStore` remains the only resource-owning client scene. Hosted snapshots and patches contain plain metadata only. Applying a remote patch invalidates only the affected canvas subsystem; a geometry or playback update must not replace media resources or dirty processed textures.

### 6.2 Media assets

An asset is independent of the entities that reference it. Multiple entities may reference one asset without duplicating bytes. Each asset records:

- Stable asset ID.
- Owning workspace or account.
- Object key.
- Media type and original filename.
- Verified byte length.
- SHA-256 content hash.
- Revision if its bytes can be replaced.
- Width, height, duration, frame rate, and audio metadata when available.
- ThumbHash or another bounded preview representation.
- Lifecycle state: reserved, uploaded, verified, active, unreferenced, or deleting.

The prototype's content-addressing, preview-first placeholders, shared decoded image assets, bounded transfer work, and integrity checks remain relevant. R2 replaces peer asset transfer: collaborators fetch the same verified object instead of requesting it from another browser.

### 6.3 Import and export

- Import validates and migrates a `.vdmsh` archive locally before any hosted mutation.
- Assets are uploaded independently and verified before the workspace document references them.
- The client derives a bounded first-frame WebP thumbnail while the media is already decoded. The
  thumbnail is reserved, verified, authorized, and deleted with its original; library grids never
  fetch originals for previews.
- The final scene replacement is one typed command batch and one undo boundary.
- Export reads a consistent SQLite scene snapshot at a known room sequence and assembles a `.vdmsh` archive asynchronously.
- Export must remain available while an account is over quota or pending deletion during its recovery window.

## 7. Identity, access, and sharing

### 7.1 Authentication

Better Auth runs in the Worker with a D1-compatible SQLite adapter. The initial release supports email and password. The schema and UI must leave room for social providers and multiple verified identities later.

Required flows:

- Signup with email verification.
- Login and logout from one or all sessions.
- Password reset.
- Session rotation and revocation.
- Rate limiting and Turnstile on abuse-prone public endpoints.
- Account deletion with explicit handling of owned shared workspaces.

### 7.2 Roles

| Action                     | Owner |                      Editor | Viewer |
| -------------------------- | ----: | --------------------------: | -----: |
| Open workspace and assets  |   Yes |                         Yes |    Yes |
| Publish presence           |   Yes |                         Yes |    Yes |
| Edit document and playback |   Yes |                         Yes |     No |
| Upload or remove assets    |   Yes |                         Yes |     No |
| Download original media    |   Yes |                         Yes |    Yes |
| Export workspace           |   Yes | Configurable, initially yes |     No |
| Invite or remove members   |   Yes |                          No |     No |
| Change role                |   Yes |                          No |     No |
| Delete workspace           |   Yes |                          No |     No |

The owner is represented as a membership with the owner role, but D1 constraints must guarantee exactly one owner for an active workspace. Ownership cannot be transferred. The account that originally created the workspace owns its stored assets, is billed for them, and controls the workspace lifecycle. An asset's uploader is retained as attribution only; uploader departure or account deletion does not remove the asset from the workspace.

### 7.3 Invitation links

Every workspace participant must have an account. View and edit invitation links require signup or login before redemption. Successful redemption creates a durable viewer or editor membership for that user.

Invitation links are permanent until the owner revokes or rotates them; they do not expire automatically. Revoking a link prevents new redemptions but does not silently remove memberships already created through it. The owner removes those members explicitly when desired.

Every link has a cryptographically random token. D1 stores only a keyed hash or cryptographic hash of the token. It also stores permission, creator, revocation time, and optional maximum uses.

Opening an invitation records an access attempt. Successful redemption records the authenticated user, membership change, and audit event. Edit invitations can only be created and redeemed when the billing account has the edit-collaboration entitlement.

### 7.4 Revocation

Membership revocation must affect live sessions. A membership removal, role downgrade, or workspace deletion notifies the workspace Durable Object. It reauthorizes affected connections, disconnects those without view access, and immediately rejects scene and playback commands from viewers. Invitation-link revocation only prevents future redemptions; it does not affect memberships already created through that link.

## 8. WebSocket session lifecycle

1. The client loads workspace metadata through the API.
2. The API verifies the account session and active workspace membership, then resolves the effective role.
3. The API routes the WebSocket upgrade to the workspace's Durable Object with a short-lived, signed authorization assertion. Raw sessions and invitation tokens are not forwarded or stored in the room.
4. The Durable Object validates the assertion, registers a unique connection ID, and associates it with user ID, role, session version, and protocol version.
5. The room sends `welcome`, containing the connection identity, room protocol version, current sequence, server time sample, collaborator list, current lightweight scene snapshot, and playback anchors.
6. The client installs metadata immediately, reconciles its pending typed commands, begins visible-first asset hydration, and announces presence readiness without waiting for every original asset.
7. The room sends existing presence snapshots to the new client and broadcasts the new participant to existing clients.
8. On close, timeout, replacement, or revocation, the room removes the connection and broadcasts `presence.leave`.

The Hibernation WebSocket API should be used. Connection attachments retain only the small identity and authorization data needed to reconstruct the connection after hibernation. Durable state is stored before acknowledging a durable update.

One user may open multiple tabs. Presence is per connection, not per account. The UI may group those connections by user visually, but the protocol must not collapse them because each tab can have a different cursor and selection.

## 9. Presence specification

Presence consists only of collaborator identity, canvas cursor, and selected entity IDs.

### 9.1 Presence state

```ts
interface WorkspacePresence {
  connectionId: string;
  userId: string;
  displayName: string;
  color: [number, number, number, number];
  cursor: { x: number; y: number } | null;
  selectedEntityIds: readonly string[];
  sequence: number;
}
```

- Cursor coordinates are world-space canvas coordinates so every viewport can render them correctly.
- `cursor: null` means the pointer is outside the canvas, the tab is hidden, or the client has intentionally cleared it.
- Selection is a snapshot, not a delta. IDs not present in the current document are ignored.
- Display name comes from the account profile. Email addresses are not exposed as presence names.
- Color is assigned deterministically by the room with collision avoidance among current participants when practical.

### 9.2 Publication rules

- Cursor changes are coalesced and sent at most once per animation frame, matching the prototype's approximately 60 Hz cap.
- Selection is sent only when its immutable selection reference or contents change.
- Pending cursor and selection changes may be combined into one message.
- Each client message includes a monotonically increasing per-connection sequence. The room and receivers ignore duplicates and older messages.
- A joining connection sends one full presence snapshot after document reconciliation.
- A hidden or suspended client clears its cursor promptly. Disconnect cleanup clears all of its presence.
- Presence messages are bounded and schema-validated. Selection length, ID length, coordinate range, and total encoded payload have protocol limits chosen from realistic stress tests.
- The room may drop intermediate presence messages under backpressure; it must preserve the newest state. Presence is never allowed to delay durable scene commands.

### 9.3 Routing and rendering

- Presence is accepted from owners, editors, and viewers.
- The room broadcasts it to all current viewers except the sender.
- It is held only in room memory and WebSocket attachments as required for hibernation recovery; it is not written to D1, R2 snapshots, operation history, or undo.
- Remote selections render as color-coded entity and multi-entity outlines.
- Remote cursors render with the collaborator color and display-name label.
- The dedicated WebGPU presence pass from the prototype is the rendering reference. Presence updates invalidate only the presence layer; they must not dirty entity textures or shader outputs.
- Lens distortion and other composition passes retain the prototype's intended ordering so presence appears anchored in the same canvas scene as entities.

### 9.4 Presence acceptance criteria

- Two clients see each other's cursors while moving across different viewports and zoom levels.
- Selection outlines update on select, multi-select, deselect, entity deletion, workspace replacement, tab hiding, and disconnect.
- Reordered or duplicated packets never restore stale cursor or selection state.
- A slow presence consumer does not increase durable edit latency or memory without bound.
- Presence produces no durable commands, room sequences, snapshots, audit rows, or storage usage.

## 10. Durable scene synchronization

### 10.1 Typed command model

Each workspace Durable Object owns a normalized hosted scene in SQLite. Connected editors submit validated typed commands to that room. The room is the single serialization authority, so the protocol does not use a second CRDT document or copy the complete scene to validate one field change.

Entity commands address independently revisioned groups:

- `identity`: name, locked state, edited state, and original palette.
- `geometry`: position, size, original size, and rotation.
- `appearance`: shader type and shader parameters.
- `layering`: z-index.
- `asset`: verified asset reference and immutable media metadata.

Entity creation and deletion use a generation number so a stale offline patch cannot resurrect deleted state. Multi-entity actions execute in one SQLite transaction and one local undo boundary. Continuous geometry previews are presence-like and may be coalesced; the exact final geometry command is durable and never intentionally dropped.

Every command includes a stable operation ID, bounded typed payload, and expected revisions for the groups it changes. The room validates the current editor role, protocol version, command schema, entity and scene bounds, generation and grouped revisions, and referenced asset IDs. Unknown assets never become readable merely because a command names them. A rejected command does not advance the room sequence or change asset lifecycles. An accepted command is persisted, assigned one room sequence, broadcast as a narrow patch, and acknowledged only after the SQLite transaction commits.

The client may apply its own command optimistically. The accepted patch remains authoritative and corrects optimistic state without reconstructing unrelated entity fields. Remote projection must preserve existing `Blob`, `ImageBitmap`, media element, decoded-frame, and GPU ownership unless the asset group itself changed.

### 10.2 Offline synchronization and collaborative undo

- A client persists its last acknowledged room sequence and pending typed commands with stable operation IDs in IndexedDB.
- Previously opened hosted workspaces remain editable offline indefinitely.
- Larger locally required asset bytes use OPFS where supported, with a bounded fallback strategy elsewhere.
- Reconnection requests operations after the last acknowledged sequence when that bounded delta remains available; otherwise it receives one current scene snapshot.
- The client applies remote state first, then rebases and submits pending commands in original local order.
- Pending asset uploads finish before a command publishes references to those assets.
- Independent revision groups merge naturally. A stale command that changes a concurrently modified group receives a conflict containing the current group revision and authoritative fields.
- A schema or asset failure preserves the unsynchronized local state as a recoverable local copy rather than discarding it.

Collaborative undo remains client-owned. A local undo command records the accepted preimage for the affected revision groups and submits the inverse as an ordinary typed command. It never rewinds another user's unrelated fields. Bulk operations remain one undo item and one atomic command batch.

Deleting an entity or removing the final asset reference does not synchronously delete media bytes. The asset becomes unreferenced and remains recoverable during a garbage-collection grace period. If an indefinitely offline client later references media that has already been collected, it must re-upload its cached copy; otherwise the entity resolves to a missing-media placeholder.

### 10.3 Persistence and recovery

- The room persists normalized entity rows, grouped revisions, accepted operation IDs, operation records, room sequence, and playback anchors in Durable Object SQLite storage before acknowledgement.
- Current scene rows are authoritative. The operation log is bounded reconnect history and diagnostics, not the only recovery source.
- An immutable R2 recovery snapshot is written at bounded sequence/time intervals and on important lifecycle transitions.
- The room records the R2 snapshot sequence only after upload succeeds.
- On construction after eviction or failure, the room reads current SQLite rows directly; no document replay or in-memory repair is required.
- Internal snapshots are not a user-visible version-history or restore feature and carry no customer-facing backup guarantee.
- Passive animation progress, cursor presence, and selection presence do not create scene operations or snapshots.

## 11. Playback and animated shader synchronization

The prototype establishes the desired behavior. Video and GIF state includes:

```ts
interface SharedPlaybackAnchor {
  entityId: string;
  commandId: string;
  sequence: number;
  positionSeconds: number;
  state: "paused" | "playing";
  playbackRate: number;
  loop: boolean;
  duration: number;
  mediaRevision: number;
  effectiveAtRoomMs: number;
}
```

Animated shader state is a separate anchor with `shaderTime` and `state`. An entity supports shader playback only when its current effect genuinely consumes continuous time. Initially this means flowing glass only. Static shaders must never receive shader anchors merely because common defaults contain `timeAutoPlay`.

Mute, volume, and autoplay permission are local per-client preferences. They are not synchronized without an explicit future presenter-mode product feature.

### 11.1 Authority and clocks

- The workspace room accepts and orders every playback command.
- On acceptance it stamps the anchor with its server time and room sequence.
- Clients estimate their offset from the room clock through periodic WebSocket ping/response samples and prefer the lowest-round-trip recent sample.
- Clients no longer estimate clocks independently for every peer.
- A playing client derives passive progress from the anchor, elapsed room time, and playback rate. It does not publish `timeupdate` progress.
- Clients use a monotonic local clock plus the estimated room offset. Wall-clock changes must not make playback jump.
- The room can hibernate while playback is logically advancing because the anchor is sufficient to derive current time after wakeup.

For a non-looping asset, derived time clamps to duration and becomes logically paused at the end. For a looping asset, time wraps by duration. Loop-aware distance uses the shorter distance across the duration boundary.

### 11.2 Commands

The following user actions publish immediate commands:

- Play and pause.
- Seek and scrub.
- Loop change.
- Playback-rate change.
- Animated shader play/pause and explicit time change.

Scrubbing uses three phases:

1. `scrub.begin` establishes active control and the initial target.
2. Coalesced `scrub.update` commands provide responsive remote preview at no more than one per animation frame.
3. `scrub.end` sends the exact final target and is never intentionally dropped.

The initial policy is last accepted playback command wins per entity. There is no permanent playback owner or presenter lock. The UI may show who most recently controlled playback if contention becomes confusing.

### 11.3 Client application heuristics

- Apply loop and rate before deciding whether to play or seek. Apply local mute and volume independently.
- Seek video or GIF media when loop-aware drift is at least 150 ms, preserving the prototype's starting threshold.
- One playback controller re-evaluates only active video and GIF anchors every second as a drift guard. Small drift may use temporary playback-rate nudging; large drift uses a hard seek.
- GIF frame selection derives directly from room time. Flowing-glass time is passed directly to its shader uniform. Neither path updates, replaces, or dirties a canvas entity merely because time advanced.
- Do not publish drift corrections back to the room.
- On a better room-clock sample or foreground resume, re-evaluate active anchors immediately without projecting scene state.
- A late joiner derives the current position from the latest anchor instead of starting from its stored `currentTime`.
- A paused anchor is exact and does not advance.
- Remote projection suppresses local command echoes.

These are initial tested heuristics, not permanent product limits. Changes require cross-browser measurements with video, GIF, loop boundaries, non-1x playback, rapid scrubbing, and animated shaders.

### 11.4 Browser autoplay policy

Remote unmuted playback can be rejected by the browser. That rejection must not fail the room or rewrite the authoritative shared state.

- Remember the blocked entity locally to avoid repeated play attempts and repeated notifications.
- Show one actionable notification that playback requires a user gesture.
- Retry after an appropriate local gesture or when a later command makes the media muted.
- Clear the blocked state on pause, entity removal, asset replacement, or successful play.

### 11.5 Playback acceptance criteria

- Play, pause, seek, rapid scrub, loop, and rate converge across clients while mute and volume remain local.
- Video and GIF drift remains within the selected correction budget during a sustained session.
- Loop-boundary correction does not seek across the long path.
- A late joiner sees the correct derived position.
- Animated shader time converges without per-frame network messages.
- Static shader entities create no shader-playback anchors, drift work, entity replacement, texture invalidation, or render requests.
- Conflicting controls resolve by room sequence without echo loops.
- Unmuted autoplay rejection is visible and recoverable without changing other clients.
- Room hibernation and reconstruction preserve logical playback.

## 12. Asset upload, download, and quotas

### 12.1 Upload lifecycle

1. Editor requests an upload reservation with expected byte length, media type, filename, and optional hash.
2. The API checks the hard per-asset limit, then atomically verifies that neither workspace nor account is already above its soft quota.
3. D1 records a short-lived reservation and increments reserved bytes. This one reserved asset may complete even if its verified size takes the workspace or account over a soft quota.
4. The API returns a short-lived presigned `PUT` or multipart upload grant restricted to the intended object.
5. The browser uploads directly through the S3-compatible object-store API.
6. The browser finalizes the reservation.
7. The API verifies object existence, actual size, media type policy, and checksum when available.
8. One transaction converts reserved bytes to used bytes and marks the asset verified.
9. Only a verified asset can be referenced by an accepted scene command.

Once a workspace or account is over quota, no further byte-increasing reservation can begin until usage is reduced or the plan is upgraded. Concurrent reservations are serialized against reserved bytes so only the permitted crossing upload can exceed a soft limit. Expired reservations release bytes. Lifecycle rules and a cleanup job remove incomplete multipart uploads and orphan objects.

Client hydration is metadata-first and progressive:

- Installing a scene snapshot never waits for every original asset.
- Visible and near-visible entities load before offscreen entities; bounded previews may load before originals.
- Download concurrency is not treated as a memory budget. The client independently limits retained blob bytes, decoded image bytes, video resources, and GPU texture bytes.
- Each completed asset may be committed immediately. A batch must not retain every decoded result while waiting for its slowest member.
- Loads are cancellable on workspace exit, entity deletion, asset revision change, or loss of relevance.
- Eviction preserves lightweight entity metadata and displays a recoverable placeholder until the asset is needed again.

### 12.2 Downloads

- Private assets are never exposed through a public bucket.
- Every media request requires an authenticated account session and active workspace membership.
- An authenticated Worker media gateway authorizes and streams original objects through an R2 binding. Original downloads do not use public or reusable presigned `GET` URLs.
- The gateway supports validated range requests for video, immediate membership revocation, and per-request access logging.
- Browser CORS and content headers are explicit, but they are defense in depth rather than authorization.
- SVG and other active content are served from an isolated media origin with download-safe headers; they do not execute under the application origin.
- Anyone who can render original bytes can technically save them. The product distinguishes an explicit download action from a render request in its UI and audit trail, but does not claim copy prevention.

### 12.3 Accounting

Track separately:

- Verified logical bytes charged to the account and workspace.
- Reserved bytes for incomplete uploads.
- Physical object bytes for operations and reconciliation.
- Unreferenced bytes pending garbage collection.

Asset references are counted once per owning workspace even when many entities use the asset. The workspace owns every asset and its original creator's account is billed; `uploaded_by` is attribution. Cross-account physical deduplication, if ever implemented, must not change logical billing or leak whether another customer owns identical content.

### 12.4 Asset access trail

The application records `asset.upload_reserved`, `asset.upload_completed`, `asset.read_authorized`, `asset.bytes_served`, `asset.read_denied`, `asset.download_requested`, `asset.deleted`, and `asset.restored` events. Records include request ID, timestamp, authenticated user, workspace, asset, membership role, access purpose, requested range, bytes served, status, and bounded security metadata. They never include session tokens, invitation tokens, object keys, presigned URLs, filenames, or media contents.

An explicit download event means the user invoked the product's download action. A bytes-served event means Voidmesh delivered bytes for rendering or download; the application cannot prove that rendered bytes were not saved.

Exact security events flow through a Queue into a durable append-only sink. Sampled operational analytics may additionally use Analytics Engine, but sampled data is not the authoritative access trail. R2 create/delete notifications reconcile storage mutations because Cloudflare's R2 audit log does not include object-level data access.

## 13. Core data model

The initial D1 model contains at least:

- `users`, `sessions`, `accounts`, and `verifications` for authentication.
- `workspaces`: owner, title, lifecycle, current room sequence, snapshot sequence, usage, timestamps.
- `workspace_members`: workspace, user, role, inviter, accepted and removed timestamps.
- `invitation_links`: token hash, permission, creator, revocation, use policy.
- `invitation_redemptions`: link, authenticated user, outcome, timestamp.
- `assets`: workspace, uploader attribution, object key, hash, byte length, media metadata, lifecycle.
- `asset_references`: asset and entity/reference identity when reference accounting needs normalization.
- `upload_reservations`: expected bytes, object key, expiry, state, idempotency key.
- `workspace_snapshots`: room sequence, object key, checksum, created timestamp.
- `subscriptions`: provider IDs, status, current period, cancellation state.
- `account_entitlements`: resolved limits and feature flags with source/version.
- `audit_events`: actor, action, target, outcome, timestamp, bounded metadata.
- `idempotency_keys`: caller, operation, response identity, expiry.

Foreign keys and unique constraints enforce ownership, membership uniqueness, asset identity, and idempotency. Security-sensitive deletion uses explicit transactions rather than relying on broad cascades.

## 14. Initial API surface

Representative routes, not a frozen URL design:

```text
/v1/auth/*
/v1/me
/v1/workspaces
/v1/workspaces/:workspaceId
/v1/workspaces/:workspaceId/restore
/v1/workspaces/:workspaceId/export
/v1/workspaces/:workspaceId/members
/v1/workspaces/:workspaceId/invitations
/v1/workspaces/:workspaceId/assets/uploads
/v1/workspaces/:workspaceId/assets/uploads/:uploadId/finalize
/v1/workspaces/:workspaceId/assets
/v1/workspaces/:workspaceId/assets/:assetId/content
/v1/workspaces/:workspaceId/assets/:assetId/download
/v1/workspaces/:workspaceId/assets/:assetId/thumbnail
/v1/workspaces/:workspaceId/socket
/v1/billing/checkout
/v1/billing/portal
/v1/billing/webhooks/:provider
```

`GET` reads the private thumbnail. An authorized editor may `PUT` a bounded, client-derived
thumbnail when an older or recovered asset has no thumbnail yet; the operation is create-once and
updates authoritative storage accounting with the stored bytes.

All mutating HTTP requests use idempotency keys where client retry could otherwise duplicate state. Billing webhooks are authenticated, idempotent, order-tolerant, and retain the provider event ID.

## 15. Workspace lifecycle and retention

- Creation reserves one workspace entitlement and creates the initial empty snapshot.
- Delete is soft deletion: immediately revoke new access and disconnect live sessions, then retain data for 30 days.
- The original owner may restore the workspace during those 30 days, subject to the same account identity and entitlement checks.
- Restore rechecks workspace-count and storage entitlements.
- Permanent deletion removes metadata and schedules object deletion; it is auditable and cannot be undone after completion.
- Removing an asset reference does not synchronously delete bytes. Garbage collection verifies that no live document or retained snapshot references it.
- Internal recovery-snapshot retention and soft-delete retention are separate implementation policies; neither is a customer-facing backup guarantee.
- Account deletion soft-deletes every workspace created by that account. Ownership cannot transfer, and permanent deletion begins after the 30-day recovery window.

## 16. Security and abuse controls

- Deny by default at both HTTP and WebSocket command boundaries.
- Require signup and an authenticated session for every workspace role, including viewer.
- Reauthorize role changes and revocations in live rooms.
- Validate every untrusted schema, ID, coordinate, number, collection length, and encoded payload size.
- Use CSP, strict media content headers, an isolated media origin, and safe SVG handling.
- Rate-limit signup, login, password reset, invitation redemption, WebSocket connection, upload allocation, and export creation.
- Apply Turnstile where behavioral rate limits indicate abuse risk.
- Store secrets in Worker secret bindings, never in the web bundle or D1.
- Use separate production, staging, and local databases, buckets, secrets, and auth origins.
- Audit ownership, membership, invitation, asset access, billing, export, deletion, and authorization-denial events without logging tokens or sensitive document contents.
- Define support tooling for revoking sessions, disabling a workspace, reconciling quota usage, and replaying webhook events.

## 17. Observability and service behavior

Measure:

- API latency, status, authorization denials, and D1 query failures.
- WebSocket connection count, join latency, disconnect reason, hibernation wake, and protocol version.
- Scene-command acceptance latency, conflict/rejection reason, sequence gaps, snapshot time, reconnect mode, and recovery time.
- Presence message rate, bytes, validation drops, coalescing, and backpressure drops.
- Playback command latency, clock-sample RTT, derived drift, hard corrections, and autoplay blocks.
- Scene projection counts by revision group, full-entity replacement count, texture invalidations caused by remote patches, and active playback-controller counts.
- Asset hydration queue depth, retained blob/decoded/GPU bytes, cancellation, eviction, placeholder duration, and mobile memory-pressure recovery.
- Upload allocation, upload completion, verification time, authenticated asset reads, bytes served, expired reservations, orphan cleanup, and quota denials.
- R2 and D1 operation counts and errors by bounded category.

Logs and metrics must not contain share tokens, presigned URLs, passwords, full workspace documents, or user media. High-cardinality IDs belong in sampled diagnostic events, not unbounded metric dimensions.

## 18. Delivery sequence

### Phase 1: repository and contracts

- Establish the monorepo without changing product behavior.
- Extract workspace format, domain roles/entitlements, and validated API contracts.
- Define protocol versioning and compatibility behavior.

### Phase 2: hosted persistence

- Add Worker API, D1 migrations, Better Auth, private R2 bucket, and object-store adapter.
- Implement owner-only workspace create/open/autosave/export/delete.
- Split hosted documents from assets and implement quota-reserved uploads.

### Phase 3: sharing

- Add authenticated viewer/editor memberships, permanent-until-revoked invitation links, audit records, and live revocation.
- Keep edit invitations behind a paid entitlement and gated until typed scene synchronization is ready.

### Phase 4: real-time room V2

- Add the workspace Durable Object, authoritative normalized SQLite scene, typed commands, grouped revisions, IndexedDB pending-command persistence, recovery snapshots, and WebSocket reconnect.
- Add narrow remote patch application and verify that geometry, identity, presence, and playback never replace media resources or dirty unrelated textures.

### Phase 5: presence and playback

- Port the existing presence store and WebGPU pass.
- Implement room-routed cursor and selection state with backpressure behavior.
- Implement room-clock synchronization, independent media and flowing-glass anchors, scrub commands, drift correction without entity projection, and autoplay recovery.
- Add metadata-first, visible-first, byte-budgeted asset hydration before mobile release testing.

### Phase 6: commercial launch

- Integrate billing provider checkout, portal, webhooks, and entitlements.
- Add over-quota behavior, retention jobs, operational tooling, dashboards, alerts, and abuse controls.
- Run mixed-media multi-client tests across supported browsers and mobile suspension/reconnect scenarios.

## 19. Decisions still required

- Exact Cloud Free and Pro workspace, storage, collaborator, and retention limits.
- Exact hard per-asset limits and plan-specific traffic limits.
- Exact retention for unreferenced asset bytes that remain undoable.
- Exact retention for the asset access audit trail.
- Tax collection, invoice presentation, regional pricing, and refund requirements for the Stripe subscription product.
- Supported browser/device matrix and acceptable playback drift budget.
- Operation-delta retention and R2 recovery-snapshot frequency.
- Initial decoded-media and GPU byte budgets for iOS-class devices and desktop devices.

## 20. Platform references

- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/)
- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Durable Object WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)
- [Better Auth Drizzle adapter](https://better-auth.com/docs/adapters/drizzle)
