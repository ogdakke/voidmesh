import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import clsx from "clsx";
import "./collapsible.css";
import { Checkbox, type CheckboxProps } from "../checkbox";
import type { ComponentProps, PropsWithChildren } from "react";

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      {...props}
      className={clsx("collapsible", props.className)}
    />
  );
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      {...props}
      className={clsx("collapsible-trigger", props.className)}
    />
  );
}

function CollapsibleContent({ ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      {...props}
      className={clsx("collapsible-panel", props.className)}
    />
  );
}

function CollapsibleCheckbox({ ...props }: CheckboxProps) {
  return <Checkbox {...props} className={clsx("collapsible-checkbox", props.className)} />;
}

interface CollapsibleTriggerWithEnabledProps extends ComponentProps<"div"> {}

function CollapsibleGroup({
  children,
  ...props
}: PropsWithChildren<CollapsibleTriggerWithEnabledProps>) {
  return (
    <div {...props} className={clsx("collapsible-trigger-with-enabled", props.className)}>
      {children}
    </div>
  );
}

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  CollapsibleGroup,
  CollapsibleCheckbox,
};
