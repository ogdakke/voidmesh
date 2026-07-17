# Voidmesh

[voidmesh](https://voidmesh.xyz) is an infinite-canvas image/video filter tool built using WebGPU and React. The local product remains usable without an account; optional hosted workspaces add authenticated storage and collaboration on Cloudflare.

This is a Bun monorepo:

- `apps/web` — the React/Vite/WebGPU client
- `apps/api` — the Cloudflare Workers API and workspace Durable Object
- `packages/domain` — shared hosted-product policies and types
- `packages/api-contract` — transport contracts shared by the client and API
- `packages/wlur` — the local rendering package

## Development

```sh
# install deps
bun i

# run the web app and Workers API
bun dev

# or run one side
bun run dev:web
bun run dev:api
```

## Production build

```sh
bun run build
```

The hosted product specification lives in [`docs/hosted-workspaces-specification.md`](docs/hosted-workspaces-specification.md).
