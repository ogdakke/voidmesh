/** Canvas crossing and drag-under material settings. Distances are CSS pixels. */
export interface OverlapConfig {
  enabled: boolean;
  dragUnder: boolean;
  transition: number;
  rgbStrength: number;
  rgbDecay: number;
  rgbSplit: number;
  wakeStrength: number;
  wakeDecay: number;
  wakeWidth: number;
}

export const overlapConfig: Readonly<OverlapConfig> = Object.freeze({
  enabled: true,
  dragUnder: true,
  transition: 200,
  rgbStrength: 1.5,
  rgbDecay: 200,
  rgbSplit: 20,
  wakeStrength: 0.2,
  wakeDecay: 600,
  wakeWidth: 12,
});
