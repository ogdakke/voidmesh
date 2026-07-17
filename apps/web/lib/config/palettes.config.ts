import type { ColorPalette } from "#types/canvas.ts";
import { hex } from "../color-utils";

/**
 * Preset color palettes for dithering
 */
export const palettes = {
  blackAndWhite: {
    id: "blackAndWhite",
    name: "Black & White",
    shortName: "B&W",
    colors: [
      hex("#000000"), // Black
      hex("#ffffff"), // White
    ],
  },
  gameboy: {
    id: "gameboy",
    name: "Game Boy",
    shortName: "GB",
    colors: [
      hex("#0f380f"), // Darkest green
      hex("#306230"), // Dark green
      hex("#8bac0f"), // Light green
      hex("#9bbc0f"), // Lightest green
    ],
  },

  gameboyPocket: {
    id: "gameboyPocket",
    name: "Game Boy Pocket",
    shortName: "GB Pocket",
    colors: [hex("#181818"), hex("#4a5138"), hex("#8c926b"), hex("#c5caa4")],
  },

  gameboyLight: {
    id: "gameboyLight",
    name: "Game Boy Light",
    shortName: "GB Light",
    colors: [hex("#004f3a"), hex("#00694a"), hex("#009a70"), hex("#00b582")],
  },

  grayscale4: {
    id: "grayscale4",
    name: "Grayscale 4",
    shortName: "Gray 4",
    colors: [
      hex("#000000"), // Black
      hex("#555555"), // Dark gray
      hex("#aaaaaa"), // Light gray
      hex("#ffffff"), // White
    ],
  },

  grayscale8: {
    id: "grayscale8",
    name: "Grayscale 8",
    shortName: "Gray 8",
    colors: [
      hex("#000000"),
      hex("#242424"),
      hex("#494949"),
      hex("#6d6d6d"),
      hex("#929292"),
      hex("#b6b6b6"),
      hex("#dbdbdb"),
      hex("#ffffff"),
    ],
  },

  midnightAblaze: {
    id: "midnightAblaze",
    name: "Midnight Ablaze",
    shortName: "Midnight Ablaze",
    colors: [
      hex("#130208"),
      hex("#1f0510"),
      hex("#31051e"),
      hex("#460e2b"),
      hex("#7c183c"),
      hex("#d53c6a"),
      hex("#ff8274"),
    ],
  },

  sepia: {
    id: "sepia",
    name: "Sepia",
    shortName: "Sepia",
    colors: [hex("#352318"), hex("#5c3d2e"), hex("#8b5a3c"), hex("#d4a574"), hex("#f5deb3")],
  },

  winter: {
    id: "winter",
    name: "Winter",
    shortName: "Winter",
    colors: [
      hex("#20284e"),
      hex("#2c4a78"),
      hex("#3875a1"),
      hex("#8bcadd"),
      hex("#ffffff"),
      hex("#d6e1e9"),
      hex("#a7bcc9"),
      hex("#738d9d"),
    ],
  },

  cyberpunk: {
    id: "cyberpunk",
    name: "Cyberpunk",
    shortName: "Cyberpunk",
    colors: [
      hex("#0d0221"),
      hex("#0f084b"),
      hex("#26408b"),
      hex("#ff124f"),
      hex("#ff00a0"),
      hex("#fe75fe"),
    ],
  },

  sunset: {
    id: "sunset",
    name: "Sunset",
    shortName: "Sunset",
    colors: [hex("#1a1a2e"), hex("#16213e"), hex("#e94560"), hex("#ff6b35"), hex("#f7c566")],
  },

  cga: {
    id: "cga",
    name: "CGA",
    shortName: "CGA",
    colors: [
      hex("#000000"), // Black
      hex("#0000aa"), // Blue
      hex("#00aa00"), // Green
      hex("#00aaaa"), // Cyan
      hex("#aa0000"), // Red
      hex("#aa00aa"), // Magenta
      hex("#aa5500"), // Brown
      hex("#aaaaaa"), // Light gray
      hex("#555555"), // Dark gray
      hex("#5555ff"), // Light blue
      hex("#55ff55"), // Light green
      hex("#55ffff"), // Light cyan
      hex("#ff5555"), // Light red
      hex("#ff55ff"), // Light magenta
      hex("#ffff55"), // Yellow
      hex("#ffffff"), // White
    ],
  },

  commodore64: {
    id: "commodore64",
    name: "Commodore 64",
    shortName: "C64",
    colors: [
      hex("#000000"), // Black
      hex("#ffffff"), // White
      hex("#880000"), // Red
      hex("#aaffee"), // Cyan
      hex("#cc44cc"), // Purple
      hex("#00cc55"), // Green
      hex("#0000aa"), // Blue
      hex("#eeee77"), // Yellow
      hex("#dd8855"), // Orange
      hex("#664400"), // Brown
      hex("#ff7777"), // Light red
      hex("#333333"), // Dark gray
      hex("#777777"), // Medium gray
      hex("#aaff66"), // Light green
      hex("#0088ff"), // Light blue
      hex("#bbbbbb"), // Light gray
    ],
  },
} satisfies Record<string, ColorPalette>;
