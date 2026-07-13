# Collaboration prototype

The prototype uses a password-bearing invite fragment, Trystero's Nostr strategy for signaling, WebRTC data channels, and a Yjs document for replicated canvas state. There is no Voidmesh session server. Peer traffic stays direct when possible and can relay through Cloudflare TURN when NAT or network policy prevents a direct route.

## Implemented

- Entity identity, geometry, layer order, appearance, asset references, and playback state converge through Yjs.
- Media uses SHA-256 content addresses, inventory exchange, explicit requests, integrity verification, and a 512 MB per-asset safety limit. Receivers bound their request window and senders run at most four payload/verification workers per peer under a 32 MB combined encoded-byte budget; an asset larger than the budget runs alone. This bounded concurrency avoids both stop-and-wait latency and unbounded iOS allocation/reassembly. A progress watchdog plus peer-departure cleanup releases and retries work stranded by mobile page suspension or an incomplete send.
- Images, SVGs, GIFs, and videos transfer as their encoded Blobs. Gzip is attempted only for SVG/JSON payloads and retained only when smaller; encoded image/video formats use identity transfer.
- Entities publish a bounded ThumbHash first-frame preview before content hashing begins. Peers create a full-geometry placeholder immediately and hydrate its media in place after verified Blob transfer.
- Workspace v7 manifests cache ThumbHashes, so an atomically restored heavy workspace can publish all previews without re-reading decoded pixels.
- Duplicate entities sharing one Blob reuse a single preview, hash operation, inventory entry, transferred payload, and decoded static-image asset. Final asset descriptors publish in one Yjs transaction so duplicate-heavy workspace replacement does not reconcile once per entity.
- Video/GIF play, pause, seek, loop, rate, mute, and volume publish immediate per-entity shared-clock commands. Peers estimate monotonic clock offsets with NTP-style samples, correct drift without republishing passive progress, wrap duration-aware loops for late joiners, and surface browser-blocked unmuted autoplay without failing the room.
- Ephemeral presence assigns each peer a stable shader-themed name and color, then sends canvas cursors at up to 60 Hz and selections only when changed. A dedicated WebGPU pass renders cached color-coded entity/group outlines plus cursor name labels into the canvas scene before lens distortion and WLUR, without dirtying entity textures or shader outputs.
- A same-origin Vercel function exchanges server-only Cloudflare credentials for one-hour browser ICE credentials. The client validates that the response contains an authenticated TURN route before joining, passes it to Trystero through standard `RTCConfiguration`, refreshes credentials before expiry, and applies the new configuration to existing peers. The client-side provider contract is not Cloudflare-specific.
- Geometry updates coalesce to roughly 60 Hz. Remote projections are serialized and suppress mutation echoes.
- Diagnostics measure connection setup, peer count, direct/relayed route and relay protocol, TURN fetch/expiry/refresh state, messages/bytes, Yjs updates/apply/reconcile time, preview encode/decode/dwell, hashing, compression, media decoding, RTT, asset request/receive progress and retries, transfers, throughput, and compression ratios. Completed receive throughput starts at the first incoming chunk and ends after verification instead of measuring only post-transfer restoration.

## TURN configuration

- Set `CF_TURN_ID` and `CF_TURN_API_TOKEN` in every Vercel environment that supports collaboration. Both values are server-only.
- The Vite development server mounts the same credential handler at `/api/ice-servers`, so `bun run dev` supports local multiplayer with the two variables in `.env`/`.env.local`.
- The credential endpoint accepts same-origin `POST` requests, disables caching, filters Cloudflare's port 53 URLs for browser compatibility, and never returns the Cloudflare API token.

## TODO

- Add controlled ICE restarts after credential rotation or network migration so long-running rooms actively gather with the newest credentials.
- Replace Trystero's whole-payload allocation/reassembly with application-owned streaming chunks, resumable offsets, incremental hashing, and multi-peer source selection for large videos. The current count/byte-bounded acknowledged workers limit whole assets in flight but cannot resume within one Blob.
- Mark provisional entities explicitly in the UI and disable media-specific operations that cannot be valid until the source Blob is hydrated.
- Extend ephemeral presence with drag previews and soft edit locks.
- Merge shader parameters at leaf paths instead of treating the appearance group as one last-writer-wins value.
- Replace `undo.clear()` on remote projection with origin-aware collaborative undo using `Y.UndoManager`.
- Add room membership controls, identity, invite revocation, credential-endpoint rate limiting, and abuse limits. The current URL secret grants full room access.
- Add persistent/offline room bootstrap if sessions should survive every original peer leaving.
- Add real-network browser coverage for reconnects, concurrent edits, multi-hundred-megabyte video, playback drift, and restrictive NATs.
- Distinguish intentional `GPUDevice.destroy()` cleanup from unexpected device loss in renderer logging and recovery UI.
