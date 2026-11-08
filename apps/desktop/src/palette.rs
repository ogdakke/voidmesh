//! Palette extraction, as the web app's `lib/palette-extraction`: sample the image down to 100 px,
//! skip transparent pixels, k-means++ in sRGB and sort the centroids by luma. Seeded, so the same
//! image always gives the same palette.

use crate::effects::Rgba;

const SAMPLE: u32 = 100;
const ITERATIONS: usize = 10;
/// Pixels under this alpha (of 255) don't count.
const ALPHA_MIN: u8 = 26;

type Rgb = [i32; 3];

/// `k` colours (2–16) from straight-alpha RGBA8 pixels.
pub fn extract(rgba: &[u8], width: u32, height: u32, k: usize) -> Vec<Rgba> {
    let k = k.clamp(2, crate::effects::MAX_COLORS);
    let pixels = sample(rgba, width, height);
    if pixels.is_empty() {
        return (0..k).map(|i| {
            let v = i as f32 / (k - 1) as f32;
            [v, v, v, 1.0]
        }).collect();
    }
    kmeans(&pixels, k).into_iter().map(|c| [c[0] as f32 / 255.0, c[1] as f32 / 255.0, c[2] as f32 / 255.0, 1.0]).collect()
}

/// Nearest-neighbour sample to at most `SAMPLE` px on the long side.
fn sample(rgba: &[u8], w: u32, h: u32) -> Vec<Rgb> {
    if w == 0 || h == 0 || rgba.len() < (w * h * 4) as usize {
        return Vec::new();
    }
    let (tw, th) = if w <= SAMPLE && h <= SAMPLE {
        (w, h)
    } else if w > h {
        (SAMPLE, ((h as f32 / w as f32) * SAMPLE as f32).round().max(1.0) as u32)
    } else {
        (((w as f32 / h as f32) * SAMPLE as f32).round().max(1.0) as u32, SAMPLE)
    };
    let mut out = Vec::with_capacity((tw * th) as usize);
    for y in 0..th {
        let sy = ((y as f32 + 0.5) * h as f32 / th as f32) as u32;
        for x in 0..tw {
            let sx = ((x as f32 + 0.5) * w as f32 / tw as f32) as u32;
            let i = ((sy.min(h - 1) * w + sx.min(w - 1)) * 4) as usize;
            if rgba[i + 3] >= ALPHA_MIN {
                out.push([i32::from(rgba[i]), i32::from(rgba[i + 1]), i32::from(rgba[i + 2])]);
            }
        }
    }
    out
}

fn dist(a: Rgb, b: Rgb) -> i64 {
    let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    i64::from(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
}

fn luma(c: &Rgb) -> f32 {
    0.299 * c[0] as f32 + 0.587 * c[1] as f32 + 0.114 * c[2] as f32
}

/// xorshift: deterministic seeding for k-means++.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn kmeans(pixels: &[Rgb], k: usize) -> Vec<Rgb> {
    let mut unique: Vec<Rgb> = pixels.to_vec();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() <= k {
        unique.sort_by(|a, b| luma(a).total_cmp(&luma(b)));
        return unique;
    }
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut centroids = vec![pixels[(rng.next() * pixels.len() as f64) as usize % pixels.len()]];
    while centroids.len() < k {
        let d: Vec<i64> = pixels.iter().map(|p| centroids.iter().map(|c| dist(*p, *c)).min().unwrap_or(0)).collect();
        let total: i64 = d.iter().sum();
        let pick = if total == 0 {
            (rng.next() * pixels.len() as f64) as usize % pixels.len()
        } else {
            let mut t = rng.next() * total as f64;
            d.iter().position(|v| {
                t -= *v as f64;
                t <= 0.0
            }).unwrap_or(pixels.len() - 1)
        };
        centroids.push(pixels[pick]);
    }
    for _ in 0..ITERATIONS {
        let mut sums = vec![[0i64; 4]; k];
        for p in pixels {
            let (i, _) = centroids.iter().enumerate().map(|(i, c)| (i, dist(*p, *c))).min_by_key(|(_, d)| *d).unwrap_or((0, 0));
            sums[i][0] += i64::from(p[0]);
            sums[i][1] += i64::from(p[1]);
            sums[i][2] += i64::from(p[2]);
            sums[i][3] += 1;
        }
        for (c, s) in centroids.iter_mut().zip(&sums) {
            if s[3] > 0 {
                *c = [0, 1, 2].map(|j| ((s[j] as f64) / s[3] as f64).round() as i32);
            }
        }
    }
    centroids.sort_by(|a, b| luma(a).total_cmp(&luma(b)));
    centroids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_colour_image_gives_its_two_colours_dark_first() {
        let mut px = Vec::new();
        for i in 0..64 {
            px.extend_from_slice(if i % 2 == 0 { &[255, 255, 255, 255] } else { &[10, 20, 30, 255] });
        }
        let c = extract(&px, 8, 8, 6);
        assert_eq!(c.len(), 2);
        assert!((c[0][0] - 10.0 / 255.0).abs() < 1e-6 && c[1][0] == 1.0);
    }

    #[test]
    fn many_colours_give_k_sorted_by_luma() {
        let px: Vec<u8> = (0..200 * 100).flat_map(|i| [(i % 256) as u8, ((i / 7) % 256) as u8, ((i * 3) % 256) as u8, 255]).collect();
        let c = extract(&px, 200, 100, 6);
        assert_eq!(c.len(), 6);
        let l = |c: &Rgba| 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
        assert!(c.windows(2).all(|w| l(&w[0]) <= l(&w[1])));
        assert_eq!(c, extract(&px, 200, 100, 6), "deterministic");
    }

    #[test]
    fn transparent_image_gives_a_grey_ramp() {
        let c = extract(&[0u8; 16], 2, 2, 3);
        assert_eq!(c, vec![[0.0, 0.0, 0.0, 1.0], [0.5, 0.5, 0.5, 1.0], [1.0, 1.0, 1.0, 1.0]]);
    }
}
