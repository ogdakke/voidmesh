import type { SVGProps } from "react";

// Knob icons for the mobile pickers. Drawn on iconoir's grammar (24 grid, 1.5 stroke, round
// caps/joins) so they sit next to iconoir glyphs; knobs that iconoir already covers import it
// directly instead of being redrawn here.

type IconProps = SVGProps<SVGSVGElement>;

function KnobSvg({ children, ...props }: IconProps) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function HalftoneIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <circle fill="currentColor" stroke="none" cx="6" cy="6" r="2.6" />
      <circle fill="currentColor" stroke="none" cx="12" cy="6" r="2.1" />
      <circle fill="currentColor" stroke="none" cx="18" cy="6" r="1.6" />
      <circle fill="currentColor" stroke="none" cx="6" cy="12" r="2.1" />
      <circle fill="currentColor" stroke="none" cx="12" cy="12" r="1.6" />
      <circle fill="currentColor" stroke="none" cx="18" cy="12" r="1.1" />
      <circle fill="currentColor" stroke="none" cx="6" cy="18" r="1.6" />
      <circle fill="currentColor" stroke="none" cx="12" cy="18" r="1.1" />
      <circle fill="currentColor" stroke="none" cx="18" cy="18" r="0.65" />
    </KnobSvg>
  );
}

export function BlobsIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <path d="M18.49 12.4C18.9 12.87 19.33 13.47 19.54 14.08C19.75 14.68 19.83 15.41 19.74 16.03C19.66 16.66 19.39 17.33 19.02 17.84C18.65 18.35 18.1 18.81 17.54 19.09C16.97 19.37 16.26 19.51 15.62 19.5C14.98 19.48 14.27 19.26 13.7 18.99C13.13 18.71 12.61 18.2 12.2 17.82C11.79 17.44 11.51 17.01 11.21 16.72C10.92 16.42 10.71 16.24 10.44 16.06C10.17 15.89 9.91 15.79 9.6 15.67C9.28 15.54 8.94 15.45 8.56 15.3C8.18 15.15 7.74 15 7.3 14.76C6.87 14.51 6.38 14.22 5.96 13.82C5.55 13.43 5.13 12.94 4.83 12.4C4.54 11.86 4.3 11.21 4.22 10.58C4.13 9.94 4.15 9.23 4.31 8.6C4.46 7.96 4.76 7.31 5.15 6.78C5.53 6.24 6.07 5.75 6.63 5.41C7.19 5.07 7.86 4.82 8.5 4.72C9.14 4.61 9.84 4.64 10.46 4.77C11.08 4.9 11.69 5.17 12.2 5.48C12.71 5.79 13.16 6.22 13.52 6.61C13.89 7.01 14.15 7.46 14.39 7.85C14.63 8.24 14.78 8.61 14.96 8.94C15.13 9.27 15.25 9.55 15.44 9.82C15.62 10.08 15.79 10.29 16.07 10.54C16.34 10.78 16.7 10.97 17.1 11.28C17.51 11.59 18.09 11.93 18.49 12.4Z" />
      <circle cx="19" cy="5" r="1.75" />
    </KnobSvg>
  );
}

export function MeltIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7.25a1.75 1.75 0 0 1-3.5 0V12a1.25 1.25 0 0 0-2.5 0v6.25a1.75 1.75 0 0 1-3.5 0V12a1.25 1.25 0 0 0-2.5 0v3a2 2 0 0 1-4 0V6Z" />
    </KnobSvg>
  );
}

export function DitheringIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect fill="currentColor" stroke="none" x="4.5" y="4.5" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="7" y="4.5" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="9.5" y="4.5" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="12" y="4.5" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="14.5" y="4.5" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="4.5" y="7" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="7" y="7" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="12" y="7" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="17" y="7" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="4.5" y="9.5" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="9.5" y="9.5" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="14.5" y="9.5" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="7" y="12" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="12" y="12" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="4.5" y="14.5" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="9.5" y="14.5" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="14.5" y="14.5" width="2.5" height="2.5" />
      <rect fill="currentColor" stroke="none" x="7" y="17" width="2.5" height="2.5" />
    </KnobSvg>
  );
}

export function AsciiIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <circle fill="currentColor" stroke="none" cx="6.5" cy="6.5" r="1.6" />
      <path d="M14.5 6.5h6M17.5 3.5v6" />
      <circle fill="currentColor" stroke="none" cx="6.5" cy="15" r="1.6" />
      <circle fill="currentColor" stroke="none" cx="6.5" cy="20" r="1.6" />
      <path d="M16.1 14.25v6.5M18.9 14.25v6.5M14.25 16.1h6.5M14.25 18.9h6.5" />
    </KnobSvg>
  );
}

export function GlassIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M7.5 11.5l4-4M7.5 16l8.5-8.5" />
    </KnobSvg>
  );
}

export function GlitchIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <path d="M3 5h10M7 9.67h14M3 14.33h7M9 19h9" />
      <rect fill="currentColor" stroke="none" x="17" y="3.5" width="3" height="3" rx=".75" />
      <rect fill="currentColor" stroke="none" x="13" y="12.83" width="3" height="3" rx=".75" />
    </KnobSvg>
  );
}

export function Bayer2x2Icon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <rect fill="currentColor" stroke="none" x="5.25" y="5.25" width="6.75" height="6.75" />
      <rect fill="currentColor" stroke="none" x="12" y="12" width="6.75" height="6.75" />
    </KnobSvg>
  );
}

export function Bayer4x4Icon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <rect fill="currentColor" stroke="none" x="5.25" y="5.25" width="3.38" height="3.38" />
      <rect fill="currentColor" stroke="none" x="5.25" y="12" width="3.38" height="3.38" />
      <rect fill="currentColor" stroke="none" x="8.63" y="8.63" width="3.38" height="3.38" />
      <rect fill="currentColor" stroke="none" x="8.63" y="15.38" width="3.38" height="3.38" />
      <rect fill="currentColor" stroke="none" x="12" y="5.25" width="3.38" height="3.38" />
      <rect fill="currentColor" stroke="none" x="12" y="12" width="3.38" height="3.38" />
      <rect fill="currentColor" stroke="none" x="15.38" y="8.63" width="3.38" height="3.38" />
      <rect fill="currentColor" stroke="none" x="15.38" y="15.38" width="3.38" height="3.38" />
    </KnobSvg>
  );
}

export function Bayer8x8Icon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <rect fill="currentColor" stroke="none" x="5.25" y="5.25" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="5.25" y="8.63" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="5.25" y="12" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="5.25" y="15.38" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="6.94" y="6.94" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="6.94" y="10.31" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="6.94" y="13.69" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="6.94" y="17.06" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="8.63" y="5.25" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="8.63" y="8.63" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="8.63" y="12" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="8.63" y="15.38" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="10.31" y="6.94" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="10.31" y="10.31" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="10.31" y="13.69" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="10.31" y="17.06" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="12" y="5.25" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="12" y="8.63" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="12" y="12" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="12" y="15.38" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="13.69" y="6.94" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="13.69" y="10.31" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="13.69" y="13.69" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="13.69" y="17.06" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="15.38" y="5.25" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="15.38" y="8.63" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="15.38" y="12" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="15.38" y="15.38" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="17.06" y="6.94" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="17.06" y="10.31" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="17.06" y="13.69" width="1.69" height="1.69" />
      <rect fill="currentColor" stroke="none" x="17.06" y="17.06" width="1.69" height="1.69" />
    </KnobSvg>
  );
}

export function WhiteNoiseIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle fill="currentColor" stroke="none" cx="7" cy="7" r="0.95" />
      <circle fill="currentColor" stroke="none" cx="8.5" cy="8.2" r="0.95" />
      <circle fill="currentColor" stroke="none" cx="13" cy="6.6" r="0.95" />
      <circle fill="currentColor" stroke="none" cx="17" cy="9" r="0.95" />
      <circle fill="currentColor" stroke="none" cx="6.6" cy="12.5" r="0.95" />
      <circle fill="currentColor" stroke="none" cx="11.2" cy="11.4" r="0.95" />
      <circle fill="currentColor" stroke="none" cx="12.6" cy="12.8" r="0.95" />
      <circle fill="currentColor" stroke="none" cx="16.4" cy="14.6" r="0.95" />
      <circle fill="currentColor" stroke="none" cx="7.8" cy="17" r="0.95" />
      <circle fill="currentColor" stroke="none" cx="11" cy="16.8" r="0.95" />
      <circle fill="currentColor" stroke="none" cx="16.6" cy="17.4" r="0.95" />
      <circle fill="currentColor" stroke="none" cx="17.5" cy="6.6" r="0.95" />
    </KnobSvg>
  );
}

export function BlueNoiseIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <rect x="8.50" y="6.00" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="13.50" y="6.00" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="8.50" y="8.50" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="6.00" y="11.00" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="11.00" y="11.00" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="16.00" y="11.00" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="6.00" y="13.50" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="13.50" y="13.50" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="8.50" y="16.00" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="13.50" y="16.00" width="2" height="2" fill="currentColor" stroke="none" />
    </KnobSvg>
  );
}

export function AsciiStandardIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <circle fill="currentColor" stroke="none" cx="7" cy="8.5" r="1.25" />
      <circle fill="currentColor" stroke="none" cx="7" cy="15.5" r="1.25" />
      <path d="M15.25 6v12M18.75 6v12M13 10h8M13 14h8" />
    </KnobSvg>
  );
}

export function AsciiExtendedIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <path d="M3.25 19 7 5l3.75 14M4.4 14.5h5.2" />
      <path d="M13.5 5h7l-7 14h7" />
    </KnobSvg>
  );
}

export function AsciiBinaryIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3.5" y="5" width="7" height="14" rx="3.5" />
      <path d="M14.5 7.5 17.5 5v14M14.5 19h6" />
    </KnobSvg>
  );
}

export function AsciiMinimalIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <path d="M3.5 12h7" />
      <path d="M13.25 12h7.5M17 8.25v7.5" />
    </KnobSvg>
  );
}

export function GlassFlutedIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M7.5 3.5v17M12 3.5v17M16.5 3.5v17" />
    </KnobSvg>
  );
}

export function GlassFrostedIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M3.5 10 9 9.5l2.5-6M9 9.5l2 5L3.5 16.5M11 14.5l5-1.5 4.5 1M16 13l-.5-9.5M11 14.5l1.5 6" />
    </KnobSvg>
  );
}

export function GlassFlowingIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <g transform="translate(12 12) scale(.72) translate(-12 -12)" strokeWidth="2.08">
        <path d="M3 9.5C7 8.5 9.5 10.5 12.5 8.25S17.5 4.5 21 3.75M3 15.5C7.5 15 10.5 15.5 13.75 12S18.5 7 21 6.5M7 21C11 20.25 14 18.5 16.25 14.75S19.5 10 21 9.5" />
      </g>
    </KnobSvg>
  );
}

export function GlitchChannelShiftIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3" y="5" width="12" height="12" rx="2.5" />
      <path d="M9 19h8.5a2.5 2.5 0 0 0 2.5-2.5V9.5A2.5 2.5 0 0 0 17.5 7H17" />
    </KnobSvg>
  );
}

export function GlitchScanlineIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M6.5 8h9M8.5 12h9M7 16h7" />
    </KnobSvg>
  );
}

export function GlitchBlockCorruptIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect fill="currentColor" stroke="none" x="15" y="15" width="6" height="6" rx="1.5" />
    </KnobSvg>
  );
}

export function GlitchPixelSmearIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3" y="6" width="8" height="12" rx="2" />
      <path d="M14 8.5h7M14 12h5M14 15.5h7" />
    </KnobSvg>
  );
}

export function ShapeCircleIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <circle cx="12" cy="12" r="8" />
    </KnobSvg>
  );
}

export function ShapeSquareIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="4.5" y="4.5" width="15" height="15" rx="2" />
    </KnobSvg>
  );
}

export function ShapeVerticalRectIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="8" y="3" width="8" height="18" rx="2" />
    </KnobSvg>
  );
}

export function SizeIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <circle cx="3.25" cy="13.5" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="12.5" r="2.25" />
      <circle cx="17.25" cy="11" r="4" />
    </KnobSvg>
  );
}

export function RefractionIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <path d="M3 11h18M17.5 3 14 11M10.5 11l-1.75 10" />
    </KnobSvg>
  );
}

export function EagernessIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <circle cx="15" cy="12" r="5.5" />
      <path d="M2.5 9h4M3.5 12h3.5M2.5 15h4" />
    </KnobSvg>
  );
}

export function AngleIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <path d="M4 20h16M4 20 15 6M10 20a6 6 0 0 0-2.2-4.65" />
    </KnobSvg>
  );
}

export function CausticIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <path d="M3 8.5c3 2 6-2 9 0s6 2 9 0M3 15.5c3-2 6 2 9 0s6-2 9 0M8.5 3c-2 3 2 6 0 9s-2 6 0 9M15.5 3c2 3-2 6 0 9s2 6 0 9" />
    </KnobSvg>
  );
}

export function DispersionIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <path d="M12 4.5 19 18H5Z" />
      <path d="M2.5 13.5 8.6 11M15.4 11.25 21.5 8M16.2 12.8l5.3-1M17 14.4 21.5 15.5" />
    </KnobSvg>
  );
}

export function ContrastIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path fill="currentColor" stroke="none" d="M12 3a9 9 0 0 1 0 18Z" />
    </KnobSvg>
  );
}

export function BlurIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <path d="M12 4a8 8 0 0 0 0 16" />
      <path d="M12 4a8 8 0 0 1 0 16" pathLength="8" strokeDasharray="0 1" />
      <circle cx="12" cy="12" r="3.5" />
    </KnobSvg>
  );
}

export function GrainSizeIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <circle fill="currentColor" stroke="none" cx="7" cy="8" r="2.25" />
      <circle fill="currentColor" stroke="none" cx="15.5" cy="6.5" r="1.5" />
      <circle fill="currentColor" stroke="none" cx="17" cy="15.5" r="2.75" />
      <circle fill="currentColor" stroke="none" cx="8.5" cy="16.5" r="1" />
      <circle fill="currentColor" stroke="none" cx="12.5" cy="11.5" r="0.9" />
      <circle fill="currentColor" stroke="none" cx="4.5" cy="13" r="0.75" />
    </KnobSvg>
  );
}

export function GrainIntensityIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle fill="currentColor" stroke="none" cx="6.5" cy="6.5" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="9.5" cy="7.8" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="12.8" cy="6.2" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="16" cy="7.4" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="17.6" cy="10.2" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="7.4" cy="10.4" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="11" cy="10.6" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="14.2" cy="9.6" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="6.2" cy="13.6" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="9.2" cy="13.2" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="12.6" cy="13.8" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="15.6" cy="13" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="17.6" cy="16.6" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="7.6" cy="17" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="10.6" cy="16.4" r="0.8" />
      <circle fill="currentColor" stroke="none" cx="14" cy="17.4" r="0.8" />
    </KnobSvg>
  );
}

export function BloomThresholdIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <path d="M3 18h18M7.5 18a4.5 4.5 0 0 1 9 0M12 6.5V9M5.5 9.5l1.75 1.75M18.5 9.5l-1.75 1.75" />
    </KnobSvg>
  );
}

export function BloomIntensityIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <circle fill="currentColor" stroke="none" cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="9.25" pathLength="20" strokeDasharray="0 1" />
    </KnobSvg>
  );
}

export function BloomSpreadIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 7.5V2.5m0 0L10 4.5m2-2 2 2M12 16.5v5m0 0-2-2m2 2 2-2M7.5 12h-5m0 0 2-2m-2 2 2 2M16.5 12h5m0 0-2-2m2 2-2 2" />
    </KnobSvg>
  );
}

export function BloomSoftnessIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="6.25" pathLength="9" strokeDasharray=".45 .55" />
      <circle cx="12" cy="12" r="9.5" pathLength="17" strokeDasharray="0 1" />
    </KnobSvg>
  );
}

export function ChromaticAberrationIcon(props: IconProps) {
  return (
    <KnobSvg {...props}>
      <circle cx="12" cy="12" r="6" />
      <path d="M9 6a6 6 0 0 0 0 12M15 6a6 6 0 0 1 0 12" />
    </KnobSvg>
  );
}
