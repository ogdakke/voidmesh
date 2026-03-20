import { Image } from "#ui/image.tsx";
import { Video } from "#ui/video.tsx";
import type { PropsWithChildren } from "react";
import saveFeature from "#media/save_feature_img.webp?img";
import p3Feature from "#media/feature_color_picker_with_space_select.jpg?img";
import flowingExample from "#media/flowing_example_updates.webp?img";
import { InfoCircle, MoreVert } from "iconoir-react";
import { fileHandleStore } from "#lib/files/file-handle.ts";
import { Keybind } from "#components/keyboard-shortcuts/keybind.tsx";
import { useIsMobile } from "#hooks/use-is-mobile.ts";

function formatDate(isoDate: string): string {
  return Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(isoDate));
}

function PreferencesMenu() {
  return (
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
  );
}

export function Updates({ id }: { id?: string }) {
  const isMobile = useIsMobile();
  return (
    <section id={id}>
      <h1>Updates</h1>
      <Update>
        <UpdatesTitle date="2026-03-20">Better saving</UpdatesTitle>
        <p>
          Saving just got a lot smoother. Use <strong>Save</strong> to write directly to your file
          without being asked where to save every time.{" "}
          {!isMobile && (
            <>
              Use <strong>Save as...</strong> when you want to pick a new location.
            </>
          )}
        </p>
        <ul>
          {isMobile ? (
            <li>
              Open preferences <PreferencesMenu />, tap <strong>Open workspace</strong> and choose
              file.
            </li>
          ) : (
            <>
              <li>
                <Keybind keybindId="save_studio" style={{ display: "inline-flex" }} /> saves
                instantly to the same file
              </li>
              <li>
                <Keybind keybindId="save_as_studio" style={{ display: "inline-flex" }} /> lets you
                pick a new file name or location
              </li>
            </>
          )}
          <li>
            Opening a workspace also remembers the file, so your next save goes right back to it
          </li>
          <li>
            You can for example store workspace files in cloud storage of your choice, and sync your
            workspaces to many devices
          </li>
        </ul>
        {!fileHandleStore.supportsFileSystemAccess && (
          <Note>
            <InfoCircle />
            Your browser doesn't support saving directly to files. For the best experience, use
            Chrome, Edge or other Chromium-based browsers. You are still able to save your
            workspace, but it will download a new file every time.
          </Note>
        )}
      </Update>
      <Update>
        <UpdatesTitle date="2026-03-08">Upscaling</UpdatesTitle>
        <p>
          Upscale images and videos, fully locally. Find the upscale button in the context menu, and
          give it a go!
        </p>
      </Update>
      <Update>
        <UpdatesTitle date="2026-03-07">Mobile context menu</UpdatesTitle>
        <p>Now you can do more actions that were already available on desktop on mobile as well!</p>
        <figure>
          <Video
            className="video"
            src={[
              { src: "/m/feature_context_menu_av1_qp50.mp4", codec: "av1" },
              { src: "/m/feature_context_menu_compressed.mp4", codec: "h264" },
            ]}
            placeholder="y/cJDQIHiZV5B7inZoWYl/qXiW+4"
            muted
            autoPlay
            loop
            playsInline
            style={{ aspectRatio: "3/4" }}
          />
          <figcaption>
            Duplicate, copy/paste effects, and save are now available on long press
          </figcaption>
        </figure>
      </Update>
      <Update>
        <UpdatesTitle date="2026-03-04">P3 Color Space</UpdatesTitle>
        <p>
          Display P3 is now the default color space on supported browsers and displays. This means
          colors will look more vibrant and accurate, if your hardware supports it.
        </p>
        <figure>
          <Image
            {...p3Feature}
            className="fullsize"
            alt="New color picker supporting display P3 color space"
          />
          <figcaption>
            In the new color picker, you can see the SRGB color space outlined, and outside it, the
            wider range of colors.
          </figcaption>
        </figure>
        <br />
        <p>Some other notable changes:</p>
        <ul>
          <li>
            <strong>First color in the palette is always treated</strong> as the background
          </li>
          <li>You can also change the color format to hex</li>
          <li>Transparency is now supported for palette colors</li>
        </ul>
      </Update>
      <Update>
        <UpdatesTitle date="2026-02-28">Fancy deletions</UpdatesTitle>
        <p>Try deleting something from the canvas, added something a little extra 🫰</p>
        <figure>
          <Video
            className="video"
            src={[
              {
                src: "/m/fancy_delete_with_context_menu_mobile_av1_qp50.mp4",
                codec: "av1",
              },
              {
                src: "/m/fancy_delete_with_context_menu_mobile_compressed.mp4",
                codec: "h264",
              },
            ]}
            placeholder="yfcFBwAJeHeNdXlxeapXx1d0ByoElWAI"
            muted
            autoPlay
            loop
            playsInline
            style={{ aspectRatio: "1" }}
          />
          <figcaption>
            You can turn this effect off from the preferences menu (
            <PreferencesMenu />)
          </figcaption>
        </figure>
      </Update>
      <Update>
        <UpdatesTitle date="2026-02-18">Saving is available!</UpdatesTitle>
        <p>
          Save your canvas and all media in it to a file for easily continuing editing your files.
        </p>
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
      </Update>
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

function Note({ children }: PropsWithChildren) {
  return <p className="update-note">{children}</p>;
}
