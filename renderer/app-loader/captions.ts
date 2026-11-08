/** Loader captions, shared by the worker and the first-paint wordmark. */

/**
 * The first caption. It is the wordmark: index.html paints it before any module runs
 * (see wordmark.ts) and the PWA splash images show it at the same cells.
 */
export const OPENING_LINE = "voidmesh";

/** Captions cycled in a random order after the opening line. Keep each under ~21 chars. */
export const LINES = [
  "summoning shaders",
  "dithering the void",
  "scrying the canvas",
  "invoking the gpu",
  "bending photons",
  "transmuting light",
  "divining gradients",
  "awakening the mesh",
  "reading the noise",
  "tracing sacred grids",
  "chanting in hex",
  "casting halftones",
  "whispering to webgpu",
  "the void stares back",
];
