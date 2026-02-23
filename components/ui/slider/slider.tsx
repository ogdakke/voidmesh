import { Field } from "@base-ui/react";
import { Slider as BaseSlider, type SliderRootProps } from "@base-ui/react/slider";
import "./slider.css";

export interface SliderProps extends SliderRootProps<number> {
  name: string;
  showValue?: boolean;
  label?: string;
  thumbLabels?: string[];
}

export function Slider({ name, label, showValue, thumbLabels, ...props }: SliderProps) {
  return (
    <Field.Root name={name} className={"slider-field"}>
      <Field.Label className="field-label">{label}</Field.Label>
      <BaseSlider.Root {...props} className={"slider-root"}>
        <BaseSlider.Control className={"slider-control"}>
          <BaseSlider.Track className={"slider-track"}>
            <BaseSlider.Indicator className={"slider-indicator"} />
            {thumbLabels?.length && thumbLabels.length > 1 ? (
              thumbLabels?.map((label, index) => (
                <BaseSlider.Thumb aria-label={label} className={"slider-thumb"} key={index} />
              ))
            ) : (
              <BaseSlider.Thumb className={"slider-thumb"} />
            )}
            {showValue && <BaseSlider.Value className={"field-label slider-value"} />}
          </BaseSlider.Track>
        </BaseSlider.Control>
      </BaseSlider.Root>
    </Field.Root>
  );
}
