import type { MediaTimeParts } from "#lib/time-format.ts";

export interface MediaProgressFrame {
  currentTime: number;
  duration: number;
  currentParts: MediaTimeParts;
  durationParts: MediaTimeParts;
  hovered: boolean;
  focused: boolean;
  dragging: boolean;
  scrubProgress: number;
}

export interface MediaProgressRenderConfig {
  trackColor: string;
  progressColor: string;
  textColor: string;
  fontFamily: string;
  fontWeight: string;
  fontSize: number;
  textY: number;
  trackHeight: number;
  trackRadius: number;
}

const TEXT_ALPHA = 0.7;
const TEXT_ACTIVE_ALPHA = 1;
const MS_SCALE = 0.85;
const EDGE_INSET = 1;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function setFont(ctx: CanvasRenderingContext2D, cfg: MediaProgressRenderConfig, scale = 1): void {
  const font = `${cfg.fontWeight} ${cfg.fontSize * scale}px ${cfg.fontFamily}`;
  if (ctx.font !== font) ctx.font = font;
}

function drawTimeLabels(
  ctx: CanvasRenderingContext2D,
  cfg: MediaProgressRenderConfig,
  current: MediaTimeParts,
  duration: MediaTimeParts,
  width: number,
  y: number,
): void {
  setFont(ctx, cfg);
  const currentMainWidth = ctx.measureText(current.main).width;
  const durationMainWidth = ctx.measureText(duration.main).width;
  setFont(ctx, cfg, MS_SCALE);
  const currentMs = `:${current.ms}`;
  const durationMs = `:${duration.ms}`;
  const durationMsWidth = ctx.measureText(durationMs).width;
  const durationStart = width - EDGE_INSET - durationMainWidth - durationMsWidth;

  setFont(ctx, cfg);
  ctx.fillText(current.main, EDGE_INSET, y);
  ctx.fillText(duration.main, durationStart, y);

  setFont(ctx, cfg, MS_SCALE);
  ctx.globalAlpha *= 0.7;
  ctx.fillText(currentMs, EDGE_INSET + currentMainWidth, y);
  ctx.fillText(durationMs, durationStart + durationMainWidth, y);
  ctx.globalAlpha /= 0.7;
}

export function renderMediaProgress(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: MediaProgressFrame,
  cfg: MediaProgressRenderConfig,
): void {
  ctx.clearRect(0, 0, width, height);

  const textAlpha =
    frame.hovered || frame.focused || frame.dragging ? TEXT_ACTIVE_ALPHA : TEXT_ALPHA;
  const progress = frame.duration > 0 ? clamp01(frame.currentTime / frame.duration) : 0;
  const trackX = EDGE_INSET;
  const trackWidth = Math.max(0, width - EDGE_INSET * 2);
  const trackHeight = cfg.trackHeight + (cfg.trackHeight / 2) * frame.scrubProgress;
  const trackY = Math.round(height / 2 + 4 - cfg.trackHeight / 2);
  const trackRadius = Math.min(cfg.trackRadius, trackHeight / 2);
  const textY = cfg.textY;

  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = cfg.textColor;
  ctx.globalAlpha = textAlpha;
  drawTimeLabels(ctx, cfg, frame.currentParts, frame.durationParts, width, textY);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = cfg.trackColor;
  drawRoundRect(ctx, trackX, trackY, trackWidth, trackHeight, trackRadius);

  if (progress > 0) {
    ctx.beginPath();
    ctx.roundRect(trackX, trackY, trackWidth, trackHeight, trackRadius);
    ctx.clip();
    ctx.fillStyle = cfg.progressColor;
    ctx.fillRect(trackX, trackY, trackWidth * progress, trackHeight);
  }

  ctx.restore();
}
