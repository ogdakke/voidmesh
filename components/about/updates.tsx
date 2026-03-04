import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { Image } from "#ui/image.tsx";
import { Video } from "#ui/video.tsx";
import type { PropsWithChildren } from "react";
import saveFeature from "#media/save_feature_img.webp?img";
import p3Feature from "#media/feature_p3_color_picker.jpg?img";
import flowingExample from "#media/flowing_example_updates.webp?img";
import { MoreVert } from "iconoir-react";

function formatDate(isoDate: string): string {
  return Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(isoDate));
}

export function Updates() {
  const isMobile = useIsMobile();
  return (
    <section>
      <h1>Updates</h1>
      <Update>
        <UpdatesTitle date="2026-03-04">P3 Color Space</UpdatesTitle>
        <p>
          Display P3 is now the default color space on supported browsers and displays. This means
          colors will look more vibrant and accurate, if your hardware supports it.
        </p>
        {isMobile ? (
          <>
            <figure>
              <Image
                {...p3Feature}
                className="fullsize"
                alt="New color picker supporting display P3 color space"
              />
              <figcaption>
                In the new color picker, you can see the SRGB color space outlined, and outside it,
                the wider range of colors.
              </figcaption>
            </figure>
          </>
        ) : null}
        <br />
        <p>Some other notable changes:</p>
        <ul>
          <li>
            <strong>first color is always treated</strong> as the background
          </li>
          <li>
            You can also use hex colors in the input, so it's easier to paste colors from elsewhere
          </li>
          <li>Transparency is now supported for palette colors</li>
        </ul>
      </Update>
      <Update>
        <UpdatesTitle date="2026-02-28">Fancy deletions</UpdatesTitle>
        <p>Try deleting something from the canvas, added something a little extra 🫰</p>
        {isMobile ? (
          <>
            <figure>
              <Video
                className="video"
                src={[
                  {
                    src: "/m/fancy_delete_update_1_av1_qp50.mp4",
                    codec: "av1",
                  },
                  {
                    src: "/m/fancy_delete_update_1_compressed.mp4",
                    codec: "h264",
                  },
                ]}
                placeholder="w/cBBwAGikV/qGNVqJZlSZdpll/J+YkJ"
                muted
                autoPlay
                loop
                playsInline
                style={{ aspectRatio: "1" }}
              />
              <figcaption>
                You can turn this effect off from the preferences menu (
                <MoreVert
                  role="presentation"
                  style={{
                    display: "inline-block",
                    background: "light-dark(var(--gray-100), var(--gray-50))",
                    borderRadius: "99px",
                    width: "1.5em",
                    height: "1.5em",
                    marginInline: "4px",
                    padding: "2px",
                    verticalAlign: "top",
                  }}
                />
                )
              </figcaption>
            </figure>
          </>
        ) : null}
      </Update>
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
