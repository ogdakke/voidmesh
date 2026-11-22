import { toastManager } from "#application/notifications.ts";
import { getHudReport } from "#lib/high-refresh-hud.ts";
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
];

// Flags are read once at module load across the app, so changing one reloads.
function setFlag(param: string, enabled: boolean): void {
  const url = new URL(window.location.href);
  if (enabled) url.searchParams.set(param, "");
  else url.searchParams.delete(param);
  window.location.assign(url);
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

function buildReport(): string {
  const params = new URLSearchParams(window.location.search);
  const flags = FLAGS.filter((flag) => params.has(flag.param)).map((flag) => flag.param);
  return [
    `flags: ${flags.length > 0 ? flags.join(", ") : "none"}`,
    `dpr: ${window.devicePixelRatio}  viewport: ${window.innerWidth}x${window.innerHeight}`,
    `ua: ${navigator.userAgent}`,
    getHudReport() ?? "readout: off (enable 120 Hz mode)",
  ].join("\n");
}

export function CopyReadingsButton() {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildReport());
      toastManager.add({ title: "Readings copied" });
    } catch {
      toastManager.add({ title: "Copy failed", description: "Clipboard access was denied" });
    }
  };
  return (
    <button type="button" onClick={copy}>
      <span>Copy readings</span>
    </button>
  );
}
