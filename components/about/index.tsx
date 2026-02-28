import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { lazy, Suspense, type ComponentProps } from "react";

const DesktopAbout = lazy(() => import("./desktop-about.tsx"));
const MobileAbout = lazy(() => import("./mobile-about.tsx"));

export interface AboutProps extends ComponentProps<"div"> {}
export default function About(props: AboutProps) {
  const isMobile = useIsMobile();
  return <Suspense>{isMobile ? <MobileAbout {...props} /> : <DesktopAbout {...props} />}</Suspense>;
}
