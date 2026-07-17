# Voidmesh Monorepo

Voidmesh combines a permanently free local canvas with optional authenticated hosted workspaces.

## Architecture

- `apps/web/` — React/Vite/WebGPU client; see its `AGENTS.md`.
- `apps/api/` — Cloudflare Workers API and Durable Objects; see its `AGENTS.md`.
- `packages/domain/` — platform-neutral product policy and identifiers.
- `packages/api-contract/` — versioned HTTP/WebSocket transport contracts.
- `packages/wlur/` — local rendering package consumed by the web app.
- `docs/hosted-workspaces-specification.md` — authoritative hosted-product behavior.

Read the nearest subsystem `AGENTS.md` before editing that area.

## Stack and Imports

React 19 with Compiler, Vite 8, WebGPU, Cloudflare Workers/D1/R2/Durable Objects, strict TypeScript, Bun, oxlint.

Workspace packages depend on public package exports; never import another package's internals by filesystem path. Package-local rules govern imports within each workspace.

## Required Conventions

- Use `createEnum()` from `@voidmesh/domain/enum`; never use TypeScript `enum`.
- Use native `#` private fields, not the `private` keyword.
- Never use `typeof import("...").Type`; write a normal type import or local type alias.
- Do not import package internals. Use the public API and `opensrc path <package>` when source inspection is needed.
- Do not add fallback behavior unless it is necessary and the reason is documented.
- D1 is authoritative for accounts, access, entitlements, metadata, quotas, and lifecycle. R2 stores opaque bytes. One workspace Durable Object serializes live Yjs updates and ephemeral presence.
- Every hosted workspace route and asset transfer requires authenticated membership authorization. Never authorize from an object key, client claim, or invitation token alone.

## Validation

During iteration, run the narrowest affected tests. At final handoff, run once:

```bash
bun run lint:all
bun run test
```

Never use `bun test`; use the project Vitest scripts.

For performance work:

- Define the exact interaction, workload, browser/device, and primary metric.
- Inspect raw traces with bounded, targeted queries; aggregate summaries are orientation, not diagnosis.
- Capture a baseline before editing and test one falsifiable hypothesis at a time.
- Run the smallest matching benchmark during iteration.
- Before handoff, guard the reported stress case with a realistic mixed-media scenario and compare semantic counters as well as timings.

Use `bun run bench:render:ab -- --base main --scenario <id> --metric <metric>` for same-machine base-ref/current-tree comparisons.

## AGENTS.md Policy

AGENTS files are routing and durable invariants, not architecture diaries.

- Update them only when a public boundary, ownership rule, authoritative entry point, or project-wide invariant changes.
- Do not record bug history, benchmark results, tuning thresholds, temporary workarounds, current file sizes, or detailed implementation mechanics.
- Replace stale guidance instead of appending another bullet.
- Keep subsystem files under roughly 600 words. If an addition would exceed that, consolidate or move detailed explanation to dedicated documentation.

## Source References

Dependency source is cached under `~/.opensrc/`:

```bash
rg "pattern" $(opensrc path <package>)
```
