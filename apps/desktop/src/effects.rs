//! The effect model: one shader per entity with shared params, adjustments and post-processing,
//! as the web app's `ShaderParams`. Defaults, ranges and per-shader resets follow its config.

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Shader {
    Halftone,
    Blobs,
    Melt,
    Dithering,
    Ascii,
    Glass,
    Glitch,
}

impl Shader {
    pub const ALL: [Shader; 7] = [Shader::Halftone, Shader::Blobs, Shader::Melt, Shader::Dithering, Shader::Ascii, Shader::Glass, Shader::Glitch];


    /// The shader's id in `process.wgsl`.
    pub fn gpu_id(self) -> u32 {
        match self {
            Shader::Halftone => 1,
            Shader::Blobs => 2,
            Shader::Melt => 3,
            Shader::Dithering => 4,
            Shader::Ascii => 5,
            Shader::Glass => 6,
            Shader::Glitch => 7,
        }
    }

    pub fn has_shape(self) -> bool {
        matches!(self, Shader::Halftone | Shader::Blobs | Shader::Melt)
    }

    /// Glass works on the image's own colours: no palette, preserve or reverse.
    pub fn uses_palette(self) -> bool {
        self != Shader::Glass
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DotShape {
    Circle,
    Square,
    RectV,
}

impl DotShape {
    pub const ALL: [DotShape; 3] = [DotShape::Circle, DotShape::Square, DotShape::RectV];
}

pub const SHADER_LABELS: [&str; 7] = ["Halftone", "Blobs", "Melt", "Dithering", "ASCII", "Glass", "Glitch"];
pub const SHAPE_LABELS: [&str; 3] = ["Circle", "Square", "Vertical Rectangle"];
pub const DITHER_KINDS: [&str; 5] = ["Bayer 2x2", "Bayer 4x4", "Bayer 8x8", "White Noise", "Blue Noise"];
pub const ASCII_KINDS: [&str; 4] = ["Standard", "Extended", "Binary", "Minimal"];
pub const GLASS_KINDS: [&str; 3] = ["Fluted", "Frosted Voronoi", "Flowing"];
pub const GLITCH_KINDS: [&str; 4] = ["Channel Shift", "Scanline", "Block Corrupt", "Pixel Smear"];

pub type Rgba = [f32; 4];

/// A palette as the web app's `ColorPalette`: presets carry their preset id, an entity's
/// extracted palette is `original`, user palettes `cstm_…`/`ext_…`.
#[derive(Clone, Debug, PartialEq)]
pub struct Palette {
    pub id: String,
    pub name: String,
    pub short_name: String,
    pub colors: Vec<Rgba>,
}

pub fn hex(v: u32) -> Rgba {
    [((v >> 16) & 0xff) as f32 / 255.0, ((v >> 8) & 0xff) as f32 / 255.0, (v & 0xff) as f32 / 255.0, 1.0]
}

pub const ORIGINAL_ID: &str = "original";
/// What "+" adds to a palette (`config.defaults.paletteDefaults.newPaletteColor`).
pub const NEW_COLOR: Rgba = [0.5, 0.5, 0.65, 1.0];

/// The user's own palettes: made (`cstm_`) or extracted (`ext_`).
pub fn is_user_palette(id: &str) -> bool {
    id.starts_with("cstm_") || id.starts_with("ext_")
}

/// A fresh user palette id with `prefix` (`cstm_` or `ext_`).
pub fn new_palette_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    format!("{prefix}{t:x}{:x}", N.fetch_add(1, Ordering::Relaxed))
}
pub const MAX_COLORS: usize = 16;

/// The 13 presets, in the web app's order (`lib/config/palettes.config.ts`).
pub fn presets() -> &'static [Palette] {
    static P: std::sync::LazyLock<Vec<Palette>> = std::sync::LazyLock::new(|| {
        let p = |id: &str, name: &str, short: &str, c: &[u32]| Palette { id: id.into(), name: name.into(), short_name: short.into(), colors: c.iter().map(|v| hex(*v)).collect() };
        vec![
            p("blackAndWhite", "Black & White", "B&W", &[0x000000, 0xffffff]),
            p("gameboy", "Game Boy", "GB", &[0x0f380f, 0x306230, 0x8bac0f, 0x9bbc0f]),
            p("gameboyPocket", "Game Boy Pocket", "GB Pocket", &[0x181818, 0x4a5138, 0x8c926b, 0xc5caa4]),
            p("gameboyLight", "Game Boy Light", "GB Light", &[0x004f3a, 0x00694a, 0x009a70, 0x00b582]),
            p("grayscale4", "Grayscale 4", "Gray 4", &[0x000000, 0x555555, 0xaaaaaa, 0xffffff]),
            p("grayscale8", "Grayscale 8", "Gray 8", &[0x000000, 0x242424, 0x494949, 0x6d6d6d, 0x929292, 0xb6b6b6, 0xdbdbdb, 0xffffff]),
            p("midnightAblaze", "Midnight Ablaze", "Midnight Ablaze", &[0x130208, 0x1f0510, 0x31051e, 0x460e2b, 0x7c183c, 0xd53c6a, 0xff8274]),
            p("sepia", "Sepia", "Sepia", &[0x352318, 0x5c3d2e, 0x8b5a3c, 0xd4a574, 0xf5deb3]),
            p("winter", "Winter", "Winter", &[0x20284e, 0x2c4a78, 0x3875a1, 0x8bcadd, 0xffffff, 0xd6e1e9, 0xa7bcc9, 0x738d9d]),
            p("cyberpunk", "Cyberpunk", "Cyberpunk", &[0x0d0221, 0x0f084b, 0x26408b, 0xff124f, 0xff00a0, 0xfe75fe]),
            p("sunset", "Sunset", "Sunset", &[0x1a1a2e, 0x16213e, 0xe94560, 0xff6b35, 0xf7c566]),
            p(
                "cga",
                "CGA",
                "CGA",
                &[
                    0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa, 0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55,
                    0xffffff,
                ],
            ),
            p(
                "commodore64",
                "Commodore 64",
                "C64",
                &[
                    0x000000, 0xffffff, 0x880000, 0xaaffee, 0xcc44cc, 0x00cc55, 0x0000aa, 0xeeee77, 0xdd8855, 0x664400, 0xff7777, 0x333333, 0x777777, 0xaaff66, 0x0088ff,
                    0xbbbbbb,
                ],
            ),
        ]
    });
    &P
}

/// An entity's Original palette from its extracted colours.
pub fn original(colors: Vec<Rgba>) -> Palette {
    Palette { id: ORIGINAL_ID.into(), name: "Original".into(), short_name: "Original".into(), colors }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    pub shader: Shader,
    pub size: f32,
    pub shape: DotShape,
    pub scale: f32,
    pub intensity: f32,
    pub preserve_colors: bool,
    pub reverse_palette: bool,
    pub show_original: bool,
    pub palette: Palette,
    pub eagerness: f32,
    pub dither_kind: u32,
    pub ascii_kind: u32,
    pub ascii_invert: bool,
    pub glass_kind: u32,
    pub glass_angle: f32,
    pub caustic: f32,
    pub frostiness: f32,
    pub highlight: f32,
    pub dispersion: f32,
    pub flow: f32,
    pub glitch_kind: u32,
    pub glitch_angle: f32,
    pub brightness: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub blur: f32,
    pub grain: bool,
    pub grain_size: f32,
    pub grain_intensity: f32,
    pub bloom: bool,
    pub bloom_threshold: f32,
    pub bloom_intensity: f32,
    pub bloom_radius: f32,
    pub bloom_softness: f32,
    pub chroma: bool,
    pub chroma_offset: f32,
    /// Flowing glass advances its own clock while true.
    pub time_autoplay: bool,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            shader: Shader::Dithering,
            size: 1.0,
            shape: DotShape::Circle,
            scale: 1.0,
            intensity: 1.0,
            preserve_colors: false,
            reverse_palette: false,
            show_original: false,
            palette: presets()[0].clone(),
            eagerness: 0.5,
            dither_kind: 2,
            ascii_kind: 0,
            ascii_invert: false,
            glass_kind: 1,
            glass_angle: 0.0,
            caustic: 1.0,
            frostiness: 0.8,
            highlight: 0.1,
            dispersion: 0.6,
            flow: 0.5,
            glitch_kind: 0,
            glitch_angle: 0.0,
            brightness: 0.5,
            contrast: 0.5,
            saturation: 0.5,
            blur: 0.0,
            grain: true,
            grain_size: 1.0,
            grain_intensity: 0.12,
            bloom: true,
            bloom_threshold: 0.5,
            bloom_intensity: 0.15,
            bloom_radius: 21.0,
            bloom_softness: 0.1,
            chroma: false,
            chroma_offset: 2.0,
            time_autoplay: true,
        }
    }
}

impl Params {
    /// Switch shader, applying the web app's forced resets for a good first look.
    pub fn set_shader(&mut self, s: Shader) {
        if self.shader == s {
            return;
        }
        self.shader = s;
        self.blur = 0.0;
        match s {
            Shader::Dithering => {
                self.size = 1.0;
                self.preserve_colors = false;
            }
            Shader::Halftone => {
                self.size = 10.0;
                self.shape = DotShape::Circle;
                self.scale = 1.0;
            }
            Shader::Blobs => {
                self.size = 10.0;
                self.eagerness = 0.4;
                self.scale = 0.5;
                self.intensity = 0.5;
                self.shape = DotShape::Circle;
                self.preserve_colors = true;
            }
            Shader::Melt => {
                self.size = 8.0;
                self.shape = DotShape::RectV;
                self.scale = 2.0;
            }
            Shader::Ascii => {
                self.size = 12.0;
                self.scale = 1.0;
            }
            Shader::Glass => {
                self.intensity = 1.0;
                self.scale = 1.0;
                self.chroma = true;
                self.chroma_offset = 6.0;
                self.glass_angle = 0.0;
                self.caustic = 0.1;
                self.apply_glass_kind();
            }
            Shader::Glitch => {
                self.size = 25.0;
                self.intensity = 1.0;
                self.scale = 1.0;
                self.preserve_colors = true;
                self.apply_glitch_kind();
            }
        }
    }

    pub fn set_glass_kind(&mut self, k: u32) {
        self.glass_kind = k;
        self.apply_glass_kind();
    }

    fn apply_glass_kind(&mut self) {
        let (size, intensity, scale, blur) = match self.glass_kind {
            0 => (20.0, 1.0, 1.0, 5.0),
            2 => (40.0, 4.0, 1.55, 0.0),
            _ => (6.0, 1.0, 1.0, 3.0),
        };
        (self.size, self.intensity, self.scale, self.blur) = (size, intensity, scale, blur);
    }

    pub fn set_glitch_kind(&mut self, k: u32) {
        self.glitch_kind = k;
        self.apply_glitch_kind();
    }

    fn apply_glitch_kind(&mut self) {
        let (size, intensity) = match self.glitch_kind {
            1 => (3.0, 1.0),
            2 => (8.0, 2.0),
            3 => (50.0, 2.0),
            _ => (25.0, 1.0),
        };
        (self.size, self.intensity, self.scale) = (size, intensity, 1.0);
    }

    /// The output depends on the effect's clock (flowing glass).
    pub fn uses_time(&self) -> bool {
        !self.show_original && self.shader == Shader::Glass && self.glass_kind == 2
    }

    /// True when the output changes with time on its own (flowing glass, auto-playing).
    pub fn animated(&self) -> bool {
        self.uses_time() && self.time_autoplay
    }

    /// Palette as the shader reads it: background first, the rest sorted by luminance.
    pub fn gpu_palette(&self) -> Vec<Rgba> {
        let mut colors = self.palette.colors.clone();
        if self.reverse_palette {
            colors.reverse();
        }
        let lum = |c: &Rgba| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        if colors.len() > 2 {
            let rest = &mut colors[1..];
            rest.sort_by(|a, b| lum(a).total_cmp(&lum(b)));
        }
        colors.truncate(MAX_COLORS);
        colors
    }
}

/// A slider's range, step and how it reads.
#[derive(Clone, Copy)]
pub struct Range {
    pub min: f32,
    pub max: f32,
    pub step: f32,
}

pub const SIZE: Range = Range { min: 1.0, max: 100.0, step: 1.0 };
pub const INTENSITY: Range = Range { min: 0.0, max: 5.0, step: 0.01 };
pub const SCALE: Range = Range { min: 0.1, max: 3.0, step: 0.01 };
pub const UNIT: Range = Range { min: 0.0, max: 1.0, step: 0.01 };
pub const ANGLE: Range = Range { min: 0.0, max: 360.0, step: 1.0 };
pub const CAUSTIC: Range = Range { min: 0.0, max: 2.0, step: 0.01 };
pub const BLUR: Range = Range { min: 0.0, max: 60.0, step: 0.1 };
pub const GRAIN_SIZE: Range = Range { min: 1.0, max: 10.0, step: 1.0 };
pub const BLOOM_RADIUS: Range = Range { min: 0.0, max: 100.0, step: 1.0 };
pub const CHROMA: Range = Range { min: 0.0, max: 10.0, step: 1.0 };

/// Blur slider (0–60) to dual-Kawase levels and offset: each level doubles the radius, and the
/// breakpoints widen as values grow, as the web app maps it.
pub fn blur_levels(value: f32) -> (u32, f32) {
    if value <= 0.001 {
        return (0, 0.0);
    }
    const BREAKS: [f32; 8] = [0.3, 2.0, 6.0, 14.0, 24.0, 36.0, 48.0, 60.0];
    let mut lo = 0.0;
    for (i, hi) in BREAKS.iter().enumerate() {
        if value <= *hi {
            let t = (value - lo) / (hi - lo);
            return (i as u32 + 1, t * 0.5);
        }
        lo = *hi;
    }
    (8, 0.5)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blur_maps_to_levels() {
        assert_eq!(blur_levels(0.0).0, 0);
        assert_eq!(blur_levels(0.2).0, 1);
        assert_eq!(blur_levels(3.0).0, 3);
        assert_eq!(blur_levels(60.0).0, 8);
    }

    #[test]
    fn palette_keeps_background_first_and_sorts_the_rest() {
        let p = Params { palette: presets()[8].clone(), ..Params::default() }; // Winter
        let c = p.gpu_palette();
        assert_eq!(c[0], hex(0x20284e));
        let lum = |c: &Rgba| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        assert!(c[1..].windows(2).all(|w| lum(&w[0]) <= lum(&w[1])));
    }

    #[test]
    fn switching_to_glass_applies_its_resets() {
        let mut p = Params::default();
        p.set_shader(Shader::Glass);
        assert_eq!((p.size, p.blur, p.chroma, p.chroma_offset), (6.0, 3.0, true, 6.0));
    }
}
