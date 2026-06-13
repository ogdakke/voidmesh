import { expect, test } from "@playwright/test";

const visualCases = [
  "halftone",
  "blobs",
  "melt",
  "dithering-bayer2x2",
  "dithering-bayer4x4",
  "dithering-bayer8x8",
  "dithering-whiteNoise",
  "dithering-blueNoise",
  "dithering-floydSteinberg",
  "dithering-atkinson",
  "dithering-jarvisJudiceNinke",
  "dithering-stucki",
  "dithering-burkes",
  "dithering-sierra",
  "dithering-sierraLite",
  "ascii-standard",
  "ascii-extended",
  "ascii-binary",
  "ascii-minimal",
  "glass-fluted",
  "glass-frostedVoronoi",
  "glass-flowing",
  "glitch-channelShift",
  "glitch-scanline",
  "glitch-blockCorrupt",
  "glitch-pixelSmear",
] as const;

test.beforeEach(async ({ page }) => {
  await page.goto("/__tests__/webgpu/harness.html");

  const hasAdapter = await page.evaluate(() => window.__voidmeshWebgpuHarness.hasWebgpuAdapter());
  test.skip(!hasAdapter, "WebGPU adapter unavailable in this browser/environment");
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__voidmeshWebgpuHarness?.destroy()).catch(() => {});
});

for (const visualCase of visualCases) {
  test(`visually renders ${visualCase}`, async ({ page }) => {
    const availableCases = await page.evaluate(() =>
      window.__voidmeshWebgpuHarness.getVisualCases(),
    );
    expect(availableCases).toContain(visualCase);

    const result = await page.evaluate((caseId) => {
      return window.__voidmeshWebgpuHarness.renderVisualCase(caseId);
    }, visualCase);

    expect(result.canvasWidth).toBeGreaterThanOrEqual(256);
    expect(result.canvasHeight).toBeGreaterThanOrEqual(256);
    expect(result.entityCount).toBe(1);
    expect(result.renderedCount).toBe(1);
    expect(result.frameVisiblePixels).toBeGreaterThan(500);

    await expect(page).toHaveScreenshot(`${visualCase}.png`, {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
    });
  });
}
