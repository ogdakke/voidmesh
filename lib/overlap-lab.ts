import { Store } from "./store.ts";

export const overlapDefaults = {
  enabled: true,
  dragUnder: true,
  transition: 200,
  rgbStrength: 0.5,
  rgbDecay: 200,
  rgbSplit: 20,
  wakeStrength: 0.2,
  wakeDecay: 600,
  wakeWidth: 12,
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
