import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { type ComponentProps } from "react";
import DesktopAbout from "./desktop-about.tsx";
import MobileAbout from "./mobile-about.tsx";

export interface AboutProps extends ComponentProps<"div"> {}
export default function About(props: AboutProps) {
  const isMobile = useIsMobile();
  return isMobile ? <MobileAbout {...props} /> : <DesktopAbout {...props} />;
}
