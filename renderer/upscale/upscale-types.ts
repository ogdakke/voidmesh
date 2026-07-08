import type { QualityPreset } from "#renderer/export-formats.ts";

/** Weight layer from the Anime4K CNN JSON format */
export interface WeightLayer {
  name: string;
  type: string;
  inputs: string[];
  output: string;
  weights: number[];
  bias: number[];
}

/** Weight file JSON structure */
export interface WeightFile {
  name: string;
  layers: Record<string, WeightLayer>;
}

export type ModelSize = "s" | "m" | "l";
export type ContentVariant = "rl" | "an" | "3d";

export interface UpscaleOptions {
  size?: ModelSize;
  variant?: ContentVariant;
}

export interface UpscaleVideoOptions extends UpscaleOptions {
  /** Output fps. Default: 30 */
  fps?: number;
  /** Container format. Default: 'mp4' */
  format?: "mp4" | "mov";
  /** Encoding quality preset. Default: 'high' */
  quality?: QualityPreset;
  /** Include audio from source video. Default: true */
  includeAudio?: boolean;
}

/** Config for a compute layer in the network graph */
export interface ComputeLayerConfig {
  label: string;
  /** Input buffer names (or 'texture' for first layer) */
  inputBufferNames: string[];
  /** Output buffer name */
  outputBufferName: string;
  /** Weight layer key in the weight file */
  weightKey: string;
  /** Layer type determines WGSL template */
  type: "conv3x4" | "conv8x4" | "conv16x4" | "conv56x4" | "conv112x4" | "concat2";
  /** For conv112x4: whether to use first or second kernel set */
  first?: boolean;
}

/** Config for the display (render) layer */
export interface DisplayLayerConfig {
  /** Number of input buffer channels: 1 for S model, 3 for M/L */
  channels: 1 | 3;
  /** Input buffer names */
  inputBufferNames: string[];
}
