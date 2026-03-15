# Voidmesh

Infinite canvas app with real-time WebGPU shader effects. Users drop images/videos/GIFs onto a canvas, apply shader effects (dithering, halftone, ascii, glass, blobs, melt), and export results.

## Architecture

- `engine/` — Canvas state (`CanvasStore`) and input handling (`GameLoop`). GPU-agnostic, framework-independent.
- `renderer/` — WebGPU rendering pipeline, shader registry, effect composition, export (MP4/MOV/GIF/PNG/JPEG). `renderer/shaders/` has per-effect `ShaderPass` subclasses.
- `lib/` — Pure utilities. Math, config, media loading, serialization (`.vdmsh`), undo (command pattern), palette extraction, physics scroll. No React, no GPU.
- `types/` — Domain types (`ShaderCanvasEntity`, `ShaderParams`, `Viewport`, all enums). Bottom of dependency graph.
- `context/` — React context providers wiring engine + renderer + URL state. `canvas-context.tsx` is the main orchestrator.
- `hooks/` — React hooks bridging engine state to components. `use-param-value.ts` is the standard param accessor.
- `components/` — React UI. `*-knobs.tsx` panels, canvas viewport, mobile/desktop layouts. `components/ui/` has domain-free primitives.

## Stack

React 19 + Compiler, rolldown-vite 7, WebGPU, TypeScript (strict), Bun, oxlint + tsgo.

## Path Aliases (package.json `imports`)

`#engine` -> `engine/index.ts`, `#config` -> `lib/config/index.ts`, `#lib/*`, `#types/*`, `#renderer/*`, `#hooks/*`, `#components/*`, `#context/*`, `#ui/*` -> `components/ui/*`, `#media/*` -> `media/*`, `#weights/*` -> `weights/*`.

## Lint & Typecheck

```bash
bun run lint:all    # oxlint with type-checking. Always run after changes.
```

## Key Patterns

1. **Enum pattern**: Use `createEnum()` from `types/index.ts`, not TypeScript `enum`. Produces both value object and type via `.infer`. Example: `ShaderType.dithering` (value), `ShaderType` (type).
2. **Store pattern**: Extend `Store<T>` from `lib/store.ts` for reactive state. Use `createSnapshot(versionKey, create)` for `useSyncExternalStore`, `getComputed(key, versionKey, compute)` for derived values with structural sharing.
3. **Private fields**: Use `#` private class fields, not `private` keyword.
4. **No barrel exports**: Only `engine/index.ts` and `types/index.ts` have barrels. Import directly from files elsewhere.
5. **GPU resources**: Always clean up buffers/textures. Use `TexturePool` for intermediates. Track entity textures in Maps keyed by entity ID.
6. **Undo pattern**: Wrap state mutations in `Command.create({ execute, undo, onEvict })`, push to `undo` singleton from `lib/undo.ts`.

## Anti-Patterns

- Do not use TypeScript `enum` keyword. Use `createEnum()`.
- Do not add `"use client"` / `"use server"` — this is a SPA, not Next.js.
- Do not import from `node_modules` internals. Use `opensrc/` for source reading.
- Do not create new context providers without discussion.

## Export Pipeline

Video: WebCodecs H.264 + mediabunny muxer in Web Worker (MP4/MOV only). GIF: gifenc in Web Worker (`lib/gif-encoder-worker.ts`). No WebM. Audio: demuxed via mediabunny, passed as raw AAC packets.

## Upscale Pipeline

WebGPU compute-based 2x upscaling via Anime4K CNN models. `renderer/upscale/` contains the GPU network, `context/upscale-queue-context.tsx` manages job queue. Supports image, GIF, and video entities. Model weights in `weights/` (JSON), loaded at runtime. 3 sizes (S/M/L) × 3 content variants (rl/an/3d).

## Provider Composition (app.tsx)

`NuqsAdapter > KeybindProvider > IconoirProvider > ToastProvider > CanvasProvider > VideoExportProvider > ExportQueueProvider > UpscaleQueueProvider > LayoutProvider`

## Vite Plugins (plugins/)

- `vite-plugin-image.ts` — `?img` import suffix. Generates responsive `<picture>` data: multi-width srcsets in avif/webp, thumbhash blur-up placeholders. Uses `sharp` for resizing.
- `vite-plugin-wgsl-minify.ts` — Minifies `.wgsl?raw` imports in production builds using `miniray`.

## Media Assets

Static media images live in `media/` (not `public/media/`). Import via `#media/*` alias with `?img` suffix for responsive image data.

## Serialization

`.vdmsh` zip files via fflate. See `lib/serialization/` for format docs.

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is available in `opensrc/` for deeper understanding of implementation details.

See `opensrc/sources.json` for the list of available packages and their versions.

Use this source code when you need to understand how a package works internally, not just its types/interface.

### Fetching Additional Source Code

To fetch source code for a package or repository you need to understand, run:

```bash
npx opensrc <package>           # npm package (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python package (e.g., npx opensrc pypi:requests)
npx opensrc crates:<package>    # Rust crate (e.g., npx opensrc crates:serde)
npx opensrc <owner>/<repo>      # GitHub repo (e.g., npx opensrc vercel/ai)
```

<!-- opensrc:end -->

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, but it invokes Vite through `vp dev` and `vp build`.

## Vite+ Workflow

`vp` is a global binary that handles the full development lifecycle. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

### Start

- create - Create a new project from a template
- migrate - Migrate an existing project to Vite+
- config - Configure hooks and agent integration
- staged - Run linters on staged files
- install (`i`) - Install dependencies
- env - Manage Node.js versions

### Develop

- dev - Run the development server
- check - Run format, lint, and TypeScript type checks
- lint - Lint code
- fmt - Format code
- test - Run tests

### Execute

- run - Run monorepo tasks
- exec - Execute a command from local `node_modules/.bin`
- dlx - Execute a package binary without installing it as a dependency
- cache - Manage the task cache

### Build

- build - Build for production
- pack - Build libraries
- preview - Preview production build

### Manage Dependencies

Vite+ automatically detects and wraps the underlying package manager such as pnpm, npm, or Yarn through the `packageManager` field in `package.json` or package manager-specific lockfiles.

- add - Add packages to dependencies
- remove (`rm`, `un`, `uninstall`) - Remove packages from dependencies
- update (`up`) - Update packages to latest versions
- dedupe - Deduplicate dependencies
- outdated - Check for outdated packages
- list (`ls`) - List installed packages
- why (`explain`) - Show why a package is installed
- info (`view`, `show`) - View package information from the registry
- link (`ln`) / unlink - Manage local package links
- pm - Forward a command to the package manager

### Maintain

- upgrade - Update `vp` itself to the latest version

These commands map to their corresponding tools. For example, `vp dev --port 3000` runs Vite's dev server and works the same as Vite. `vp test` runs JavaScript tests through the bundled Vitest. The version of all tools can be checked using `vp --version`. This is useful when researching documentation, features, and bugs.

## Common Pitfalls

- **Using the package manager directly:** Do not use pnpm, npm, or Yarn directly. Vite+ can handle all package manager operations.
- **Always use Vite commands to run tools:** Don't attempt to run `vp vitest` or `vp oxlint`. They do not exist. Use `vp test` and `vp lint` instead.
- **Running scripts:** Vite+ commands take precedence over `package.json` scripts. If there is a `test` script defined in `scripts` that conflicts with the built-in `vp test` command, run it using `vp run test`.
- **Do not install Vitest, Oxlint, Oxfmt, or tsdown directly:** Vite+ wraps these tools. They must not be installed directly. You cannot upgrade these tools by installing their latest versions. Always use Vite+ commands.
- **Use Vite+ wrappers for one-off binaries:** Use `vp dlx` instead of package-manager-specific `dlx`/`npx` commands.
- **Import JavaScript modules from `vite-plus`:** Instead of importing from `vite` or `vitest`, all modules should be imported from the project's `vite-plus` dependency. For example, `import { defineConfig } from 'vite-plus';` or `import { expect, test, vi } from 'vite-plus/test';`. You must not install `vitest` to import test utilities.
- **Type-Aware Linting:** There is no need to install `oxlint-tsgolint`, `vp lint --type-aware` works out of the box.

## Review Checklist for Agents

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to validate changes.
<!--VITE PLUS END-->
