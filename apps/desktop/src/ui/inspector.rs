//! The inspector: the web app's right sidebar controls, in its order, as a floating surface that
//! rides beside the selection. It edits every selected entity at once; values show the first.

use rune::{El, ScrollSpec, col, row, text};

use super::look::{LARGE, Look, MEDIUM};
use super::widgets::{button, section, select, select_ids, slider, toggle};
use crate::effects::{self as fx, DotShape, Params, Shader};
use super::tick_slider::{Hooks, Source, TickSlider, time_control};
use crate::state::App;

/// `--sidebar-width`-ish: the web inspector is 280–320 px.
pub const WIDTH: f32 = 300.0;

/// Reads over the selection: what the controls show when it holds several entities.
#[derive(Clone, Copy)]
struct Sel<'a> {
    s: &'a App,
    /// The first selected entity's params: the values shown where the selection agrees.
    p: &'a Params,
}

impl Sel<'_> {
    /// The selection disagrees on `get`.
    fn mixed<T: PartialEq>(self, get: impl Fn(&Params) -> T) -> bool {
        let first = get(self.p);
        self.s.selected().any(|e| get(&e.params) != first)
    }

    /// Every selected entity has `f`: the web shows a control only then.
    fn all(self, f: impl Fn(&Params) -> bool) -> bool {
        self.s.selected().all(|e| f(&e.params))
    }

    /// What the selection agrees on, if it does.
    fn agreed<T: PartialEq>(self, get: impl Fn(&Params) -> T) -> Option<T> {
        if self.mixed(&get) { None } else { Some(get(self.p)) }
    }

    /// A select's current index, past the options when mixed (it then reads "Mixed").
    fn index(self, get: fn(&Params) -> usize) -> usize {
        self.agreed(get).unwrap_or(usize::MAX)
    }

    fn slider(self, l: &Look, key: &'static str, label: &str, get: fn(&Params) -> f32, r: fx::Range, set: fn(&mut Params, f32)) -> El {
        slider(l, self.s, key, label, get(self.p), self.mixed(get), r, set)
    }

    fn toggle(self, l: &Look, key: &'static str, label: &str, get: fn(&Params) -> bool, set: fn(&mut Params, bool)) -> El {
        toggle(l, key, label, self.all(get), set)
    }

    /// A section checkbox's state: `None` when mixed.
    fn check(self, get: fn(&Params) -> bool) -> Option<bool> {
        self.agreed(get)
    }
}

pub fn body(l: &Look, s: &App, p: &Params) -> El {
    let q = Sel { s, p };
    let shader = q.index(|p| Shader::ALL.iter().position(|x| *x == p.shader).unwrap_or(0));
    col()
        .w_full()
        .gap(12.0)
        .child(select(l, "shader", Some("Style"), &fx::SHADER_LABELS, shader, |p, i| p.set_shader(Shader::ALL[i])))
        .child(row().w_full().gap(6.0).child(q.toggle(l, "original", "Original", |p| p.show_original, |p, v| p.show_original = v)).child(button(l, "reset", "Reset", App::reset_selection)))
        .child(section(l, s, "adjust", "Adjustments", None, adjustments(l, q)))
        .child(section(l, s, "style", "Style Parameters", None, style(l, q)))
        .child(section(l, s, "post", "Post Processing", None, post(l, q)))
}

/// Whether `p`'s effect has a Scale (the web's `paramVisibilityRules`): not for Channel Shift
/// glitches or the error-diffusion dithering kinds.
fn has_scale(p: &Params) -> bool {
    match p.shader {
        Shader::Glitch => p.glitch_kind != 0,
        Shader::Dithering => (p.dither_kind as usize) < fx::DITHER_KINDS.len(),
        _ => true,
    }
}

/// The style controls every selected entity has, in the web's order.
fn style(l: &Look, q: Sel) -> El {
    let (s, p) = (q.s, q.p);
    let mut c = col().w_full().gap(8.0);
    match q.agreed(|p| p.shader) {
        Some(Shader::Blobs) => c = c.child(q.slider(l, "eagerness", "Eagerness", |p| p.eagerness, fx::UNIT, |p, v| p.eagerness = v)),
        Some(Shader::Glass) => {
            c = c.child(select(l, "glass-kind", Some("Glass Type"), &fx::GLASS_KINDS, q.index(|p| p.glass_kind as usize), |p, i| p.set_glass_kind(i as u32)));
            match q.agreed(|p| p.glass_kind) {
                Some(0) => {
                    c = c.child(q.slider(l, "angle", "Angle", |p| p.glass_angle, fx::ANGLE, |p, v| p.glass_angle = v));
                    c = c.child(q.slider(l, "caustic", "Caustic", |p| p.caustic, fx::CAUSTIC, |p, v| p.caustic = v));
                }
                Some(1) => {
                    c = c.child(q.slider(l, "frost", "Frostiness", |p| p.frostiness, fx::UNIT, |p, v| p.frostiness = v));
                    c = c.child(q.slider(l, "highlight", "Highlight", |p| p.highlight, fx::UNIT, |p, v| p.highlight = v));
                }
                Some(_) => c = c.child(q.slider(l, "flow", "Flow", |p| p.flow, fx::UNIT, |p, v| p.flow = v)),
                None => {}
            }
            c = c.child(q.slider(l, "dispersion", "Dispersion", |p| p.dispersion, fx::UNIT, |p, v| p.dispersion = v));
        }
        Some(Shader::Glitch) => {
            c = c.child(select(l, "glitch-kind", Some("Glitch Type"), &fx::GLITCH_KINDS, q.index(|p| p.glitch_kind as usize), |p, i| p.set_glitch_kind(i as u32)));
            if q.all(|p| p.glitch_kind == 0 || p.glitch_kind == 3) {
                c = c.child(q.slider(l, "glitch-angle", "Angle", |p| p.glitch_angle, fx::ANGLE, |p, v| p.glitch_angle = v));
            }
        }
        Some(Shader::Dithering) => c = c.child(select(l, "dither-kind", Some("Algorithm"), &fx::DITHER_KINDS, q.index(|p| p.dither_kind as usize), |p, i| p.dither_kind = i as u32)),
        Some(Shader::Ascii) => {
            c = c.child(select(l, "ascii-kind", Some("Character Set"), &fx::ASCII_KINDS, q.index(|p| p.ascii_kind as usize), |p, i| p.ascii_kind = i as u32));
            c = c.child(row().child(q.toggle(l, "ascii-invert", "Invert brightness", |p| p.ascii_invert, |p, v| p.ascii_invert = v)));
        }
        Some(Shader::Halftone | Shader::Melt) | None => {}
    }
    if q.all(has_scale) {
        c = c.child(q.slider(l, "scale", "Scale", |p| p.scale, fx::SCALE, |p, v| p.scale = v));
    }
    let strength = if q.all(|p| p.shader == Shader::Glass) { "Refraction" } else { "Effect Strength" };
    c = c.child(q.slider(l, "intensity", strength, |p| p.intensity, fx::INTENSITY, |p, v| p.intensity = v));
    if q.all(|p| p.shader.uses_palette()) {
        let mixed = q.mixed(|p| p.palette.id.clone());
        c = c.child(if mixed { row().key("palette-mixed").w_full().py(8.0).child(text("Mixed palettes").font(MEDIUM).color(l.text_muted)) } else { super::palette_editor::editor(l, s, p) });
        c = c.child(select_ids(l, "palette", Some("Palette Presets"), s.palette_options(), if mixed { "" } else { &p.palette.id }, |s, id| s.set_palette(&id)));
        c = c.child(
            row()
                .w_full()
                .gap(6.0)
                .child(q.toggle(l, "preserve", "Preserve", |p| p.preserve_colors, |p, v| p.preserve_colors = v))
                .child(q.toggle(l, "reverse", "Reverse", |p| p.reverse_palette, |p, v| p.reverse_palette = v)),
        );
    }
    c = c.child(q.slider(l, "size", "Size", |p| p.size, fx::SIZE, |p, v| p.size = v));
    if q.all(|p| p.shader.has_shape()) {
        c = c.child(select(l, "shape", Some("Shape"), &fx::SHAPE_LABELS, q.index(|p| DotShape::ALL.iter().position(|x| *x == p.shape).unwrap_or(0)), |p, i| p.shape = DotShape::ALL[i]));
    }
    c
}

fn adjustments(l: &Look, q: Sel) -> El {
    col()
        .w_full()
        .gap(8.0)
        .child(q.slider(l, "brightness", "Brightness", |p| p.brightness, fx::UNIT, |p, v| p.brightness = v))
        .child(q.slider(l, "contrast", "Contrast", |p| p.contrast, fx::UNIT, |p, v| p.contrast = v))
        .child(q.slider(l, "saturation", "Saturation", |p| p.saturation, fx::UNIT, |p, v| p.saturation = v))
        .child(q.slider(l, "blur", "Blur", |p| p.blur, fx::BLUR, |p, v| p.blur = v))
}

fn post(l: &Look, q: Sel) -> El {
    let s = q.s;
    let nested = |id, title, get: fn(&Params) -> bool, set: fn(&mut Params, bool), body: El| col().w_full().pl(8.0).child(section(l, s, id, title, Some((q.check(get), set)), body));
    // A sub-effect's sliders show while any selected entity has it on.
    let any = |get: fn(&Params) -> bool| s.selected().any(|e| get(&e.params));
    let mut grain = col().w_full().gap(8.0);
    if any(|p| p.grain) {
        grain = grain
            .child(q.slider(l, "grain-size", "Grain Size", |p| p.grain_size, fx::GRAIN_SIZE, |p, v| p.grain_size = v))
            .child(q.slider(l, "grain-amt", "Grain Intensity", |p| p.grain_intensity, fx::UNIT, |p, v| p.grain_intensity = v));
    }
    let mut bloom = col().w_full().gap(8.0);
    if any(|p| p.bloom) {
        bloom = bloom
            .child(q.slider(l, "bloom-th", "Threshold", |p| p.bloom_threshold, fx::UNIT, |p, v| p.bloom_threshold = v))
            .child(q.slider(l, "bloom-amt", "Intensity", |p| p.bloom_intensity, fx::UNIT, |p, v| p.bloom_intensity = v))
            .child(q.slider(l, "bloom-spread", "Spread", |p| p.bloom_radius, fx::BLOOM_RADIUS, |p, v| p.bloom_radius = v))
            .child(q.slider(l, "bloom-soft", "Softness", |p| p.bloom_softness, fx::UNIT, |p, v| p.bloom_softness = v));
    }
    let mut chroma = col().w_full().gap(8.0);
    if any(|p| p.chroma) {
        chroma = chroma.child(q.slider(l, "chroma-off", "Offset", |p| p.chroma_offset, fx::CHROMA, |p, v| p.chroma_offset = v));
    }
    col()
        .w_full()
        .gap(4.0)
        .child(nested("grain", "Grain", |p| p.grain, |p, v| p.grain = v, grain))
        .child(nested("bloom", "Bloom", |p| p.bloom, |p, v| p.bloom = v, bloom))
        .child(nested("chroma", "Chromatic Aberration", |p| p.chroma, |p, v| p.chroma = v, chroma))
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

fn time_slider(s: &mut App) -> &mut TickSlider {
    &mut s.time_slider
}

fn time_changed(s: &mut App, t: f64) {
    s.set_effect_time(t);
}

fn time_committed(_: &mut App, _: f64) {}

/// The Time control's callbacks; `poll` steps the slider with the same ones.
pub const TIME_HOOKS: Hooks<App> = Hooks { access: time_slider, on_start: App::begin_effect_time, on_change: time_changed, on_commit: time_committed };

/// What drives the Time control this frame.
pub fn time_source(s: &App) -> Source {
    match s.effect_time() {
        None => Source::Hidden,
        Some((t, true, false)) => Source::Driven(t),
        Some((t, ..)) => Source::Value(t),
    }
}

pub fn panel(l: &Look, s: &App, p: &Params, sel: [f32; 4]) -> El {
    let (x, y, max_h) = place(sel, [s.canvas[2], s.canvas[3]], s.top_inset);
    let title = match s.selection.len() {
        1 => s.focus().map(|e| e.name.clone()).unwrap_or_default(),
        n => format!("{n} items selected"),
    };
    let inner = col().key("inspector-body").w_full().px(16.0).pb(16.0).child(body(l, s, p));
    // The inspector's footer: Flowing glass's Time, as the web's desktop time slider.
    let time = s.effect_time().map(|(t, playing, mixed)| col().w_full().pt(4.0).child(time_control(l, mixed, playing, t, &s.time_slider, TIME_HOOKS, App::toggle_effect_time)));
    let footer = if time.is_some() { 84.0 } else { 0.0 };
    let mut panel = col()
            .key("inspector")
            .absolute(x, y)
            .w(WIDTH)
            .max_h(max_h)
            .radius(16.0)
            .clip_rounded(16.0)
            .instant_changes()
            .child(row().w_full().h(44.0).px(16.0).center_y().child(text(title).font(LARGE).color(l.text).truncate().grow(1.0)))
            .child(col().key("inspector-scroll").w_full().max_h(max_h - 44.0 - footer).scroll(ScrollSpec { stick_bottom: false }).scroll_edge_fade(16.0).child(inner));
    if let Some(t) = time {
        panel = panel.child(t);
    }
    l.floating(panel)
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
