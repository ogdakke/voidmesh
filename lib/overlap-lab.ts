import { createEnum } from "#types/index.ts";
import { Store } from "./store.ts";

export const OverlapEffect = createEnum({
  off: "off",
  yield: "yield",
  diffusion: "diffusion",
  prism: "prism",
  wake: "wake",
  peel: "peel",
});
export type OverlapEffect = typeof OverlapEffect.infer;
export const overlapEffectOptions: readonly OverlapEffect[] = [
  "off",
  "yield",
  "diffusion",
  "prism",
  "wake",
  "peel",
];
class OverlapLab extends Store<{
  enabled: boolean;
  effect: OverlapEffect;
  strength: number;
  duration: number;
  transition: number;
}> {
  constructor() {
    super({ enabled: false, effect: "prism", strength: 1.55, duration: 400, transition: 200 });
  }
  getSnapshot = () => this.state;
  configure(patch: Partial<typeof this.state>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
  }
}
/** Session-only controls for the canvas overlap experiments. */
export const overlapLab = new OverlapLab();
