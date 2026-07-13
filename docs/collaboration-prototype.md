# Collaboration prototype

The prototype uses a password-bearing invite fragment, Trystero's Nostr strategy for signaling, direct WebRTC data channels, and a Yjs document for replicated canvas state. There is no Voidmesh session server and no TURN relay.

## Implemented

- Entity identity, geometry, layer order, appearance, asset references, and playback state converge through Yjs.
- Media uses SHA-256 content addresses, inventory exchange, explicit requests, integrity verification, and a 512 MB per-asset safety limit.
- Images, SVGs, GIFs, and videos transfer as their encoded Blobs. Gzip is attempted only for SVG/JSON payloads and retained only when smaller; encoded image/video formats use identity transfer.
- Video/GIF play, pause, seek progress, loop, rate, mute, and volume replicate at a bounded 250 ms interval.
- Geometry updates coalesce to roughly 30 Hz. Remote projections are serialized and suppress mutation echoes.
- Diagnostics measure connection setup, peer count, messages/bytes, Yjs updates/apply/reconcile time, hashing, compression, decoding, RTT, transfers, throughput, and compression ratios.

## TODO

- Add optional TURN configuration and expose direct-versus-relayed connection diagnostics.
- Replace whole-payload buffering with chunked transfer, backpressure, resumable requests, incremental hashing, and multi-peer source selection for large videos.
- Synchronize playback against a shared monotonic clock to compensate for transport latency and drift; handle blocked unmuted autoplay explicitly.
- Add ephemeral presence: cursors, selections, user labels, drag previews, and soft edit locks.
- Merge shader parameters at leaf paths instead of treating the appearance group as one last-writer-wins value.
- Replace `undo.clear()` on remote projection with origin-aware collaborative undo using `Y.UndoManager`.
- Add room membership controls, identity, invite revocation, and abuse limits. The current URL secret grants full room access.
- Add persistent/offline room bootstrap if sessions should survive every original peer leaving.
- Add real-network browser coverage for reconnects, concurrent edits, multi-hundred-megabyte video, playback drift, and restrictive NATs.
- Distinguish intentional `GPUDevice.destroy()` cleanup from unexpected device loss in renderer logging and recovery UI.
