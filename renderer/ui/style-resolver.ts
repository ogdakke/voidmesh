import type { UIColor, UIColorValue, UIBackground, UIThemeValue } from "./elements.ts";

export interface UIResolvedSolidBackground {
  type: "solid";
  color: UIColor;
}

export interface UIResolvedGradientBackground {
  type: "gradient";
  top: UIColor;
  bottom: UIColor;
}

export type UIResolvedBackground = UIResolvedSolidBackground | UIResolvedGradientBackground;

const TRANSPARENT: UIColor = { r: 0, g: 0, b: 0, a: 0 };

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isThemeValue<T>(value: unknown): value is UIThemeValue<T> {
  return !!value && typeof value === "object" && "type" in value && value.type === "theme";
}

function isUIColor(value: unknown): value is UIColor {
  return (
    !!value &&
    typeof value === "object" &&
    "r" in value &&
    "g" in value &&
    "b" in value &&
    "a" in value
  );
}

function parseHexChannel(hex: string): number {
  return Number.parseInt(hex, 16) / 255;
}

function parseHexColor(input: string): UIColor | null {
  const hex = input.trim();
  if (!hex.startsWith("#")) return null;

  const raw = hex.slice(1);
  if (raw.length === 3) {
    return {
      r: parseHexChannel(raw[0]!.repeat(2)),
      g: parseHexChannel(raw[1]!.repeat(2)),
      b: parseHexChannel(raw[2]!.repeat(2)),
      a: 1,
    };
  }
  if (raw.length === 4) {
    return {
      r: parseHexChannel(raw[0]!.repeat(2)),
      g: parseHexChannel(raw[1]!.repeat(2)),
      b: parseHexChannel(raw[2]!.repeat(2)),
      a: parseHexChannel(raw[3]!.repeat(2)),
    };
  }
  if (raw.length === 6) {
    return {
      r: parseHexChannel(raw.slice(0, 2)),
      g: parseHexChannel(raw.slice(2, 4)),
      b: parseHexChannel(raw.slice(4, 6)),
      a: 1,
    };
  }
  if (raw.length === 8) {
    return {
      r: parseHexChannel(raw.slice(0, 2)),
      g: parseHexChannel(raw.slice(2, 4)),
      b: parseHexChannel(raw.slice(4, 6)),
      a: parseHexChannel(raw.slice(6, 8)),
    };
  }

  return null;
}

function parseRgbChannel(raw: string): number {
  const value = raw.trim();
  if (value.endsWith("%")) {
    return clamp01(Number.parseFloat(value) / 100);
  }
  return clamp01(Number.parseFloat(value) / 255);
}

function parseAlphaChannel(raw: string): number {
  const value = raw.trim();
  if (value.endsWith("%")) {
    return clamp01(Number.parseFloat(value) / 100);
  }
  return clamp01(Number.parseFloat(value));
}

function parseRgbColor(input: string): UIColor | null {
  const match = input
    .trim()
    .match(
      /^rgba?\(\s*([^)/,\s]+)[,\s]+([^)/,\s]+)[,\s]+([^)/,\s]+)(?:\s*\/\s*([^)]+)|[,\s]+([^)]+))?\s*\)$/i,
    );
  if (!match) return null;

  const alphaRaw = match[4] ?? match[5];
  return {
    r: parseRgbChannel(match[1]!),
    g: parseRgbChannel(match[2]!),
    b: parseRgbChannel(match[3]!),
    a: alphaRaw ? parseAlphaChannel(alphaRaw) : 1,
  };
}

function normalizeCssColorInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("--")) {
    return `var(${trimmed})`;
  }
  return trimmed;
}

export class UIStyleResolver {
  #darkMode = false;
  #colorCache = new Map<string, UIColor>();
  #dirty = false;
  #themeMediaQuery: MediaQueryList | null = null;
  #themeListener: (() => void) | null = null;
  #colorCanvas: HTMLCanvasElement | null = null;
  #colorContext: CanvasRenderingContext2D | null = null;

  constructor() {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    this.#themeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.#darkMode = this.#themeMediaQuery.matches;
    this.#themeListener = () => {
      const nextDarkMode = this.#themeMediaQuery?.matches ?? false;
      if (this.#darkMode === nextDarkMode) return;
      this.#darkMode = nextDarkMode;
      this.#colorCache.clear();
      this.#dirty = true;
    };
    this.#themeMediaQuery.addEventListener("change", this.#themeListener);
  }

  get isDirty(): boolean {
    return this.#dirty;
  }

  markClean(): void {
    this.#dirty = false;
  }

  resolveColor(value: UIColorValue | undefined, fallback: UIColor = TRANSPARENT): UIColor {
    if (value == null) return fallback;

    if (isThemeValue(value)) {
      const themed = this.#darkMode ? value.dark : value.light;
      return this.resolveColor(themed, fallback);
    }

    if (isUIColor(value)) {
      return value;
    }

    if (typeof value !== "string") return fallback;

    const cacheKey = `${this.#darkMode ? "dark" : "light"}:${value}`;
    const cached = this.#colorCache.get(cacheKey);
    if (cached) return cached;

    const parsed =
      parseHexColor(value) ??
      parseRgbColor(value) ??
      this.#resolveCssColor(value) ??
      this.#resolveWithCanvas(value) ??
      fallback;
    this.#colorCache.set(cacheKey, parsed);
    return parsed;
  }

  resolveBackground(background: UIBackground | undefined): UIResolvedBackground | undefined {
    if (!background) return undefined;

    const resolved = isThemeValue(background)
      ? this.#darkMode
        ? background.dark
        : background.light
      : background;

    if (resolved.type === "solid") {
      return { type: "solid", color: this.resolveColor(resolved.color, TRANSPARENT) };
    }

    return {
      type: "gradient",
      top: this.resolveColor(resolved.top, TRANSPARENT),
      bottom: this.resolveColor(resolved.bottom, TRANSPARENT),
    };
  }

  #resolveCssColor(rawValue: string): UIColor | null {
    if (typeof document === "undefined") return null;

    const value = normalizeCssColorInput(rawValue);
    const probe = document.createElement("span");
    probe.style.color = value;
    const parent = document.body ?? document.documentElement;
    parent.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return parseRgbColor(resolved) ?? this.#resolveWithCanvas(resolved);
  }

  #resolveWithCanvas(rawValue: string): UIColor | null {
    if (typeof document === "undefined") return null;

    if (!this.#colorCanvas) {
      this.#colorCanvas = document.createElement("canvas");
      this.#colorCanvas.width = 1;
      this.#colorCanvas.height = 1;
      this.#colorContext = this.#colorCanvas.getContext("2d", { willReadFrequently: true });
    }

    const ctx = this.#colorContext;
    if (!ctx) return null;

    const value = normalizeCssColorInput(rawValue);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000000";

    try {
      ctx.fillStyle = value;
    } catch {
      return null;
    }

    ctx.fillRect(0, 0, 1, 1);
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    return {
      r: pixel[0]! / 255,
      g: pixel[1]! / 255,
      b: pixel[2]! / 255,
      a: pixel[3]! / 255,
    };
  }

  destroy(): void {
    if (this.#themeMediaQuery && this.#themeListener) {
      this.#themeMediaQuery.removeEventListener("change", this.#themeListener);
    }
    this.#themeMediaQuery = null;
    this.#themeListener = null;
    this.#colorCache.clear();
    this.#colorCanvas = null;
    this.#colorContext = null;
    this.#dirty = false;
  }
}
