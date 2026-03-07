import { oklchToP3Css, oklchToSrgbCss, type OklchColor } from "#lib/color-utils.ts";
import { createEnum } from "#types/index.ts";

export const ColorValueFormat = createEnum({
  p3: "p3",
  hex: "hex",
});
export type ColorValueFormat = typeof ColorValueFormat.infer;

export interface ColorValueFormatOptions {
  supportsP3: boolean;
}

export interface ColorValueFormatDefinition {
  id: ColorValueFormat;
  label: string;
  matches: (css: string) => boolean;
  normalize: (raw: string) => string | null;
  format: (oklch: OklchColor) => string;
  isAvailable: (options: ColorValueFormatOptions) => boolean;
}

const VALID_HEX_RE = /^[0-9a-fA-F]{3}([0-9a-fA-F]([0-9a-fA-F]{2}([0-9a-fA-F]{2})?)?)?$/;
const P3_RE =
  /^color\(display-p3\s+([\d.]+%?|none)\s+([\d.]+%?|none)\s+([\d.]+%?|none)(?:\s*\/\s*([\d.]+%?|none))?\)$/;

function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!VALID_HEX_RE.test(hex)) return null;
  return `#${hex}`;
}

function normalizeP3(raw: string): string | null {
  const trimmed = raw.trim();
  return P3_RE.test(trimmed) ? trimmed : null;
}

const FORMAT_DEFINITIONS: readonly ColorValueFormatDefinition[] = [
  {
    id: ColorValueFormat.p3,
    label: "P3",
    matches: (css) => P3_RE.test(css.trim()),
    normalize: normalizeP3,
    format: oklchToP3Css,
    isAvailable: ({ supportsP3 }) => supportsP3,
  },
  {
    id: ColorValueFormat.hex,
    label: "Hex",
    matches: (css) => {
      const trimmed = css.trim();
      const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
      return VALID_HEX_RE.test(hex);
    },
    normalize: normalizeHex,
    format: oklchToSrgbCss,
    isAvailable: () => true,
  },
] as const;

const FORMATS_WITH_P3 = FORMAT_DEFINITIONS.filter((definition) =>
  definition.isAvailable({ supportsP3: true }),
);
const FORMATS_HEX_ONLY = FORMAT_DEFINITIONS.filter((definition) =>
  definition.isAvailable({ supportsP3: false }),
);

export function getColorValueFormatDefinition(
  format: ColorValueFormat,
): ColorValueFormatDefinition | undefined {
  return FORMAT_DEFINITIONS.find((definition) => definition.id === format);
}

export function getAvailableColorValueFormats(
  options: ColorValueFormatOptions,
): readonly ColorValueFormatDefinition[] {
  return options.supportsP3 ? FORMATS_WITH_P3 : FORMATS_HEX_ONLY;
}

export function detectColorValueFormat(
  css: string,
  options: ColorValueFormatOptions,
): ColorValueFormat | null {
  const definition = getAvailableColorValueFormats(options).find((candidate) =>
    candidate.matches(css),
  );
  return definition?.id ?? null;
}

export function normalizeColorValueForFormat(raw: string, format: ColorValueFormat): string | null {
  return getColorValueFormatDefinition(format)?.normalize(raw) ?? null;
}

export function formatOklchForValueFormat(oklch: OklchColor, format: ColorValueFormat): string {
  const definition = getColorValueFormatDefinition(format);
  if (!definition) return oklchToSrgbCss(oklch);
  return definition.format(oklch);
}
