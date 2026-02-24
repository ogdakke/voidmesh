import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { Image } from "#ui/image.tsx";
import type { PropsWithChildren } from "react";
import saveFeature from "../../media/save_feature_img.webp?img";
import flowingExample from "../../media/flowing_example_updates.webp?img";

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
              <Image
                {...saveFeature}
                className="fullsize"
                alt="Where to find the preferences menu on mobile"
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
          <Image
            {...flowingExample}
            className="fullsize"
            alt="Where to find the preferences menu on mobile"
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
