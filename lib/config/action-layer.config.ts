/** Configuration for the mobile action layer (radial context menu) */
export interface ActionLayerConfig {
  /** Radius of the safe zone circle in CSS pixels */
  safeZoneRadius: number;
  /** Radius of the button ring from center in CSS pixels */
  buttonRingRadius: number;
  /** Upward offset from touch point for finger clearance (CSS px) */
  fingerClearanceOffset: number;
  /** Diameter of each action button (CSS px) */
  buttonSize: number;
  /** Hit area expansion around each button (CSS px) */
  buttonHitPadding: number;
  /** Maximum number of action buttons */
  maxButtons: number;

  /** Finger movement deadzone before entity starts tracking (CSS px) */
  deadzone: number;
  /** Maximum entity rubber-band offset (CSS px) */
  entityRubberBandMax: number;
  /** Spring response for button appear animation (seconds) */
  buttonAppearSpring: number;
  /** Spring response for button hover scale-up (seconds) */
  buttonHoverSpring: number;
  /** Scale multiplier when a button is hovered */
  buttonHoverScale: number;
  /** Spring response for entity rubber-band dismiss (seconds, higher = slower) */
  entityRubberBandSpring: number;
  /** Entity spring response time during active phase (seconds, lower = snappier) */
  entitySpringResponse: number;
  /** Entity spring damping ratio during active phase (0-1, <1 = springy, 1 = critical) */
  entitySpringDamping: number;
  /** How much the ring origin follows the finger (0-1, fraction of rubber-band) */
  ringFollowFactor: number;

  /** Kawase blur strength at full activation (0-1) */
  blurIntensity: number;
  /** Kawase blur offset */
  blurOffset: number;
  /** Kawase blur levels */
  blurLevels: number;
  /** Dim/tint overlay opacity at full activation (0-1) */
  dimOpacity: number;
  /** Tint color for the blur overlay per theme [r, g, b] in 0-1 range */
  dimColor: { dark: [number, number, number]; light: [number, number, number] };
  /** Duration for blur fade-in (ms) */
  blurFadeInMs: number;
  /** Duration for blur fade-out when exiting safe zone (ms) */
  blurFadeOutMs: number;

  /** Safe zone progress (0-1) at which buttons start shrinking */
  buttonShrinkStart: number;
  /** Safe zone progress (0-1) at which blur starts fading */
  blurFadeStart: number;

  /** Screen edge inset for adaptive repositioning (CSS px) */
  edgeInset: number;
  /** Show debug overlays (safe zone circle, hit areas) */
  debug: "default" | "stay" | undefined;
}

export const actionLayerDefaults: ActionLayerConfig = {
  safeZoneRadius: 120,
  buttonRingRadius: 80,
  fingerClearanceOffset: 0,
  buttonSize: 48,
  buttonHitPadding: 12,
  maxButtons: 5,

  deadzone: 70,
  entityRubberBandMax: 80,
  buttonAppearSpring: 0.2,
  buttonHoverSpring: 0.15,
  buttonHoverScale: 1.15,
  entityRubberBandSpring: 0.25,
  entitySpringResponse: 0.45,
  entitySpringDamping: 0.95,
  ringFollowFactor: 0.08,

  blurIntensity: 0.9,
  blurOffset: 1,
  blurLevels: 4,
  dimOpacity: 0.05,
  dimColor: { dark: [0, 0, 0], light: [1, 1, 1] },
  blurFadeInMs: 200,
  blurFadeOutMs: 100,

  buttonShrinkStart: 0.9,
  blurFadeStart: 0.6,

  edgeInset: 8,
  debug: undefined, //"default",
};
