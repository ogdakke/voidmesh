import type { SVGProps } from "react";

export function IonInvertMode(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1em"
      height="1em"
      viewBox="0 0 512 512"
      {...props}
    >
      {/* Icon from IonIcons by Ben Sperry - https://github.com/ionic-team/ionicons/blob/main/LICENSE */}
      <circle
        cx="256"
        cy="256"
        r="208"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth="32"
      />
      <path
        fill="currentColor"
        d="M256 176v160a80 80 0 0 0 0-160m0-128v128a80 80 0 0 0 0 160v128c-114.88 0-208-93.12-208-208S141.12 48 256 48"
      />
    </svg>
  );
}
