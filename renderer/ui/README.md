# Canvas UI

A React-reconciler-based UI system that renders directly onto the WebGPU canvas. No DOM overlays, no HTML — boxes, text, and icons are drawn as GPU primitives in world space.

## Architecture

```
React Components (.tsx with hooks, context, compiler)
  ↓ React reconciler (react-reconciler)
SceneNode tree (retained across frames)
  ↓ Two-pass flexbox layout
UILayoutResult (flat arrays of boxes, text, icons)
  ↓ Single GPU render pass
Pixels on canvas
```

Three layers:

1. **React → SceneNode reconciliation** — `host-config.ts`, `canvas-reconciler.ts`
2. **Layout + animation** — `ui-layout.ts`, `scene-node.ts`, `style-resolver.ts`
3. **GPU rendering** — `ui-box-pipeline.ts`, `ui-icon-pipeline.ts`, text renderer

## How It Works

### Reconciliation

The system uses `react-reconciler` to drive a custom renderer. React components written with standard hooks and JSX compile to React elements, which the reconciler maps to `SceneNode` mutations via the host config.

Four intrinsic element types are recognized:

| Intrinsic     | SceneNode type | Wrapper    | Purpose                          |
| ------------- | -------------- | ---------- | -------------------------------- |
| `<ui-box>`    | `box`          | `<Box>`    | Flexbox container with styling   |
| `<ui-text>`   | `text`         | `<Text>`   | GPU-rendered text (Slug SDF)     |
| `<ui-icon>`   | `icon`         | `<Icon>`   | Tinted SVG icon texture          |
| `<ui-anchor>` | `anchor`       | `<Anchor>` | Positioned relative to an entity |

Use the PascalCase wrappers from `primitives.tsx` in components:

```tsx
import { Box, Text, Icon } from "./primitives.tsx";
import { Check } from "iconoir-react";

function MyButton({ label }: { label: string }) {
  return (
    <Box direction="row" gap={6} padding={edges(6, 12)} background={PRIMARY_BG} borderRadius={6}>
      <Icon icon={Check} size={14} tint="#ffffff" />
      <Text fontSize={12} color="#ffffff">
        {label}
      </Text>
    </Box>
  );
}
```

React Compiler handles memoization automatically — no `memo()` wrappers needed.

### Synchronous Updates

React reconciliation is **not** called every frame. It only runs when `updateScene()` is called with a new element. `flushSyncFromReconciler` guarantees the React commit completes synchronously before returning, so SceneNodes are ready for the same frame's layout pass.

```
updateScene(key, element)  → synchronous React commit → SceneNodes updated
renderScene(key, ...)      → layout + GPU draw (no reconciliation)
```

### Scene Management

Each independent piece of UI (entity label, debug overlay) gets its own scene with a unique key. Each scene has its own React fiber root and SceneNode tree.

```typescript
// canvas-renderer.ts
uiRenderer.updateScene("label-entity-1", createElement(EntityLabel, { entity, isDragging }));
uiRenderer.renderScene("label-entity-1", worldX, worldY, encoder, targetView, scale);
```

A scene can be rendered multiple times per frame at different positions (e.g., main pass + action layer pass) without re-reconciling.

## SceneNode

`SceneNode` is the retained tree node. It persists across frames and owns:

- **Props** — visual properties (background, padding, fontSize, etc.)
- **Children** — child SceneNodes
- **Layout** — `{ x, y, width, height }` computed by the layout engine
- **Animation state** — `Map<string, PropertyTween>` for per-property tweens and springs
- **Interaction state** — `isHovered`, `isActive`, `dragOffset`
- **Phase** — `"entering"` | `"active"` | `"exiting"`

### Animation

Each node has a `tweens` map. When a prop target changes, the tween starts from the current value and interpolates to the new target. Two types:

- **Tween** — Duration + easing function
- **Spring** — Critically damped harmonic oscillator parameterized by `response` (seconds)

Animation state is resolved during the layout pass via `resolveAnimatedValue()`. This means animations run at frame rate without triggering React re-renders.

### Exit Animations (Ghost Nodes)

When React removes a child, the host config's `removeChild` does **not** splice the node from the children array. Instead, it calls `beginExit()` which sets the node's phase to `"exiting"`. The node stays in the tree (a "ghost node") so it can continue to animate and render.

After each frame, `pruneExitedNodes()` walks the tree and removes nodes where `phase === "exiting"` and all tweens are done.

## Layout Engine

Two-pass flexbox-like algorithm in `ui-layout.ts`:

**Pass 1 — Measure (bottom-up):** Computes intrinsic width/height for each node. Text is measured via Slug SDF metrics. Flex shrink reduces children proportionally when they overflow.

**Pass 2 — Position (top-down):** Assigns x/y positions, distributes free space via `flexGrow`, resolves animated values, applies visual scale transforms.

### Supported Layout Props

| Prop                                 | Values                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `direction`                          | `"row"` \| `"col"`                                                          |
| `gap`                                | number (pixels)                                                             |
| `padding`                            | `UIEdges` or number                                                         |
| `align`                              | `"start"` \| `"center"` \| `"end"`                                          |
| `justifyContent`                     | `"start"` \| `"center"` \| `"end"` \| `"space-between"` \| `"space-around"` |
| `flexGrow` / `flexShrink`            | number                                                                      |
| `width` / `height` / `min*` / `max*` | number (pixels)                                                             |
| `position`                           | `"relative"` \| `"absolute"` \| `"fixed"`                                   |
| `zIndex`                             | number                                                                      |

### Scale Factor

All sizes are multiplied by a `scale` parameter:

- **Screen-space UI** (entity labels): `scale = dpr / zoom` — keeps elements constant size on screen regardless of canvas zoom
- **World-space UI** (debug overlay): `scale = dpr` — scales with zoom

### Layout Caching

Layout results are cached per scene key and reused when:

- `renderVersion` unchanged (no prop/child changes)
- Anchor position, scale unchanged
- No active animations or interaction changes
- Viewport zoom/size unchanged (for `position: "fixed"` elements)

Panning (viewport offset change only) does **not** invalidate the cache — the GPU viewport uniform handles the shift.

## GPU Rendering

### Single Render Pass

All UI elements are merged into a single GPU render pass. Boxes, icons, and text are sorted by `(zIndex, documentOrder)` and drawn in sequence with minimal pipeline switches.

### Box Pipeline (`ui-box-pipeline.ts` + `ui-box.wgsl`)

Instanced rendering of SDF rounded rectangles. Up to 16 boxes per draw call. Features:

- Procedural anti-aliased rounded corners via signed distance function
- Vertical gradients (top → bottom color)
- Borders via inner SDF offset
- Zoom-aware anti-aliasing band width

### Icon Pipeline (`ui-icon-pipeline.ts` + `ui-icon.wgsl`)

Instanced textured quads. Icons grouped by GPU texture, up to 16 per draw call. Features:

- Multiplicative tint coloring
- Linear-sampled textures

### Icon Cache (`ui-icon-cache.ts`)

SVG strings are rasterized to GPU textures on demand:

- **Size bucketing** — Raster sizes bucketed to 16px steps, 1.5x oversampled
- **LRU eviction** — 16 MB cache limit; least-recently-used textures evicted first
- **Fallback rendering** — While a higher-res texture loads, the closest available size is used

### Text

Text is rendered via the Slug SDF algorithm (external `text-shaper` library). Glyph curves are stored in GPU textures; text is batched and drawn in the shared render pass.

## Interaction

`handlePointerEvent(type, worldX, worldY)` dispatches pointer events:

1. **Hit test** — Depth-first reverse-child-order traversal finds the front-most interactive node
2. **Hover** — Sets `isHovered` on the hit node; clears previous
3. **Active** — Sets `isActive` on pointer down; clears on pointer up
4. **Drag** — Accumulates `dragOffset` on nodes with `draggable` prop
5. **Callbacks** — Dispatches `onClick`, `onPointerDown`, `onPointerUp`, `onDrag`

Interactive nodes are those with event handlers or `hover`/`active` state styles.

## Theming

`style-resolver.ts` resolves colors based on the system's `prefers-color-scheme`. Use `lightDark()` to define theme-variant colors:

```typescript
const PANEL_TEXT = lightDark("#151924", "#f5f7fb"); // light mode, dark mode
const PANEL_BG = solid(lightDark("rgba(248,249,252,0.94)", "rgba(16,18,24,0.94)"));
```

CSS custom properties (`var(--tint-1000)`) are also supported and resolved at render time.

## State Styles

Boxes support `hover` and `active` props for visual state changes:

```tsx
<Box
  hover={{ opacity: 0.96, scale: 1.02 }}
  active={{ scale: 0.96 }}
  transition={{ scale: spring(0.24) }}
/>
```

State style transitions are interpolated by the animation system — no React re-renders needed.

## Files

| File                   | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `host-config.ts`       | react-reconciler host config (React lifecycle → SceneNode) |
| `canvas-reconciler.ts` | Reconciler instance + sync update helpers                  |
| `primitives.tsx`       | `Box`, `Text`, `Icon`, `Anchor` wrapper components         |
| `jsx-types.ts`         | JSX `IntrinsicElements` augmentation for `ui-*` elements   |
| `ui-renderer.ts`       | Orchestrator: scene management, layout, GPU render, events |
| `scene-node.ts`        | Retained tree node + tween/spring animation + pruning      |
| `ui-layout.ts`         | Two-pass flexbox layout engine                             |
| `elements.ts`          | Type definitions (props, colors, animations, events)       |
| `style-resolver.ts`    | Theme-aware color resolution                               |
| `hit-test.ts`          | Point-in-rect hit testing                                  |
| `ui-box-pipeline.ts`   | GPU box rendering (instanced SDF quads)                    |
| `ui-box.wgsl`          | SDF rounded rectangle shader                               |
| `ui-icon-pipeline.ts`  | GPU icon rendering (instanced textured quads)              |
| `ui-icon.wgsl`         | Icon texture sampling shader                               |
| `ui-icon-cache.ts`     | SVG rasterization + LRU texture cache                      |
| `icon-from-react.ts`   | React icon component → SVG string bridge                   |
| `entity-label.tsx`     | Entity label component                                     |
| `debug-ui.tsx`         | Debug overlay stress test                                  |
