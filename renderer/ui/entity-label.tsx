/** @jsxImportSource ./jsx */
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { easings } from "../../lib/canvas-math.ts";
import type { UIElement, UIBackground, UIColor } from "./elements.ts";
import { edges } from "./elements.ts";

// Drag icon SVG (iconoir "Drag" — 4 arrows pointing outward from center)
const DRAG_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 12L4 4M4 4V8M4 4H8"/><path d="M12 12L20 4M20 4V8M20 4H16"/><path d="M12 12L4 20M4 20V16M4 20H8"/><path d="M12 12L20 20M20 20V16M20 20H16"/></svg>`;

// Warning icon SVG (triangle with exclamation mark)
const WARNING_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v6" stroke="rgb(60,35,5)"/><circle cx="12" cy="16" r="0.5" fill="rgb(60,35,5)" stroke="rgb(60,35,5)"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="rgb(60,35,5)"/></svg>`;

/** All icon SVGs used in entity labels, for preloading. */
export const ENTITY_LABEL_ICONS = [DRAG_ICON_SVG, WARNING_ICON_SVG];

const BG_PRIMARY: UIBackground = {
  type: "gradient",
  top: { r: 0.27, g: 0.53, b: 0.96, a: 0.92 },
  bottom: { r: 0.2, g: 0.44, b: 0.9, a: 0.92 },
};

const BG_WARNING: UIBackground = {
  type: "gradient",
  top: { r: 0.95, g: 0.75, b: 0.28, a: 0.92 },
  bottom: { r: 0.93, g: 0.68, b: 0.18, a: 0.92 },
};

const TEXT_WHITE: UIColor = { r: 1, g: 1, b: 1, a: 0.9 };
const TEXT_DARK_AMBER: UIColor = { r: 0.25, g: 0.15, b: 0.02, a: 1.0 };

/**
 * Build a declarative UI element tree for an entity label.
 *
 * All sizes are in screen-space pixels — the layout engine handles
 * DPR/zoom scaling automatically via the `scale` parameter.
 */
export function buildEntityLabel(entity: ShaderCanvasEntity, isDragging: boolean): UIElement {
  const isWarning = entity.shaderParams.showOriginal;
  const background = isWarning ? BG_WARNING : BG_PRIMARY;
  const textColor = isWarning ? TEXT_DARK_AMBER : TEXT_WHITE;

  return (
    <box
      key={`label-${entity.id}`}
      direction="row"
      gap={4}
      padding={edges(4, 6, 4, 3)}
      background={background}
      borderRadius={6}
      align="center"
    >
      {!isWarning ? (
        <icon
          key={`drag-${entity.id}`}
          svg={DRAG_ICON_SVG}
          size={isDragging ? 16 : 0}
          animate={{
            size: { duration: 150, easing: easings.easeOutBack },
          }}
        />
      ) : (
        <icon key={`warn-${entity.id}`} svg={WARNING_ICON_SVG} size={14} />
      )}
      <text fontSize={13} color={textColor}>
        {isWarning ? `Original: ${entity.name}` : entity.name}
      </text>
    </box>
  );
}
