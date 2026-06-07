import { renderToString } from "react-dom/server";
import { StaticStudioShell } from "#components/static-studio-shell/static-studio-shell.tsx";

export function render() {
  return renderToString(<StaticStudioShell />);
}
