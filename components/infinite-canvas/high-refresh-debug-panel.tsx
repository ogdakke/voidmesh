import { getHudText } from "#lib/high-refresh-hud.ts";
import { useState } from "react";
import "./high-refresh-debug-panel.css";

interface DebugFlag {
  param: string;
  label: string;
  hint: string;
}

// Add a flag here and read the same query param where it takes effect.
const FLAGS: DebugFlag[] = [
  {
    param: "hz120",
    label: "120 Hz mode",
    hint: "Offscreen canvases, worker clock, touch scroller",
  },
  { param: "nowlur", label: "Skip glass blur", hint: "Measure the full-screen blur's GPU cost" },
];

function readFlags(): Set<string> {
  const params = new URLSearchParams(window.location.search);
  return new Set(FLAGS.filter((flag) => params.has(flag.param)).map((flag) => flag.param));
}

// Flags are read once at module load across the app, so applying one reloads.
function applyFlags(enabled: Set<string>): void {
  const url = new URL(window.location.href);
  for (const flag of FLAGS) {
    if (enabled.has(flag.param)) url.searchParams.set(flag.param, "");
    else url.searchParams.delete(flag.param);
  }
  window.location.assign(url);
}

function buildReport(enabled: Set<string>): string {
  const flags = enabled.size > 0 ? [...enabled].join(", ") : "none";
  return [
    `flags: ${flags}`,
    `dpr: ${window.devicePixelRatio}  viewport: ${window.innerWidth}x${window.innerHeight}`,
    `ua: ${navigator.userAgent}`,
    getHudText() ?? "readout: off (enable 120 Hz mode)",
  ].join("\n");
}

/** Dev-only sheet for toggling the ?hz120 experiment flags on a phone. */
export function HighRefreshDebugPanel() {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const enabled = readFlags();

  const copyReadings = async () => {
    try {
      await navigator.clipboard.writeText(buildReport(enabled));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 1500);
  };

  const toggle = (param: string) => {
    const next = new Set(enabled);
    if (next.has(param)) next.delete(param);
    else next.add(param);
    applyFlags(next);
  };

  return (
    <>
      <button
        type="button"
        className="hz-debug__chip"
        data-active={enabled.size > 0 || undefined}
        aria-expanded={open}
        aria-controls="hz-debug-sheet"
        aria-label="Experiment flags"
        onClick={() => setOpen((value) => !value)}
      >
        Hz
      </button>
      <button
        type="button"
        className="hz-debug__chip hz-debug__chip--copy"
        data-state={copyState}
        aria-label="Copy readings"
        onClick={copyReadings}
      >
        {copyState === "copied" ? "Copied" : copyState === "failed" ? "Failed" : "Copy"}
      </button>
      {open ? (
        <section id="hz-debug-sheet" className="hz-debug__sheet" aria-label="Experiment flags">
          <header className="hz-debug__header">
            <h2 className="hz-debug__title">Experiment flags</h2>
            <button type="button" className="hz-debug__close" onClick={() => setOpen(false)}>
              Done
            </button>
          </header>
          <ul className="hz-debug__list">
            {FLAGS.map((flag) => (
              <li key={flag.param}>
                <button
                  type="button"
                  role="switch"
                  aria-label={flag.label}
                  aria-checked={enabled.has(flag.param)}
                  className="hz-debug__row"
                  onClick={() => toggle(flag.param)}
                >
                  <span className="hz-debug__text">
                    <span className="hz-debug__label">{flag.label}</span>
                    <span className="hz-debug__hint">{flag.hint}</span>
                  </span>
                  <span className="hz-debug__switch" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <p className="hz-debug__note">Changing a flag reloads the page.</p>
        </section>
      ) : null}
    </>
  );
}
