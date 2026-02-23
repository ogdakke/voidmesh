import { Button } from "../button/index.tsx";
import { Xmark } from "iconoir-react";
import type { ComponentProps } from "react";
import { hints, useHint } from "./hint-manager.ts";
import "./hint.css";
import clsx from "clsx";

export type { HintContent, HintOptions } from "./hint-manager.ts";

// Hint component
export interface HintProps extends ComponentProps<"div"> {}

export function Hint(props: HintProps) {
  const { content, key } = useHint();

  const handleActionPress = () => {
    content?.action?.onPress();
  };

  if (!content) return null;

  return (
    <div
      {...props}
      className={clsx("hint", props.className)}
      role="status"
      aria-live="polite"
      style={{ viewTransitionName: key }}
      data-hint-key={key}
    >
      <span className="hint__title">{content.title}</span>
      {content.description && <span className="hint__description">{content.description}</span>}
      {content.action && (
        <Button className="hint__action" onClick={handleActionPress} variant="quiet">
          {content.action.label}
        </Button>
      )}
      <Button
        className="hint__close"
        aria-label="Dismiss hint"
        onClick={() => hints.dismiss()}
        variant="quiet"
      >
        <Xmark width={16} height={16} />
      </Button>
    </div>
  );
}
