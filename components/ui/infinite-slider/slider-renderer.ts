/**
 * SliderRenderer — Pure Canvas 2D tick drawing for InfiniteSlider.
 *
 * Only draws ticks visible in the current viewport.
 * Uses exponential scale falloff matching the existing TickSlider visual.
 */

export interface SliderRenderConfig {
  /** Tick width in CSS pixels. @default 2 */
  tickWidth: number;
  /** Tick height in CSS pixels. @default 40 */
  tickHeight: number;
  /** Center-to-center spacing in CSS pixels. @default 5 */
  tickSpacing: number;
  /** Every Nth tick is visible (others transparent). @default 2 */
  ticksPerGroup: number;
  /** Exponential falloff rate for scale animation. @default 0.06 */
  falloff: number;
  /** Minimum scale for distant ticks. @default 0.4 */
  minScale: number;
  /** Maximum scale for the center tick. @default 1.0 */
  maxScale: number;
  /** Color for non-highlighted ticks (resolved CSS value). */
  tickColor: string;
  /** Color for the center (highlighted) tick (resolved CSS value). */
  highlightColor: string;
  /** Width of the fixed center pointer in CSS pixels. @default 2 */
  pointerWidth: number;
  /** Every Nth visible tick is a major tick (0 = disabled). @default 10 */
  majorTickInterval: number;
  /** Height of major ticks in CSS pixels. @default 48 */
  majorTickHeight: number;
  /** Color for major ticks (resolved CSS value). */
  majorTickColor: string;
  /** Minimum tick index to draw (null = unbounded). */
  minTick: number | null;
  /** Maximum tick index to draw (null = unbounded). */
  maxTick: number | null;
}

export const defaultRenderConfig: SliderRenderConfig = {
  tickWidth: 2,
  tickHeight: 40,
  tickSpacing: 5,
  ticksPerGroup: 2,
  falloff: 0.06,
  minScale: 0.4,
  maxScale: 1.0,
  tickColor: "rgba(160, 160, 160, 0.6)",
  highlightColor: "rgba(225, 225, 225, 1)",
  pointerWidth: 2,
  majorTickInterval: 10,
  majorTickHeight: 48,
  majorTickColor: "rgba(200, 200, 200, 0.8)",
  minTick: null,
  maxTick: null,
};

/**
 * Renders ticks onto a Canvas 2D context.
 *
 * @param ctx - Canvas 2D rendering context
 * @param width - Canvas CSS width (not pixel width)
 * @param height - Canvas CSS height (not pixel height)
 * @param dpr - devicePixelRatio for crisp rendering
 * @param offset - Current scroll offset in CSS pixels
 * @param cfg - Render configuration
 */
export function renderSliderTicks(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
  offset: number,
  cfg: SliderRenderConfig,
): void {
  // Clear
  ctx.clearRect(0, 0, width * dpr, height * dpr);

  const canvasCenter = width / 2;
  const {
    tickWidth,
    tickHeight,
    tickSpacing,
    ticksPerGroup,
    falloff,
    minScale,
    maxScale,
    tickColor,
    highlightColor,
    majorTickInterval,
    majorTickHeight,
    majorTickColor,
    pointerWidth,
  } = cfg;

  // Compute visible tick range (with some padding)
  const halfViewport = canvasCenter + tickSpacing * 2;
  const firstTick = Math.floor((offset - halfViewport) / tickSpacing);
  const lastTick = Math.ceil((offset + halfViewport) / tickSpacing);

  // Collect major tick rects to batch-draw after regular ticks
  const majorRects: Array<[number, number, number, number]> = [];

  // Pass 1: draw regular ticks, collect major ticks
  ctx.fillStyle = tickColor;

  for (let i = firstTick; i <= lastTick; i++) {
    // Skip ticks outside bounds (finite mode)
    if (cfg.minTick != null && i < cfg.minTick) continue;
    if (cfg.maxTick != null && i > cfg.maxTick) continue;

    // Skip invisible ticks (matching nth-child(odd) transparent pattern)
    if (i % ticksPerGroup !== 0) continue;

    const tickWorldX = i * tickSpacing;
    const tickCanvasX = canvasCenter + (tickWorldX - offset);

    // Off-screen culling
    if (tickCanvasX < -tickWidth || tickCanvasX > width + tickWidth) continue;

    const pixelDistance = Math.abs(tickCanvasX - canvasCenter);
    const isLeftOfCenter = tickCanvasX <= canvasCenter;

    const scale = isLeftOfCenter
      ? minScale + (maxScale - minScale) * Math.exp(-pixelDistance * falloff)
      : minScale;

    const isMajor = majorTickInterval > 0 && i % (majorTickInterval * ticksPerGroup) === 0;

    const baseHeight = isMajor ? majorTickHeight : tickHeight;
    const scaledHeight = baseHeight * scale;
    const x = (tickCanvasX - tickWidth / 2) * dpr;
    const y = (height - scaledHeight) * dpr;
    const w = tickWidth * dpr;
    const h = scaledHeight * dpr;

    if (isMajor) {
      majorRects.push([x, y, w, h]);
    } else {
      ctx.fillRect(x, y, w, h);
    }
  }

  // Pass 2: draw major ticks on top
  if (majorRects.length > 0) {
    ctx.fillStyle = majorTickColor;
    for (const [x, y, w, h] of majorRects) {
      ctx.fillRect(x, y, w, h);
    }
  }

  // Pass 3: draw fixed center pointer (always on top)
  // Clamp to boundary tick position when rubber-banding past limits
  {
    let pointerX = canvasCenter;
    if (cfg.minTick != null) {
      const minTickX = canvasCenter + (cfg.minTick * tickSpacing - offset);
      if (minTickX > canvasCenter) pointerX = minTickX;
    }
    if (cfg.maxTick != null) {
      const maxTickX = canvasCenter + (cfg.maxTick * tickSpacing - offset);
      if (maxTickX < canvasCenter) pointerX = maxTickX;
    }

    const pointerH = (majorTickInterval > 0 ? majorTickHeight : tickHeight) * maxScale;
    ctx.fillStyle = highlightColor;
    const x = (pointerX - pointerWidth / 2) * dpr;
    const y = (height - pointerH) * dpr;
    const w = pointerWidth * dpr;
    const h = pointerH * dpr;
    ctx.fillRect(x, y, w, h);
  }
}
