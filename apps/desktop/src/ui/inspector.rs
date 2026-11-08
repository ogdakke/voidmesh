//! The inspector: the web app's right sidebar controls, in its order, as a floating surface that
//! rides beside the selection. It edits every selected entity at once; values show the first.

use rune::{El, ScrollSpec, col, row, text};

use super::look::{LARGE, Look};
use super::widgets::{button, section, select, slider, swatches, toggle};
use crate::effects::{self as fx, DotShape, Params, Shader};
use crate::state::App;

/// `--sidebar-width`-ish: the web inspector is 280–320 px.
pub const WIDTH: f32 = 300.0;

pub fn body(l: &Look, s: &App, p: &Params) -> El {
    let shader = Shader::ALL.iter().position(|x| *x == p.shader).unwrap_or(0);
    col()
        .w_full()
        .gap(12.0)
        .child(select(l, "shader", Some("Style"), &fx::SHADER_LABELS, shader, |p, i| p.set_shader(Shader::ALL[i])))
        .child(
            row().w_full().gap(6.0).child(toggle(l, "original", "Original", p.show_original, |p| p.show_original = !p.show_original)).child(button(l, "reset", "Reset", |s| {
                s.edit(|p| {
                    let shader = p.shader;
                    *p = Params::default();
                    p.set_shader(shader);
                });
            })),
        )
        .child(section(l, s, "adjust", "Adjustments", None, adjustments(l, p)))
        .child(section(l, s, "style", "Style Parameters", None, style(l, p)))
        .child(section(l, s, "post", "Post Processing", None, post(l, s, p)))
}

fn style(l: &Look, p: &Params) -> El {
    let mut c = col().w_full().gap(8.0);
    match p.shader {
        Shader::Blobs => c = c.child(slider(l, "eagerness", "Eagerness", p.eagerness, fx::UNIT, |p, v| p.eagerness = v)),
        Shader::Glass => {
            c = c.child(select(l, "glass-kind", Some("Glass Type"), &fx::GLASS_KINDS, p.glass_kind as usize, |p, i| p.set_glass_kind(i as u32)));
            match p.glass_kind {
                0 => {
                    c = c.child(slider(l, "angle", "Angle", p.glass_angle, fx::ANGLE, |p, v| p.glass_angle = v));
                    c = c.child(slider(l, "caustic", "Caustic", p.caustic, fx::CAUSTIC, |p, v| p.caustic = v));
                }
                1 => {
                    c = c.child(slider(l, "frost", "Frostiness", p.frostiness, fx::UNIT, |p, v| p.frostiness = v));
                    c = c.child(slider(l, "highlight", "Highlight", p.highlight, fx::UNIT, |p, v| p.highlight = v));
                }
                _ => {
                    c = c.child(slider(l, "flow", "Flow", p.flow, fx::UNIT, |p, v| p.flow = v));
                    c = c.child(toggle(l, "autoplay", "Animate", p.time_autoplay, |p| p.time_autoplay = !p.time_autoplay));
                }
            }
            c = c.child(slider(l, "dispersion", "Dispersion", p.dispersion, fx::UNIT, |p, v| p.dispersion = v));
        }
        Shader::Glitch => {
            c = c.child(select(l, "glitch-kind", Some("Glitch Type"), &fx::GLITCH_KINDS, p.glitch_kind as usize, |p, i| p.set_glitch_kind(i as u32)));
            if p.glitch_kind == 0 || p.glitch_kind == 3 {
                c = c.child(slider(l, "glitch-angle", "Angle", p.glitch_angle, fx::ANGLE, |p, v| p.glitch_angle = v));
            }
        }
        Shader::Dithering => c = c.child(select(l, "dither-kind", Some("Algorithm"), &fx::DITHER_KINDS, p.dither_kind as usize, |p, i| p.dither_kind = i as u32)),
        Shader::Ascii => {
            c = c.child(select(l, "ascii-kind", Some("Character Set"), &fx::ASCII_KINDS, p.ascii_kind as usize, |p, i| p.ascii_kind = i as u32));
            c = c.child(row().child(toggle(l, "ascii-invert", "Invert brightness", p.ascii_invert, |p| p.ascii_invert = !p.ascii_invert)));
        }
        Shader::Halftone | Shader::Melt => {}
    }
    c = c.child(slider(l, "scale", "Scale", p.scale, fx::SCALE, |p, v| p.scale = v));
    let strength = if p.shader == Shader::Glass { "Refraction" } else { "Effect Strength" };
    c = c.child(slider(l, "intensity", strength, p.intensity, fx::INTENSITY, |p, v| p.intensity = v));
    if p.shader.uses_palette() {
        let mut colors = fx::presets().get(p.palette).map(|x| x.colors.clone()).unwrap_or_default();
        if p.reverse_palette {
            colors.reverse();
        }
        c = c.child(swatches(l, fx::PALETTE_NAMES.get(p.palette).copied().unwrap_or(""), &colors));
        c = c.child(select(l, "palette", Some("Palette Presets"), &fx::PALETTE_NAMES, p.palette, |p, i| p.palette = i));
        c = c.child(
            row()
                .w_full()
                .gap(6.0)
                .child(toggle(l, "preserve", "Preserve", p.preserve_colors, |p| p.preserve_colors = !p.preserve_colors))
                .child(toggle(l, "reverse", "Reverse", p.reverse_palette, |p| p.reverse_palette = !p.reverse_palette)),
        );
    }
    c = c.child(slider(l, "size", "Size", p.size, fx::SIZE, |p, v| p.size = v));
    if p.shader.has_shape() {
        c = c.child(select(l, "shape", Some("Shape"), &fx::SHAPE_LABELS, DotShape::ALL.iter().position(|x| *x == p.shape).unwrap_or(0), |p, i| p.shape = DotShape::ALL[i]));
    }
    c
}

fn adjustments(l: &Look, p: &Params) -> El {
    col()
        .w_full()
        .gap(8.0)
        .child(slider(l, "brightness", "Brightness", p.brightness, fx::UNIT, |p, v| p.brightness = v))
        .child(slider(l, "contrast", "Contrast", p.contrast, fx::UNIT, |p, v| p.contrast = v))
        .child(slider(l, "saturation", "Saturation", p.saturation, fx::UNIT, |p, v| p.saturation = v))
        .child(slider(l, "blur", "Blur", p.blur, fx::BLUR, |p, v| p.blur = v))
}

fn post(l: &Look, s: &App, p: &Params) -> El {
    let nested = |id, title, on: bool, flip: fn(&mut Params), body: El| col().w_full().pl(8.0).child(section(l, s, id, title, Some((on, flip)), body));
    let mut grain = col().w_full().gap(8.0);
    if p.grain {
        grain = grain
            .child(slider(l, "grain-size", "Grain Size", p.grain_size, fx::GRAIN_SIZE, |p, v| p.grain_size = v))
            .child(slider(l, "grain-amt", "Grain Intensity", p.grain_intensity, fx::UNIT, |p, v| p.grain_intensity = v));
    }
    let mut bloom = col().w_full().gap(8.0);
    if p.bloom {
        bloom = bloom
            .child(slider(l, "bloom-th", "Threshold", p.bloom_threshold, fx::UNIT, |p, v| p.bloom_threshold = v))
            .child(slider(l, "bloom-amt", "Intensity", p.bloom_intensity, fx::UNIT, |p, v| p.bloom_intensity = v))
            .child(slider(l, "bloom-spread", "Spread", p.bloom_radius, fx::BLOOM_RADIUS, |p, v| p.bloom_radius = v))
            .child(slider(l, "bloom-soft", "Softness", p.bloom_softness, fx::UNIT, |p, v| p.bloom_softness = v));
    }
    let mut chroma = col().w_full().gap(8.0);
    if p.chroma {
        chroma = chroma.child(slider(l, "chroma-off", "Offset", p.chroma_offset, fx::CHROMA, |p, v| p.chroma_offset = v));
    }
    col()
        .w_full()
        .gap(4.0)
        .child(nested("grain", "Grain", p.grain, |p| p.grain = !p.grain, grain))
        .child(nested("bloom", "Bloom", p.bloom, |p| p.bloom = !p.bloom, bloom))
        .child(nested("chroma", "Chromatic Aberration", p.chroma, |p| p.chroma = !p.chroma, chroma))
}

/// Where the inspector floats: beside the selection's canvas rect, on whichever side has room,
/// held inside the canvas.
pub fn place(sel: [f32; 4], canvas: [f32; 2], top: f32) -> (f32, f32, f32) {
    const GAP: f32 = 18.0;
    const EDGE: f32 = 12.0;
    let right = sel[0] + sel[2] + GAP;
    let left = sel[0] - GAP - WIDTH;
    let x = if right + WIDTH <= canvas[0] - EDGE {
        right
    } else if left >= EDGE {
        left
    } else {
        canvas[0] - WIDTH - EDGE
    };
    // Below the titlebar band, or the top-left chrome where there is none.
    let floor = if top > 0.0 { top + EDGE } else { EDGE + 44.0 };
    let top = sel[1].clamp(floor, (canvas[1] - 420.0).max(floor));
    // Leave the bottom corner chrome clear.
    (x, top, (canvas[1] - top - 68.0).max(120.0))
}

pub fn panel(l: &Look, s: &App, p: &Params, sel: [f32; 4]) -> El {
    let (x, y, max_h) = place(sel, [s.canvas[2], s.canvas[3]], s.top_inset);
    let title = match s.selection.len() {
        1 => s.focus().map(|e| e.name.clone()).unwrap_or_default(),
        n => format!("{n} items selected"),
    };
    let inner = col().key("inspector-body").w_full().px(16.0).pb(16.0).child(body(l, s, p));
    l.floating(
        col()
            .key("inspector")
            .absolute(x, y)
            .w(WIDTH)
            .max_h(max_h)
            .radius(16.0)
            .clip_rounded(16.0)
            .instant_changes()
            .child(row().w_full().h(44.0).px(16.0).center_y().child(text(title).font(LARGE).color(l.text).truncate().grow(1.0)))
            .child(col().key("inspector-scroll").w_full().max_h(max_h - 44.0).scroll(ScrollSpec { stick_bottom: false }).scroll_edge_fade(16.0).child(inner)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspector_prefers_the_right_then_the_left_then_the_edge() {
        let canvas = [1200.0, 800.0];
        assert_eq!(place([100.0, 200.0, 300.0, 200.0], canvas, 52.0).0, 418.0);
        assert_eq!(place([800.0, 200.0, 300.0, 200.0], canvas, 52.0).0, 800.0 - 18.0 - WIDTH);
        assert_eq!(place([0.0, 200.0, 1200.0, 200.0], canvas, 52.0).0, 1200.0 - WIDTH - 12.0);
    }
}
