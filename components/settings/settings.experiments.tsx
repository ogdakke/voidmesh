import { toastManager } from "#application/notifications.ts";
import { EXPERIMENT_FLAGS } from "#lib/high-refresh.ts";
import { copyHudReport } from "#lib/high-refresh-hud.ts";
import { Checkbox } from "#ui/checkbox/index.tsx";
import "#components/ui/field/field.css";

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
      {EXPERIMENT_FLAGS.map((flag) => (
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
