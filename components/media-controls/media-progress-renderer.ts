import type { MediaTimeParts } from "#lib/time-format.ts";

export interface MediaProgressFrame {
  currentTime: number;
  duration: number;
  currentParts: MediaTimeParts;
  durationParts: MediaTimeParts;
  hovered: boolean;
  focused: boolean;
  dragging: boolean;
}

export interface MediaProgressRenderConfig {
  trackColor: string;
  progressColor: string;
  textColor: string;
  focusColor: string;
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
  ctx.font = `${cfg.fontWeight} ${cfg.fontSize * scale}px ${cfg.fontFamily}`;
}

function measureTimeParts(
  ctx: CanvasRenderingContext2D,
  cfg: MediaProgressRenderConfig,
  parts: MediaTimeParts,
): { mainWidth: number; msWidth: number; totalWidth: number } {
  setFont(ctx, cfg);
  const mainWidth = ctx.measureText(parts.main).width;
  setFont(ctx, cfg, MS_SCALE);
  const msWidth = ctx.measureText(`:${parts.ms}`).width;
  setFont(ctx, cfg);
  return { mainWidth, msWidth, totalWidth: mainWidth + msWidth };
}

function drawTimeParts(
  ctx: CanvasRenderingContext2D,
  cfg: MediaProgressRenderConfig,
  parts: MediaTimeParts,
  x: number,
  y: number,
  align: "left" | "right",
): void {
  const metrics = measureTimeParts(ctx, cfg, parts);
  const startX = align === "right" ? x - metrics.totalWidth : x;

  setFont(ctx, cfg);
  ctx.fillText(parts.main, startX, y);

  setFont(ctx, cfg, MS_SCALE);
  ctx.globalAlpha *= 0.7;
  ctx.fillText(`:${parts.ms}`, startX + metrics.mainWidth, y);
  ctx.globalAlpha /= 0.7;
  setFont(ctx, cfg);
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
  const trackHeight = cfg.trackHeight;
  const trackY = Math.round(height / 2 + 4 - trackHeight / 2);
  const textY = cfg.textY;

  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = cfg.textColor;
  ctx.globalAlpha = textAlpha;
  drawTimeParts(ctx, cfg, frame.currentParts, EDGE_INSET, textY, "left");
  drawTimeParts(ctx, cfg, frame.durationParts, width - EDGE_INSET, textY, "right");
  ctx.restore();

  ctx.save();
  ctx.fillStyle = cfg.trackColor;
  drawRoundRect(ctx, trackX, trackY, trackWidth, trackHeight, cfg.trackRadius);

  if (progress > 0) {
    ctx.beginPath();
    ctx.roundRect(trackX, trackY, trackWidth, trackHeight, cfg.trackRadius);
    ctx.clip();
    ctx.fillStyle = cfg.progressColor;
    ctx.fillRect(trackX, trackY, trackWidth * progress, trackHeight);
  }

  if (frame.dragging || frame.focused) {
    const markerX = trackX + trackWidth * progress;
    ctx.fillStyle = cfg.focusColor;
    ctx.globalAlpha = frame.dragging ? 0.4 : 0.28;
    ctx.fillRect(Math.round(markerX) - 1, trackY - 5, 2, trackHeight + 10);
  }
  ctx.restore();
}
