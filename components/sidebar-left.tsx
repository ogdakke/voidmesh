import { ArrowLeft } from "iconoir-react";
import { useEffect } from "react";
import { lazyLoad } from "unlazy";

export const SidebarLeft = () => {
  useEffect(() => {
    lazyLoad();
  }, []);

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
          <app-lightbox src="/media/guy_with_beanie_and_glasses_ascii_winter.webp">
            <img
              className="render-example-img"
              data-src="/media/guy_with_beanie_and_glasses_ascii_winter-768w.webp"
              alt="A man wearing a white beanie and sports sungrlassesglasses in wintery colors"
              data-thumbhash="leYJBgCfZVd2iKd5mGd3Z4hpfUBjABY"
              width="768"
              height="960"
              loading="lazy"
            />
          </app-lightbox>
          <app-lightbox src="/media/busted_bust_dithered.webp">
            <img
              className="render-example-img"
              data-src="/media/busted_bust_dithered-768w.webp"
              alt="A nearly broken bust of a man. Dithered, grainy."
              data-thumbhash="FPgRDQAGmYZoOJmXaHpnZwaFc6-2"
              width="768"
              height="1016"
              loading="lazy"
            />
          </app-lightbox>
          <app-lightbox src="/media/dithered-dark-hand.webp">
            <img
              className="render-example-img"
              data-src="/media/dithered-dark-hand-768w.webp"
              alt="halftone hand reaching up"
              data-thumbhash="CggOBQBqiGCIyHhoeHeIiGpgrAbG"
              width="500"
              height="726"
              loading="lazy"
            />
          </app-lightbox>
          <app-lightbox src="/media/halftone-football-player.webp">
            <img
              className="render-example-img"
              data-src="/media/halftone-football-player-768w.webp"
              alt="Halftone edit of a football player kicking"
              data-thumbhash="vOcFHgT4NVqoZrlXmXuFiYZ3-IWLX7g"
              width="768"
              height="960"
              loading="lazy"
            />
          </app-lightbox>
          <app-lightbox src="/media/halftone-person-sitting.webp">
            <img
              className="render-example-img"
              data-src="/media/halftone-person-sitting-768w.webp"
              alt="Halftone edit of a blurred out person sitting cross-legged. Original artwork is called '[354471]' by POLYGON1993"
              data-thumbhash="ROcFDgIIKDeIp4hop3aIhXmY-H2G31c"
              width="768"
              height="960"
              loading="lazy"
            />
          </app-lightbox>
          <app-lightbox src="/media/halftone-dude.webp">
            <img
              className="render-example-img"
              data-src="/media/halftone-dude-768w.webp"
              alt="Halftone edit of a blurred out bust of a person. Blue on a white background."
              data-thumbhash="c7YNRg65hfl4d0h3iXqIeHaHuY-U-0g"
              width="768"
              height="959"
              loading="lazy"
            />
          </app-lightbox>
          <app-lightbox src="/media/halftone-1jdnpq5qg.webp">
            <img
              className="render-example-img"
              data-src="/media/halftone-1jdnpq5qg-768w.webp"
              alt="Halftone edit of a blurred out persons head. Original artwork from https://www.cosmos.so/e/1571303914"
              data-thumbhash="hSgCDQIIZ3ppZ4dIaHhpaAiKlpBo"
              width="768"
              height="1090"
              loading="lazy"
            />
          </app-lightbox>
        </app-gallery>
      </div>
    </div>
  );
};
