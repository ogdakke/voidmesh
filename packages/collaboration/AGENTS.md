# Collaboration Protocol

Platform-neutral wire contracts for hosted Yjs synchronization and ephemeral presence.

- Yjs updates are opaque binary payloads here; the protocol must not depend on canvas or React implementations.
- Every client update carries a stable update ID so indefinitely offline clients can retry safely.
- A room acknowledges only updates whose Yjs dependencies fully integrate. Missing history is recovered through an explicit, validated document rebase that every connected client applies as a replacement generation.
- Cursor and selection presence is ephemeral and must never be included in persisted document frames.
- Playback and animated shader anchors are durable Yjs document data, not presence messages.
- Protocol changes require round-trip validation tests and an explicit version increment.
