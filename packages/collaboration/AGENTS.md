# Collaboration Protocol

Platform-neutral wire contracts and client transport for hosted scene synchronization and
ephemeral presence.

- Scene mutations are typed, idempotent commands with stable operation IDs. Field-group revisions
  provide explicit conflict detection without coupling the protocol to canvas or React code.
- Clients hydrate from an authoritative scene snapshot and then apply ordered, narrow patches.
  Pending commands are persisted locally and sent one at a time until acknowledged.
- Cursor and selection presence is ephemeral and never enters scene snapshots or command storage.
- Media and time-dependent shader playback use separate durable anchors tied to entity revisions.
  Local audio preferences are not collaborative state.
- Protocol changes require round-trip validation tests and an explicit version increment.
