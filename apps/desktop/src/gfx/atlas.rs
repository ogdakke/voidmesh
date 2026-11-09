//! The processed-texture atlas: one 2D array texture that holds every preview material small
//! enough for it, so the canvas composes all of them in one instanced draw.
//!
//! Previews keep one level (LOD tiers hold them near their size on screen), so tiles needn't be
//! power-of-two squares: each layer is cut into shelves, rows of one height class, and tiles take
//! spans of a shelf a few pixels wider than their content. A 64×43 preview takes 64×48, not
//! 64×64. Freed spans merge, an emptied shelf gives its rows back, and empty layers at the top go.

use super::process::FORMAT;

/// A layer's side.
pub const SIDE: u32 = 1024;
/// Largest tile side: materials above this have a texture of their own.
pub const MAX_TILE: u32 = 512;
/// Tile widths round up to this, heights to `HEIGHT_STEP`.
const WIDTH_STEP: u32 = 8;
const HEIGHT_STEP: u32 = 16;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Tile {
    pub layer: u32,
    pub x: u32,
    pub y: u32,
    /// The space it holds (its content is at most this).
    pub w: u32,
    pub h: u32,
}

impl Tile {
    pub fn bytes(&self) -> u64 {
        u64::from(self.w) * u64::from(self.h) * 4
    }
}

/// A row of one height class: the spans of it that are free.
struct Shelf {
    layer: u32,
    y: u32,
    h: u32,
    free: Vec<(u32, u32)>,
}

pub struct Atlas {
    pub texture: wgpu::Texture,
    /// The whole array, for sampling.
    pub view: wgpu::TextureView,
    pub layers: u32,
    shelves: Vec<Shelf>,
    /// Each layer's rows not in a shelf: [y0, y1) spans.
    rows: Vec<Vec<(u32, u32)>>,
    /// Bumped whenever `texture` is replaced (bind groups made from it go stale).
    pub generation: u64,
    pub used_bytes: u64,
    /// Calls `trim` has found an empty layer on top.
    empty_for: u32,
}

/// Calls an empty top layer stays before `trim` drops it.
const TRIM_FRAMES: u32 = 30;

/// The atlas's texture of `layers` layers: a 1×1 stand-in while it has none (nothing to sample,
/// but bind groups need a texture).
fn texture(device: &wgpu::Device, layers: u32) -> wgpu::Texture {
    let side = if layers == 0 { 1 } else { SIDE };
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("voidmesh atlas"),
        size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: layers.max(1) },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    })
}

fn array_view(t: &wgpu::Texture) -> wgpu::TextureView {
    t.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() })
}

/// Add [a, b) to sorted, disjoint spans, merging neighbours.
fn give(spans: &mut Vec<(u32, u32)>, a: u32, b: u32) {
    let i = spans.partition_point(|s| s.0 < a);
    spans.insert(i, (a, b));
    if i + 1 < spans.len() && spans[i].1 == spans[i + 1].0 {
        spans[i].1 = spans[i + 1].1;
        spans.remove(i + 1);
    }
    if i > 0 && spans[i - 1].1 == spans[i].0 {
        spans[i - 1].1 = spans[i].1;
        spans.remove(i);
    }
}

/// Take `len` from the first span long enough: its start.
fn take(spans: &mut Vec<(u32, u32)>, len: u32) -> Option<u32> {
    let i = spans.iter().position(|s| s.1 - s.0 >= len)?;
    let at = spans[i].0;
    spans[i].0 += len;
    if spans[i].0 == spans[i].1 {
        spans.remove(i);
    }
    Some(at)
}

impl Atlas {
    /// An atlas of no layers: the first comes with the first tile (a canvas of originals too
    /// large for tiles needs none).
    pub fn new(device: &wgpu::Device) -> Atlas {
        let t = texture(device, 0);
        Atlas { view: array_view(&t), texture: t, layers: 0, shelves: Vec::new(), rows: Vec::new(), generation: 0, used_bytes: 0, empty_for: 0 }
    }

    pub fn bytes(&self) -> u64 {
        u64::from(SIDE) * u64::from(SIDE) * 4 * u64::from(self.layers)
    }

    /// Content of `w`×`h` fits a tile.
    pub fn fits(w: u32, h: u32) -> bool {
        w.max(h) <= MAX_TILE
    }

    /// A tile for content of `w`×`h`, adding a layer when the atlas is full. None when the
    /// content is larger than a tile can be.
    pub fn alloc(&mut self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, w: u32, h: u32) -> Option<Tile> {
        if !Self::fits(w, h) {
            return None;
        }
        let (tw, th) = (w.max(1).next_multiple_of(WIDTH_STEP), h.max(1).next_multiple_of(HEIGHT_STEP));
        loop {
            // A shelf of this height with room, the lowest layer first.
            let mut best: Option<usize> = None;
            for (i, s) in self.shelves.iter().enumerate() {
                if s.h == th && s.free.iter().any(|f| f.1 - f.0 >= tw) && best.is_none_or(|b| self.shelves[b].layer > s.layer) {
                    best = Some(i);
                }
            }
            if let Some(i) = best {
                let s = &mut self.shelves[i];
                let x = take(&mut s.free, tw)?;
                self.used_bytes += u64::from(tw) * u64::from(th) * 4;
                return Some(Tile { layer: s.layer, x, y: s.y, w: tw, h: th });
            }
            // A new shelf in the lowest layer with the rows for it.
            if let Some(layer) = (0..self.layers).find(|l| self.rows[*l as usize].iter().any(|r| r.1 - r.0 >= th))
                && let Some(y) = take(&mut self.rows[layer as usize], th)
            {
                self.shelves.push(Shelf { layer, y, h: th, free: vec![(0, SIDE)] });
                continue;
            }
            self.grow(device, enc);
        }
    }

    pub fn free(&mut self, t: Tile) {
        self.used_bytes = self.used_bytes.saturating_sub(t.bytes());
        let Some(i) = self.shelves.iter().position(|s| s.layer == t.layer && s.y == t.y && s.h == t.h) else { return };
        give(&mut self.shelves[i].free, t.x, t.x + t.w);
        if self.shelves[i].free == [(0, SIDE)] {
            let s = self.shelves.swap_remove(i);
            give(&mut self.rows[s.layer as usize], s.y, s.y + s.h);
        }
    }

    /// Drop empty layers from the top (new shelves fill from the bottom), copying what's left into
    /// a smaller texture, once the top one has stayed empty `TRIM_FRAMES` calls: a canvas at a
    /// layer's edge doesn't copy the atlas back and forth. True when it did.
    pub fn trim(&mut self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder) -> bool {
        let mut layers = self.layers;
        while layers > 1 && self.rows[layers as usize - 1] == [(0, SIDE)] {
            layers -= 1;
        }
        if layers == self.layers {
            self.empty_for = 0;
            return false;
        }
        self.empty_for += 1;
        if self.empty_for < TRIM_FRAMES {
            return false;
        }
        self.empty_for = 0;
        self.replace(device, enc, layers);
        true
    }

    fn grow(&mut self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder) {
        self.replace(device, enc, self.layers + 1);
    }

    /// A texture of `layers` layers holding what the current one does, up to that many.
    fn replace(&mut self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, layers: u32) {
        let t = texture(device, layers);
        if self.layers.min(layers) > 0 {
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo { texture: &self.texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::TexelCopyTextureInfo { texture: &t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::Extent3d { width: SIDE, height: SIDE, depth_or_array_layers: self.layers.min(layers) },
            );
        }
        self.rows.resize_with(layers as usize, || vec![(0, SIDE)]);
        self.layers = layers;
        self.view = array_view(&t);
        self.texture = t;
        self.generation += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device() -> (wgpu::Device, wgpu::Queue) {
        let g = rune::render::Gpu::try_new(rune::render::Gpu::instance(), None).expect("a GPU");
        (g.device, g.queue)
    }

    #[test]
    fn tiles_pack_tightly_and_free_back_to_an_empty_layer() {
        let (d, _) = device();
        let mut a = Atlas::new(&d);
        let mut enc = d.create_command_encoder(&Default::default());
        let tiles: Vec<Tile> = (0..40).map(|_| a.alloc(&d, &mut enc, 64, 43).expect("fits")).collect();
        assert!(tiles.iter().all(|t| (t.w, t.h) == (64, 48)), "rounded to the steps, not to a square");
        let distinct: std::collections::HashSet<_> = tiles.iter().map(|t| (t.layer, t.x, t.y)).collect();
        assert_eq!(distinct.len(), tiles.len());
        assert_eq!(a.layers, 1, "forty fit one layer");
        for t in tiles {
            a.free(t);
        }
        assert_eq!(a.used_bytes, 0);
        assert!(a.shelves.is_empty() && a.rows[0] == [(0, SIDE)], "everything gives its rows back");
    }

    #[test]
    fn a_full_atlas_adds_layers_and_trims_empty_ones() {
        let (d, _) = device();
        let mut a = Atlas::new(&d);
        let mut enc = d.create_command_encoder(&Default::default());
        let full: Vec<Tile> = (0..12).map(|_| a.alloc(&d, &mut enc, MAX_TILE, MAX_TILE)).collect::<Option<_>>().expect("fits");
        assert_eq!(a.layers, 3, "four of the largest tiles a layer");
        assert!(a.alloc(&d, &mut enc, MAX_TILE + 1, 10).is_none(), "over the largest tile");
        for t in full.into_iter().filter(|t| t.layer > 0) {
            a.free(t);
        }
        assert!((0..TRIM_FRAMES).map(|_| a.trim(&d, &mut enc)).last() == Some(true), "dropped once empty a while");
        assert_eq!(a.layers, 1, "the empty layers go");
    }
}
