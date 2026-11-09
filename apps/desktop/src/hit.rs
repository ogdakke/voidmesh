//! Alpha-aware picking, as the web app's `lib/alpha-hit-testing.ts` (`config.hitTesting.alphaGrid`):
//! a point on media hits only where the source cell under it is opaque, so clicks on transparent
//! regions fall through to what lies beneath. Frames stay in memory as RGBA, so the one cell under
//! the pointer is sampled on demand; the web app precomputes a grid of the same cells because its
//! pixels live on the GPU.

/// Cell side in source pixels.
const CELL_PX: u32 = 16;
/// Alpha bytes above this count as opaque.
const ALPHA_THRESHOLD: u8 = 8;
/// Share of a cell's pixels that must be opaque for the cell to be.
const COVERAGE: f32 = 0.01;

/// Whether the cell at `(u, v)` (fractions of the frame, clamped in) of a `w`×`h` straight-alpha
/// RGBA8 frame is opaque. Cells sit on a `CELL_PX` lattice from the top-left, clipped at the
/// right and bottom edges.
pub fn cell_opaque(rgba: &[u8], w: u32, h: u32, u: f32, v: f32) -> bool {
    if w == 0 || h == 0 || rgba.len() < (w as usize) * (h as usize) * 4 {
        return false;
    }
    let pick = |t: f32, n: u32| ((t.clamp(0.0, 1.0) * n as f32) as u32).min(n - 1) / CELL_PX * CELL_PX;
    let (x0, y0) = (pick(u, w), pick(v, h));
    let (x1, y1) = ((x0 + CELL_PX).min(w), (y0 + CELL_PX).min(h));
    let mut opaque = 0u32;
    for y in y0..y1 {
        let row = (y * w) as usize * 4;
        opaque += (x0..x1).filter(|&x| rgba[row + x as usize * 4 + 3] > ALPHA_THRESHOLD).count() as u32;
    }
    opaque as f32 / ((x1 - x0) * (y1 - y0)) as f32 >= COVERAGE
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `w`×`h` frame, opaque where `f(x, y)`.
    fn frame(w: u32, h: u32, f: impl Fn(u32, u32) -> bool) -> Vec<u8> {
        (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).flat_map(|(x, y)| [0, 0, 0, if f(x, y) { 255 } else { 0 }]).collect()
    }

    #[test]
    fn transparent_cells_miss_and_opaque_ones_hit() {
        // Left half opaque, on a cell boundary.
        let rgba = frame(64, 32, |x, _| x < 32);
        assert!(cell_opaque(&rgba, 64, 32, 0.1, 0.5));
        assert!(!cell_opaque(&rgba, 64, 32, 0.9, 0.5));
    }

    #[test]
    fn a_cell_needs_one_percent_coverage() {
        // 256 pixels a cell: two opaque pixels are under 1%, three reach it.
        let two = frame(16, 16, |x, y| y == 0 && x < 2);
        let three = frame(16, 16, |x, y| y == 0 && x < 3);
        assert!(!cell_opaque(&two, 16, 16, 0.5, 0.5));
        assert!(cell_opaque(&three, 16, 16, 0.5, 0.5));
    }

    #[test]
    fn faint_alpha_does_not_count() {
        let rgba: Vec<u8> = (0..16 * 16).flat_map(|_| [255, 255, 255, ALPHA_THRESHOLD]).collect();
        assert!(!cell_opaque(&rgba, 16, 16, 0.5, 0.5));
    }

    #[test]
    fn edge_cells_are_clipped_and_the_far_edge_stays_in() {
        // 20×20: the bottom-right cell is 4×4, so a row of 4 opaque pixels covers a quarter of it.
        let rgba = frame(20, 20, |x, y| x >= 16 && y == 19);
        assert!(cell_opaque(&rgba, 20, 20, 1.0, 1.0));
        assert!(!cell_opaque(&rgba, 20, 20, 0.0, 0.0));
    }
}
