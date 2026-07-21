# Hosted Domain

Platform-neutral policies and types shared by the web app and Workers API.

- Keep this package free of React, Cloudflare runtime, database, and transport dependencies.
- Product entitlements and authorization policy live here when they can be expressed without I/O.
- Use `createEnum()` for runtime string unions; never use TypeScript `enum`.
- Do not encode provider-specific billing product IDs as domain policy.
