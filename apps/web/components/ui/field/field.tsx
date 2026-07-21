import { Field as BaseField } from "@base-ui/react/field";
import clsx from "clsx";
import type { ComponentProps } from "react";
import "./field.css";

// oxlint-disable react/only-export-components -- compound component: sub-components are exported via the Field object

function FieldRoot({ className, ...props }: ComponentProps<typeof BaseField.Root>) {
  return <BaseField.Root {...props} className={clsx("ui-field", className)} />;
}

function FieldLabel({ className, ...props }: ComponentProps<typeof BaseField.Label>) {
  return <BaseField.Label {...props} className={clsx("ui-field-label", className)} />;
}

function FieldControl({ className, ...props }: ComponentProps<typeof BaseField.Control>) {
  return <BaseField.Control {...props} className={clsx("ui-field-control", className)} />;
}

function FieldDescription({ className, ...props }: ComponentProps<typeof BaseField.Description>) {
  return <BaseField.Description {...props} className={clsx("ui-field-description", className)} />;
}

function FieldError({ className, ...props }: ComponentProps<typeof BaseField.Error>) {
  return <BaseField.Error {...props} className={clsx("ui-field-error", className)} />;
}

export const Field = {
  Root: FieldRoot,
  Label: FieldLabel,
  Control: FieldControl,
  Description: FieldDescription,
  Error: FieldError,
};
