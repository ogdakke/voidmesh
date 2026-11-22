import { toastManager } from "#application/notifications.ts";
import { copyHudReport } from "#lib/high-refresh-hud.ts";
import { Checkbox } from "#ui/checkbox/index.tsx";
import "#components/ui/field/field.css";

interface ExperimentFlag {
  param: string;
  label: string;
}

// Add a flag here and read the same query param where it takes effect.
const FLAGS: ExperimentFlag[] = [
  { param: "hz120", label: "120 Hz mode" },
  { param: "nowlur", label: "Skip glass blur" },
  { param: "nop3", label: "8-bit sRGB canvas" },
  { param: "noscroller", label: "Skip touch scroller" },
  { param: "mainclock", label: "Main-thread clock" },
  { param: "nobackdrop", label: "No backdrop blur" },
  { param: "nochrome", label: "Hide all UI (edit URL to undo)" },
  { param: "opaque", label: "Opaque canvas" },
  { param: "minusage", label: "Minimal canvas usage" },
];

// Flags are read once at module load across the app, so changing one reloads.
function setFlag(param: string, enabled: boolean): void {
  const url = new URL(window.location.href);
  if (enabled) url.searchParams.set(param, "");
  else url.searchParams.delete(param);
  // Keeps the #settings hash, so the drawer is still open after the reload.
  window.location.replace(url);
}

export function ExperimentFlagToggles({ rowClassName }: { rowClassName: string }) {
  const params = new URLSearchParams(window.location.search);
  return (
    <>
      {FLAGS.map((flag) => (
        <div key={flag.param} className={rowClassName}>
          <Checkbox
            name={`experiment_${flag.param}`}
            checked={params.has(flag.param)}
            onChange={(event) => setFlag(flag.param, event.target.checked)}
            switch
          >
            {flag.label}
          </Checkbox>
        </div>
      ))}
    </>
  );
}

export function CopyReadingsButton() {
  const copy = async () => {
    if (await copyHudReport()) toastManager.add({ title: "Readings copied" });
    else toastManager.add({ title: "Copy failed", description: "Clipboard access was denied" });
  };
  return (
    <button type="button" onClick={copy}>
      <span>Copy readings</span>
    </button>
  );
}
