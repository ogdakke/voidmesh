import { Store } from "./store.ts";

export const overlapDefaults = {
  enabled: false,
  transition: 200,
  rgbStrength: 1.55,
  rgbDecay: 400,
  rgbSplit: 7,
  wakeStrength: 0.3,
  wakeDecay: 400,
  wakeWidth: 14,
};
class OverlapLab extends Store<typeof overlapDefaults> {
  constructor() {
    super({ ...overlapDefaults });
  }
  getSnapshot = () => this.state;
  configure(patch: Partial<typeof this.state>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
  }
}
/** Session-only controls for the canvas overlap treatment. */
export const overlapLab = new OverlapLab();
