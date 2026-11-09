//! Colour conversions for the colour picker: OKLCH (the web picker's space: lightness 0–1,
//! chroma 0–0.37, hue in degrees) to and from sRGB, and hex.

use crate::effects::Rgba;

/// The picker area's chroma at its right edge (`MAX_CHROMA` on the web).
pub const MAX_CHROMA: f32 = 0.37;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Oklch {
    pub l: f32,
    pub c: f32,
    pub h: f32,
    pub a: f32,
}

fn to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn to_gamma(c: f32) -> f32 {
    if c <= 0.003_130_8 { 12.92 * c } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

/// Linear sRGB of an OKLCH colour, unclamped (out of gamut when outside 0–1).
pub fn oklch_linear(o: Oklch) -> [f32; 3] {
    let h = o.h.to_radians();
    let (a, b) = (o.c * h.cos(), o.c * h.sin());
    let l_ = o.l + 0.396_337_78 * a + 0.215_803_76 * b;
    let m_ = o.l - 0.105_561_346 * a - 0.063_854_17 * b;
    let s_ = o.l - 0.089_484_18 * a - 1.291_485_5 * b;
    let (l, m, s) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    [
        4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s,
        -1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s,
        -0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s,
    ]
}

/// sRGB (gamma-encoded, clamped into gamut) of an OKLCH colour.
pub fn to_rgba(o: Oklch) -> Rgba {
    let [r, g, b] = oklch_linear(o).map(|v| to_gamma(v.clamp(0.0, 1.0)));
    [r, g, b, o.a.clamp(0.0, 1.0)]
}

/// OKLCH of an sRGB colour. Greys keep hue `keep_h` (they have none of their own).
pub fn from_rgba(c: Rgba, keep_h: f32) -> Oklch {
    let [r, g, b] = [c[0], c[1], c[2]].map(to_linear);
    let l = 0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b;
    let m = 0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b;
    let s = 0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b;
    let (l_, m_, s_) = (l.cbrt(), m.cbrt(), s.cbrt());
    let ll = 0.210_454_26 * l_ + 0.793_617_8 * m_ - 0.004_072_047 * s_;
    let aa = 1.977_998_5 * l_ - 2.428_592_2 * m_ + 0.450_593_7 * s_;
    let bb = 0.025_904_037 * l_ + 0.782_771_77 * m_ - 0.808_675_77 * s_;
    let c_ = aa.hypot(bb);
    let h = if c_ < 1e-4 { keep_h } else { bb.atan2(aa).to_degrees().rem_euclid(360.0) };
    Oklch { l: ll.clamp(0.0, 1.0), c: c_.min(MAX_CHROMA), h, a: c[3] }
}

/// `#rrggbb`, or `#rrggbbaa` when not opaque.
pub fn hex(c: Rgba) -> String {
    let b = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    if b(c[3]) == 255 { format!("#{:02x}{:02x}{:02x}", b(c[0]), b(c[1]), b(c[2])) } else { format!("#{:02x}{:02x}{:02x}{:02x}", b(c[0]), b(c[1]), b(c[2]), b(c[3])) }
}

/// Parse `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (the `#` optional).
pub fn parse_hex(s: &str) -> Option<Rgba> {
    let s = s.trim().trim_start_matches('#');
    let digits: Vec<u8> = s.chars().map(|c| c.to_digit(16).map(|d| d as u8)).collect::<Option<_>>()?;
    let full: Vec<u8> = match digits.len() {
        3 | 4 => digits.iter().map(|d| d * 17).collect(),
        6 | 8 => digits.chunks(2).map(|p| p[0] * 16 + p[1]).collect(),
        _ => return None,
    };
    let a = full.get(3).map_or(1.0, |v| f32::from(*v) / 255.0);
    Some([f32::from(full[0]) / 255.0, f32::from(full[1]) / 255.0, f32::from(full[2]) / 255.0, a])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oklch_round_trips_srgb() {
        for c in [[1.0, 0.0, 0.0, 1.0], [0.2, 0.6, 0.9, 0.5], [0.5, 0.5, 0.65, 1.0], [0.0, 0.0, 0.0, 1.0]] {
            let back = to_rgba(from_rgba(c, 0.0));
            for i in 0..4 {
                assert!((back[i] - c[i]).abs() < 2e-3, "{c:?} -> {back:?}");
            }
        }
    }

    #[test]
    fn greys_keep_the_hue_they_had() {
        assert_eq!(from_rgba([0.5, 0.5, 0.5, 1.0], 123.0).h, 123.0);
    }

    #[test]
    fn hex_parses_and_prints() {
        assert_eq!(parse_hex("#fff"), Some([1.0, 1.0, 1.0, 1.0]));
        assert_eq!(parse_hex("00ff0080").map(|c| (c[1], (c[3] * 255.0).round())), Some((1.0, 128.0)));
        assert_eq!(parse_hex("#12"), None);
        assert_eq!(parse_hex("#zzzzzz"), None);
        assert_eq!(hex([1.0, 0.0, 0.5, 1.0]), "#ff0080");
        assert_eq!(hex([1.0, 0.0, 0.0, 0.5]), "#ff000080");
    }
}
