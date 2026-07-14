import { Image } from "#ui/image.tsx";
import beanie from "#media/guy_with_beanie_and_glasses_ascii_winter.webp?img";
import bustedBust from "#media/busted_bust_dithered.webp?img";
import darkHand from "#media/dithered-dark-hand.webp?img";
import footballPlayer from "#media/halftone-football-player.webp?img";
import personSitting from "#media/halftone-person-sitting.webp?img";
import halftoneDude from "#media/halftone-dude.webp?img";
import halftoneHead from "#media/halftone-1jdnpq5qg.webp?img";
import { Hint } from "#ui/hint/hint.tsx";

export const SidebarLeft = () => {
  return (
    <div className="app-sidebar sidebar--left">
      <div className="sidebar-row sidebar-header">
        <h1 className="studio-heading">Voidmesh</h1>
      </div>
      <div className="sidebar-row">
        <p className="sidebar-text">
          Edit the look of your images and videos with different effects. All local, nothing gets
          uploaded.
        </p>
      </div>
      <div className="sidebar-row renders-container">
        <app-gallery className="render-examples">
          <app-lightbox src={beanie.src}>
            <Image
              {...beanie}
              className="render-example-img"
              alt="A man wearing a white beanie and sports sungrlassesglasses in wintery colors"
            />
          </app-lightbox>
          <app-lightbox src={bustedBust.src}>
            <Image
              {...bustedBust}
              className="render-example-img"
              alt="A nearly broken bust of a man. Dithered, grainy."
            />
          </app-lightbox>
          <app-lightbox src={darkHand.src}>
            <Image {...darkHand} className="render-example-img" alt="halftone hand reaching up" />
          </app-lightbox>
          <app-lightbox src={footballPlayer.src}>
            <Image
              {...footballPlayer}
              className="render-example-img"
              alt="Halftone edit of a football player kicking"
            />
          </app-lightbox>
          <app-lightbox src={personSitting.src}>
            <Image
              {...personSitting}
              className="render-example-img"
              alt="Halftone edit of a blurred out person sitting cross-legged. Original artwork is called '[354471]' by POLYGON1993"
            />
          </app-lightbox>
          <app-lightbox src={halftoneDude.src}>
            <Image
              {...halftoneDude}
              className="render-example-img"
              alt="Halftone edit of a blurred out bust of a person. Blue on a white background."
            />
          </app-lightbox>
          <app-lightbox src={halftoneHead.src}>
            <Image
              {...halftoneHead}
              className="render-example-img"
              alt="Halftone edit of a blurred out persons head. Original artwork from https://www.cosmos.so/e/1571303914"
            />
          </app-lightbox>
        </app-gallery>
      </div>
      <div className="sidebar-row">
        <Hint />
      </div>
      <div className="sidebar-row sidebar-text">
        <p>
          Made by{" "}
          <a href="https://danielwargh.com" target="_blank" rel="noopener noreferrer">
            Daniel Wargh
          </a>
        </p>
      </div>
    </div>
  );
};
