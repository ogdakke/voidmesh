import { useSyncExternalStore } from "react";
import { overlapLab } from "#lib/overlap-lab.ts";
import { Checkbox } from "#ui/checkbox/index.tsx";

export function OverlapLabToggle() {
  const { enabled } = useSyncExternalStore(overlapLab.subscribe, overlapLab.getSnapshot);
  return (
    <Checkbox
      name="overlap_lab"
      checked={enabled}
      switch
      onChange={(event) => overlapLab.configure({ enabled: event.target.checked })}
    >
      Overlap lab
    </Checkbox>
  );
}
