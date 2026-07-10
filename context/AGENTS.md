# Context

React context providers wiring subsystems together. The "glue" layer between engine, renderer, and UI.

## Key Files

- `canvas-context.tsx` (~52KB) — `CanvasProvider`. Main orchestrator. Bridges URL query state (nuqs) to canvas state, entity CRUD with undo support, renderer registration, image export (copy/save). Largest, most complex file in the codebase.
- `use-canvas.ts` — Commands/renderer contexts and selector hooks. `useCanvasCommands()` exposes stable mutations, `useCanvasRendererService()` exposes renderer/color-space services, and selector hooks like `useSelectedEntity()` / `useViewport()` provide fine-grained reads.
- `export-queue-context.tsx` (~16KB) — Sequential video export queue with auto-download.
- `video-export-context.tsx` — Export options state (format, quality, resolution).
- `use-video-export.ts`, `use-export-queue.ts` — Hooks for the export contexts.
- `keybind-context.ts` (~17KB) — `KeybindStore extends Store`. Keyboard shortcut registration with hierarchical contexts (global > canvas > selection). Builder pattern for binds.
- `keybind-provider.tsx` — `KeybindProvider` wraps the keybind context.
- `upscale-queue-context.tsx` (~20KB) — `UpscaleQueueProvider`. Manages background upscaling jobs. Queues requests, processes sequentially (GPU single-threaded), creates new entities from results. Supports image, GIF, and video. Sorts by padded dimensions for GPU cache hits. Progress toasts with cancel support.
- `use-upscale-queue.ts` — `UpscaleQueueContext` definition and `useUpscaleQueue()` hook.
- `layout-context.tsx` — Layout state (fullscreen mode).
- `use-layout.ts` — Hook for layout context.

## Provider Composition (app.tsx)

```
NuqsAdapter > KeybindProvider > IconoirProvider > ToastProvider > CanvasProvider > VideoExportProvider > ExportQueueProvider > UpscaleQueueProvider > LayoutProvider
```

Note: `KeybindProvider` wraps outside `App()` at the root render level.

## Patterns

- `canvas-context.tsx` uses nuqs for URL-synced state — entity params round-trip through URL query parameters. Color/background/palette URL params removed; colors always sourced from config defaults (only `presetId` remains for palette URL sync).
- Resource ownership for undo: `resourceOwners` Map tracks which undo command may cleanup media resources on stack eviction.
- Static image cleanup releases the entity's shared media-asset reference; the final release closes the decoded bitmap. Never close an image entity's bitmap directly.
- Large duplicate operations precompute names with a `Set` and insert the completed batch through `CanvasStore.addEntities()`; avoid per-clone full-map name scans and notifications.
- Multi-selection shader changes use one `CanvasStore.updateEntities()` call and one bulk `Command`. Do not create per-entity commands or nested undo transactions inside slider-owned transactions.
- Entity deletion triggers disintegration animation (if `fancyDelete` enabled): renderer snapshots the texture, entity is removed immediately, overlay plays independently. Undo cancels the overlay.
- `fancyDelete` preference defaults to `true` unless `prefers-reduced-motion: reduce` is active.
- Export queue clones video elements to isolate export playback from preview playback.

## Anti-Patterns

- Do not add new context providers without updating composition order in `app.tsx`.
- Do not put rendering logic or GPU calls here. Context orchestrates; renderer executes.
- Do not mutate `canvasStore` state outside of context callbacks. The context is the intended mutation boundary for React-facing code.
- Do not reintroduce a broad `useCanvas()` state surface. Keep reads selector-based and mutations command-based.
