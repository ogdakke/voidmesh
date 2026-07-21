# Workspace Format

Portable hosted-document and `.vdmsh` archive contracts shared by the web app and API.

- Keep format code platform-neutral. It may depend on collaboration contracts, but not React,
  Cloudflare bindings, D1, R2, or browser-only media APIs.
- Validate hosted scene snapshots and playback anchors before converting them into archive records;
  stored snapshot bytes are untrusted input.
- Archive schema changes require migration-aware tests against the web app's importer.
- Media object retrieval and ZIP transport belong to adapters, not this package.
