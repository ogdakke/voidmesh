import { useKeybinds } from "#context/keybind-context.ts";
import clsx from "clsx";
import { Fragment, type ComponentProps, type PropsWithChildren } from "react";

export interface KeybindProps extends ComponentProps<"div"> {
  keybindId: string;
  /** @default "" */
  separator?: string;
}

export function Keybind({ keybindId, separator, ...props }: PropsWithChildren<KeybindProps>) {
  const keybinds = useKeybinds();

  const bind = keybinds.getById(keybindId);
  if (!bind) return null;
  return (
    <div {...props} className={clsx("kbd-shortcut", props.className)}>
      <RenderKeybind symbols={bind.bind.toSymbols()} separator={separator} />
    </div>
  );
}

interface RenderKeybindProps {
  separator?: string;
  symbols: string[];
}

export function RenderKeybind({ symbols, separator }: PropsWithChildren<RenderKeybindProps>) {
  return symbols.map((b, i) => (
    <Fragment key={i}>
      {separator && i > 0 ? separator : ""}
      <kbd className="kbd">{b}</kbd>
    </Fragment>
  ));
}
