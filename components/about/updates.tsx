import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { UnLazyImage } from "@unlazy/react";
import type { PropsWithChildren } from "react";

function formatDate(isoDate: string): string {
  return Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(isoDate));
}

export function Updates() {
  const isMobile = useIsMobile();
  return (
    <section>
      <h1>Updates</h1>
      <Update>
        <UpdatesTitle date="2026-02-18">Saving is available!</UpdatesTitle>
        <p>
          Save your canvas and all media in it to a file for easily continuing editing your files.
        </p>
        {isMobile ? (
          <>
            <figure>
              <UnLazyImage
                className="fullsize"
                src="/media/save_feature_img.webp"
                alt="Where to find the preferences menu on mobile"
                thumbhash="wvcBC4LbjJu_vbiqAAIFEEE"
                width={2356}
                height={1156}
              />
              <figcaption>
                You can export and import the ".vdmsh" file from the preferences menu
              </figcaption>
            </figure>
          </>
        ) : null}
      </Update>
      <hr className="divider" />
      <Update>
        <UpdatesTitle date="2026-02-16">Flowing Glass Shader</UpdatesTitle>
        <p>
          A new, still experimental style is out! This one is an animated, constantly morphing and
          evolving style, emulating a flowing glass material with some turbulence.
        </p>
        <figure>
          <UnLazyImage
            className="fullsize"
            srcSet="/media/flowing_example_updates-768w.webp 768w, /media/flowing_example_updates-1152w.webp 1152w, /media/flowing_example_updates.webp"
            alt="Where to find the preferences menu on mobile"
            thumbhash="oucNBgK_ZWeGd6dol3iGaIh4j4H0FWg"
            width={1080}
            height={1350}
          />
          <figcaption>Images don't do it justice, so give it a go yourself</figcaption>
        </figure>
      </Update>
    </section>
  );
}

function Update({ children }: PropsWithChildren) {
  return <section className="update">{children}</section>;
}

interface UpdatesTitleProps {
  date: `${number}-${number}-${number}`;
}

function UpdatesTitle({ children, date }: PropsWithChildren<UpdatesTitleProps>) {
  return (
    <div className="updates-title">
      <h3>{children}</h3>
      <span className="date">{formatDate(date)}</span>
    </div>
  );
}
