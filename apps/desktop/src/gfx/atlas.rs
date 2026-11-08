//! The processed-texture atlas: one mipmapped 2D array texture that holds every preview-LOD
//! material small enough for it, so the canvas composes all of them in one instanced draw.
//!
//! Tiles are power-of-two squares from a buddy allocator, aligned to their size: a tile's mip
//! level `k` is exactly its region shifted by `k`, so no level ever mixes in a neighbour. The
//! atlas starts small and doubles its side up to `MAX_SIDE`, then adds layers; growing copies
//! what it holds, and tile coordinates (texels) stay valid.

use std::collections::{BTreeSet, HashMap};

use super::process::FORMAT;

/// Largest layer side: small enough that the atlas grows in steps a few megabytes each.
pub const MAX_SIDE: u32 = 1024;
/// Largest tile: materials above this have a texture of their own.
pub const MAX_TILE: u32 = 512;
/// Smallest tile.
pub const MIN_TILE: u32 = 16;
const START_SIDE: u32 = 512;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Tile {
    pub layer: u32,
    pub x: u32,
    pub y: u32,
    pub size: u32,
}

pub struct Atlas {
    pub texture: wgpu::Texture,
    /// The whole array, every level, for sampling.
    pub view: wgpu::TextureView,
    pub side: u32,
    pub layers: u32,
    /// Free blocks by size, lowest layer first: allocation fills the bottom layers, so freed space
    /// gathers at the top, where `trim` can drop it.
    free: HashMap<u32, BTreeSet<(u32, u32, u32)>>,
    /// Bumped whenever `texture` is replaced (bind groups made from it go stale).
    pub generation: u64,
    pub used_texels: u64,
}

pub fn mip_count(side: u32) -> u32 {
    32 - side.max(1).leading_zeros()
}

fn texture(device: &wgpu::Device, side: u32, layers: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("voidmesh atlas"),
        size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: layers },
        mip_level_count: mip_count(side),
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

impl Atlas {
    pub fn new(device: &wgpu::Device) -> Atlas {
        let t = texture(device, START_SIDE, 1);
        let mut a = Atlas { view: array_view(&t), texture: t, side: START_SIDE, layers: 1, free: HashMap::new(), generation: 0, used_texels: 0 };
        a.put(Tile { layer: 0, x: 0, y: 0, size: START_SIDE });
        a
    }

    pub fn bytes(&self) -> u64 {
        // A full mip chain adds a third.
        u64::from(self.side) * u64::from(self.side) * 4 * u64::from(self.layers) * 4 / 3
    }

    fn put(&mut self, t: Tile) {
        self.free.entry(t.size).or_default().insert((t.layer, t.y, t.x));
    }

    fn is_free(&self, t: &Tile) -> bool {
        self.free.get(&t.size).is_some_and(|f| f.contains(&(t.layer, t.y, t.x)))
    }

    fn unfree(&mut self, t: &Tile) -> bool {
        self.free.get_mut(&t.size).is_some_and(|f| f.remove(&(t.layer, t.y, t.x)))
    }

    fn take_free(&mut self, size: u32) -> Option<Tile> {
        let (layer, y, x) = self.free.get_mut(&size)?.pop_first()?;
        Some(Tile { layer, x, y, size })
    }

    /// The tile side for content of `w`×`h`.
    pub fn tile_side(w: u32, h: u32) -> u32 {
        w.max(h).max(MIN_TILE).next_power_of_two()
    }

    /// A tile for content of `w`×`h`, growing the atlas when it's full. None when the content
    /// is larger than a tile can be.
    pub fn alloc(&mut self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, w: u32, h: u32) -> Option<Tile> {
        let size = Self::tile_side(w, h);
        if size > MAX_TILE {
            return None;
        }
        loop {
            // The smallest free block that fits, split down to size.
            let mut s = size;
            let found = loop {
                if s > self.side {
                    break None;
                }
                if let Some(t) = self.take_free(s) {
                    break Some(t);
                }
                s *= 2;
            };
            if let Some(mut t) = found {
                while t.size > size {
                    let h = t.size / 2;
                    for (dx, dy) in [(h, 0), (0, h), (h, h)] {
                        self.put(Tile { layer: t.layer, x: t.x + dx, y: t.y + dy, size: h });
                    }
                    t.size = h;
                }
                self.used_texels += u64::from(size) * u64::from(size);
                return Some(t);
            }
            self.grow(device, enc);
        }
    }

    pub fn free(&mut self, t: Tile) {
        self.used_texels -= u64::from(t.size) * u64::from(t.size);
        let mut t = t;
        // Merge with the three siblings while they're all free.
        while t.size < self.side {
            let p = t.size * 2;
            let (px, py) = (t.x & !(p - 1), t.y & !(p - 1));
            let sibs = [(0, 0), (t.size, 0), (0, t.size), (t.size, t.size)].map(|(dx, dy)| Tile { layer: t.layer, x: px + dx, y: py + dy, size: t.size });
            if !sibs.iter().all(|s| *s == t || self.is_free(s)) {
                break;
            }
            for s in sibs {
                self.unfree(&s);
            }
            t = Tile { layer: t.layer, x: px, y: py, size: p };
        }
        self.put(t);
    }

    /// Drop empty layers from the top (allocation fills from the bottom), copying what's left
    /// into a smaller texture. True when it did.
    pub fn trim(&mut self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder) -> bool {
        let mut layers = self.layers;
        while layers > 1 && self.is_free(&Tile { layer: layers - 1, x: 0, y: 0, size: self.side }) {
            layers -= 1;
        }
        // Two empty layers at least, so a canvas hovering at a layer's edge doesn't copy the
        // atlas back and forth; one stays for what comes next.
        if layers + 2 > self.layers {
            return false;
        }
        layers += 1;
        for layer in layers..self.layers {
            self.unfree(&Tile { layer, x: 0, y: 0, size: self.side });
        }
        let t = texture(device, self.side, layers);
        for level in 0..mip_count(self.side) {
            let s = (self.side >> level).max(1);
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo { texture: &self.texture, mip_level: level, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::TexelCopyTextureInfo { texture: &t, mip_level: level, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::Extent3d { width: s, height: s, depth_or_array_layers: layers },
            );
        }
        self.layers = layers;
        self.view = array_view(&t);
        self.texture = t;
        self.generation += 1;
        true
    }

    /// Double the side, or add a layer once the side is at its largest.
    fn grow(&mut self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder) {
        let (side, layers) = if self.side < MAX_SIDE { (self.side * 2, self.layers) } else { (self.side, self.layers + 1) };
        let t = texture(device, side, layers);
        for level in 0..mip_count(self.side) {
            let s = (self.side >> level).max(1);
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo { texture: &self.texture, mip_level: level, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::TexelCopyTextureInfo { texture: &t, mip_level: level, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::Extent3d { width: s, height: s, depth_or_array_layers: self.layers },
            );
        }
        if side > self.side {
            let old = self.side;
            for layer in 0..self.layers {
                let root = Tile { layer, x: 0, y: 0, size: old };
                if self.unfree(&root) {
                    // An empty layer stays one block.
                    self.put(Tile { layer, x: 0, y: 0, size: side });
                } else {
                    for (x, y) in [(old, 0), (0, old), (old, old)] {
                        self.put(Tile { layer, x, y, size: old });
                    }
                }
            }
        } else {
            self.put(Tile { layer: self.layers, x: 0, y: 0, size: side });
        }
        self.side = side;
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
    fn tiles_are_aligned_and_merge_back() {
        let (d, _) = device();
        let mut a = Atlas::new(&d);
        let mut enc = d.create_command_encoder(&Default::default());
        let tiles: Vec<Tile> = (0..20).map(|i| a.alloc(&d, &mut enc, 40 + i, 30).expect("fits")).collect();
        for t in &tiles {
            assert_eq!(t.size, 64);
            assert_eq!((t.x % 64, t.y % 64), (0, 0));
        }
        let distinct: std::collections::HashSet<_> = tiles.iter().map(|t| (t.x, t.y)).collect();
        assert_eq!(distinct.len(), tiles.len());
        for t in tiles {
            a.free(t);
        }
        assert_eq!(a.used_texels, 0);
        assert!(a.is_free(&Tile { layer: 0, x: 0, y: 0, size: 512 }), "everything merges back to the root");
    }

    #[test]
    fn a_full_atlas_grows_its_side_then_its_layers() {
        let (d, _) = device();
        let mut a = Atlas::new(&d);
        let mut enc = d.create_command_encoder(&Default::default());
        for _ in 0..4 {
            a.alloc(&d, &mut enc, MAX_TILE, MAX_TILE).expect("fits");
        }
        assert_eq!((a.side, a.layers), (MAX_SIDE, 1));
        a.alloc(&d, &mut enc, MAX_TILE, MAX_TILE - 100).expect("fits");
        assert_eq!(a.layers, 2);
        assert!(a.alloc(&d, &mut enc, MAX_TILE * 2, 10).is_none(), "over the largest tile");
        let top = a.alloc(&d, &mut enc, 64, 64).expect("fits");
        assert_eq!(top.layer, 1, "the bottom layer is full");
        a.free(top);
        assert!(!a.trim(&d, &mut enc), "the second layer still holds a tile");
    }
}
