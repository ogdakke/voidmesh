# API Contract

Versioned transport types shared by the web client and hosted API.

- Depend only on `@voidmesh/domain` and platform-neutral libraries.
- Keep HTTP and WebSocket wire representations JSON-safe unless a route explicitly declares binary data.
- Contract changes require focused tests and coordinated producer/consumer updates.
- Do not place authorization or persistence implementation in this package.
