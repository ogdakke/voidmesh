import { useKeybindEntries, type Keybind as KeybindType } from "#context/keybind-context.ts";
import { type ComponentProps } from "react";

import "./keyboard-shortcuts.css";
import { RenderKeybind } from "./keybind";

const GROUP_CONFIG = [
  { id: "global", label: "Global" },
  { id: "canvas", label: "Canvas" },
  { id: "selection", label: "Selection" },
  { id: "video", label: "Video Playback" },
] as const;

export function KeyboardShortcuts(props: ComponentProps<"div">) {
  const groupedKeybinds = useKeybindEntries();

  return (
    <div {...props} className="keyboard-shortcuts__keybinds fade-mask-y">
      {GROUP_CONFIG.map(({ id, label }) => {
        const groupKeybinds = groupedKeybinds.get(id);
        if (!groupKeybinds?.length) return null;
        return <KeybindGroup key={id} keybinds={groupKeybinds} title={label} />;
      })}
    </div>
  );
}

interface KeybindGroupProps {
  title: string;
  keybinds: KeybindType[];
}

function KeybindGroup({ title, keybinds }: KeybindGroupProps) {
  return (
    <section className="keybind-section">
      <h2>{title}</h2>
      <dl className="keybind-group">
        {keybinds.map((kb) => (
          <KeybindItem key={kb.label} keybind={kb} />
        ))}
      </dl>
    </section>
  );
}

interface KeybindItemProps {
  keybind: KeybindType;
}

function KeybindItem({ keybind }: KeybindItemProps) {
  return (
    <div className="keybind-item">
      <dt>{keybind.label}</dt>
      {keybind.description && <p>{keybind.description}</p>}
      {keybind.bind && (
        <dd className="kbd-shortcut">
          <RenderKeybind symbols={keybind.bind.toSymbols()} />
        </dd>
      )}
    </div>
  );
}
