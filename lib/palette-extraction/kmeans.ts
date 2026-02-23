/**
 * K-means clustering for color quantization.
 * Simple, fast implementation optimized for palette extraction.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Calculate squared Euclidean distance between two colors.
 * Using squared distance avoids sqrt for performance.
 */
function colorDistanceSquared(a: RGB, b: RGB): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

/**
 * Calculate luminance for sorting (ITU-R BT.601).
 */
function luminance(color: RGB): number {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}

/**
 * Initialize centroids using k-means++ for better convergence.
 * Picks initial centroids spread out across the color space.
 */
function initializeCentroids(pixels: RGB[], k: number): RGB[] {
  if (pixels.length === 0) return [];
  if (pixels.length <= k) {
    return pixels.map((p) => ({ ...p }));
  }

  const centroids: RGB[] = [];

  // First centroid: random pixel
  const firstIdx = Math.floor(Math.random() * pixels.length);
  centroids.push({ ...pixels[firstIdx]! });

  // Remaining centroids: weighted by distance to nearest existing centroid
  for (let i = 1; i < k; i++) {
    const distances: number[] = [];
    let totalDistance = 0;

    for (const pixel of pixels) {
      // Find distance to nearest centroid
      let minDist = Infinity;
      for (const centroid of centroids) {
        const dist = colorDistanceSquared(pixel, centroid);
        if (dist < minDist) minDist = dist;
      }
      distances.push(minDist);
      totalDistance += minDist;
    }

    // Weighted random selection
    if (totalDistance === 0) {
      // All remaining pixels are identical to existing centroids
      const idx = Math.floor(Math.random() * pixels.length);
      centroids.push({ ...pixels[idx]! });
    } else {
      let threshold = Math.random() * totalDistance;
      for (let j = 0; j < pixels.length; j++) {
        threshold -= distances[j]!;
        if (threshold <= 0) {
          centroids.push({ ...pixels[j]! });
          break;
        }
      }
      // Fallback if we didn't pick one (floating point edge case)
      if (centroids.length === i) {
        centroids.push({ ...pixels[pixels.length - 1]! });
      }
    }
  }

  return centroids;
}

/**
 * Run k-means clustering to find dominant colors.
 *
 * @param pixels - Array of RGB colors (0-255 range)
 * @param k - Number of clusters/colors to extract
 * @param iterations - Number of iterations to run
 * @returns Array of k RGB colors sorted by luminance
 */
export function kMeans(pixels: RGB[], k: number, iterations: number): RGB[] {
  if (pixels.length === 0) return [];

  // Handle case where we have fewer unique colors than requested
  const uniqueColors = new Map<string, RGB>();
  for (const pixel of pixels) {
    const key = `${pixel.r},${pixel.g},${pixel.b}`;
    if (!uniqueColors.has(key)) {
      uniqueColors.set(key, pixel);
    }
  }

  if (uniqueColors.size <= k) {
    const colors = Array.from(uniqueColors.values());
    colors.sort((a, b) => luminance(a) - luminance(b));
    return colors;
  }

  // Initialize centroids with k-means++
  let centroids = initializeCentroids(pixels, k);

  // Run iterations
  for (let iter = 0; iter < iterations; iter++) {
    // Assign pixels to nearest centroid
    const clusters: RGB[][] = Array.from({ length: k }, () => []);

    for (const pixel of pixels) {
      let minDist = Infinity;
      let closest = 0;

      for (let i = 0; i < centroids.length; i++) {
        const dist = colorDistanceSquared(pixel, centroids[i]!);
        if (dist < minDist) {
          minDist = dist;
          closest = i;
        }
      }

      clusters[closest]!.push(pixel);
    }

    // Update centroids to cluster means
    const newCentroids: RGB[] = [];

    for (let i = 0; i < k; i++) {
      const cluster = clusters[i]!;
      if (cluster.length === 0) {
        // Empty cluster: keep old centroid
        newCentroids.push(centroids[i]!);
      } else {
        // Calculate mean
        let sumR = 0,
          sumG = 0,
          sumB = 0;
        for (const pixel of cluster) {
          sumR += pixel.r;
          sumG += pixel.g;
          sumB += pixel.b;
        }
        newCentroids.push({
          r: Math.round(sumR / cluster.length),
          g: Math.round(sumG / cluster.length),
          b: Math.round(sumB / cluster.length),
        });
      }
    }

    centroids = newCentroids;
  }

  // Sort by luminance (dark to light)
  centroids.sort((a, b) => luminance(a) - luminance(b));

  return centroids;
}
