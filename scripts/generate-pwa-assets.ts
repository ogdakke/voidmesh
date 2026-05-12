import { generateImages } from "pwa-asset-generator";

await generateImages(`public/favicon.png`, `public/assets`, {
  background: "#000",
  index: "index.html",
  padding: "30%",
  portraitOnly: true,
  splashOnly: true,
  pathOverride: "/assets",
});
