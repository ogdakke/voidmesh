//! The palette editor and colour picker, in the web app's shapes (`components/ui/color-palette`,
//! `components/ui/color-picker`, FEATURES.md §6.5).
//!
//! The editor: the palette's name (editable for user palettes) and count over a row of 32 pt
//! swatches that scrolls sideways under faded edges, with "+" and, for user palettes, delete at
//! its end. "Extract Palette from Image" sits under it in the inspector. Editing a preset or
//! Original forks it into "Custom N" first.
//!
//! The picker is a popover anchored under the swatch it edits (the web's `color-picker-popup`):
//! an OKLCH area (x chroma 0–0.37, y lightness), Hue and Alpha sliders, the hex value, the
//! eyedropper and Remove. A press outside or Esc closes it; one session is one undo step.

use rune::{Color, Drag, El, FileDialogOptions, Phase, TextStyle, Tx, col, el, icon, row, text, text_input};

use super::look::{Look, MEDIUM, own_gestures};
use super::widgets::{EYEDROPPER, PALETTE, PLUS, TRASH};
use crate::color::MAX_CHROMA;
use crate::effects::{MAX_COLORS, Params, Rgba, is_user_palette};
use crate::state::App;

/// Effect marks the compositor paints for the picker (see `gfx`).
pub const AREA_MARK: u32 = 3;
pub const HUE_MARK: u32 = 4;
pub const ALPHA_MARK: u32 = 5;

/// `.color-picker__swatch`: `--spacing-8`.
const SWATCH: f32 = 32.0;
/// `.color-picker-popup`: 280 wide, `--spacing-2` padding and gap, `--radius-xl`.
const POPUP_W: f32 = 280.0;
const POPUP_PAD: f32 = 8.0;
const RADIUS_XL: f32 = 16.0;
/// The OKLCH area's height.
const AREA_H: f32 = 160.0;
/// `.color-slider`: `--spacing-6` tall pills.
const TRACK_H: f32 = 24.0;
/// The area and slider thumbs: `--spacing-5`.
const THUMB: f32 = 20.0;
/// `.color-picker__value-input` and the Remove button beside the eyedropper.
const FIELD_H: f32 = 36.0;
/// The value field's type on desktop: `--text`, 500, tabular.
const VALUE: TextStyle = TextStyle::new(16.0, 500.0).features("'tnum' 1");
/// Buttons at `md`: 16, 500.
const BUTTON: TextStyle = TextStyle::new(16.0, 500.0);

fn srgb_color(c: Rgba) -> Color {
    let lin = |v: f32| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
    Color { r: lin(c[0]), g: lin(c[1]), b: lin(c[2]), a: c[3] }
}

/// A round icon button at `md` (`.ui-button` icon only): 32 pt, an 18 pt glyph.
fn round_button(key: &'static str, label: &str, glyph: &'static rune::Icon) -> El {
    el().key(key).role("button").label(label).help(label).size(32.0, 32.0).radius(16.0).center().press_scale(0.97).cursor(rune::Cursor::Pointer).child(icon(glyph, 18.0).color(Color::WHITE))
}

/// `.ui-button[data-variant="destructive"]`.
fn destructive(l: &Look, e: El) -> El {
    e.gradient(l.destructive_lighter, l.destructive).border(1.0, l.destructive.alpha(0.5))
}

/// `.color-picker__swatch`: a 32 pt circle with a faint ring, the colour over a checkerboard
/// when it's translucent.
fn swatch(l: &Look, key: String, c: Rgba) -> El {
    let mut sw = el().key(key).size(SWATCH, SWATCH).radius(SWATCH / 2.0).clip_rounded(SWATCH / 2.0).border(1.0, l.border.alpha(0.25)).press_scale(0.96);
    if c[3] < 0.999 {
        // `--checker-bg`: 12 pt cells of two greys.
        const CELL: f32 = SWATCH / 3.0;
        for i in 0..9 {
            let (x, y) = ((i % 3) as f32, (i / 3) as f32);
            sw = sw.child(el().absolute(x * CELL, y * CELL).size(CELL, CELL).fill(if (i % 3 + i / 3) % 2 == 0 { l.checker_a } else { l.checker_b }).inert());
        }
    }
    sw.child(el().absolute(0.0, 0.0).size(SWATCH, SWATCH).fill(srgb_color(c)).inert())
}

pub fn editor(l: &Look, s: &App, p: &Params) -> El {
    let pal = &p.palette;
    let user = is_user_palette(&pal.id);
    let n = pal.colors.len();
    // Shown reversed when Reverse is on; edits map back to the stored order.
    let order: Vec<usize> = if p.reverse_palette { (0..n).rev().collect() } else { (0..n).collect() };

    // `.field-label`: `--gray-900`, `--text-sm`, 500.
    let name: El = if user && s.renaming {
        text_input(&s.name_edit, MEDIUM)
            .single_line()
            .key("palette-name-edit")
            .on_edit(|s: &mut App| &mut s.name_edit)
            .on_submit(|s: &mut App, _| {
                let name = s.name_edit.text.clone();
                s.rename_palette(&name);
                s.renaming = false;
            })
            .on_input_key(|s: &mut App, k: &rune::KeyEvent, _| {
                if k.key == rune::Key::Escape {
                    s.renaming = false;
                    return true;
                }
                false
            })
            .grow(1.0)
            .color(l.text)
    } else {
        let mut t = el().key("palette-name").grow(1.0).min_w(0.0).child(text(pal.name.clone()).font(MEDIUM).color(l.text_muted).truncate());
        if user {
            t = t.role("button").label("Rename palette").help("Rename palette").cursor(rune::Cursor::Text).on_press(|s: &mut App| {
                if let Some(name) = s.focus().map(|e| e.params.palette.name.clone()) {
                    let mut edit = rune::TextEdit::new(name.clone());
                    edit.set_selection(0, name.len());
                    edit.focused = true;
                    s.name_edit = edit;
                    s.renaming = true;
                }
            });
        }
        t
    };
    let header = row().w_full().gap(8.0).center_y().child(name).child(text(format!("{n}/{MAX_COLORS}")).font(MEDIUM).color(l.text_muted));

    let swatches = order.iter().fold(row().gap(4.0).py(2.0), |r, &i| {
        let c = pal.colors[i];
        r.child(
            swatch(l, format!("swatch-{i}"), c)
                .role("button")
                .label(format!("Edit colour {}", i + 1))
                .help("Edit color")
                .cursor(rune::Cursor::Pointer)
                .on_press(move |s: &mut App| {
                    if s.picker.as_ref().is_some_and(|k| k.index == i) {
                        s.close_picker();
                    } else {
                        s.open_picker(i);
                    }
                }),
        )
    });
    // `.color-palette__colors`: one row that scrolls sideways under faded edges.
    let strip = el().key("palette-swatches").grow(1.0).min_w(0.0).scroll_x().scroll_edge_fade(16.0).child(swatches);
    let mut add = l.primary_button(round_button("palette-add", "Add color", &PLUS));
    add = if n < MAX_COLORS { add.on_press(App::add_palette_color) } else { add.dim(0.5) };
    let mut actions = row().gap(8.0).center_y().child(add);
    if user {
        let id = pal.id.clone();
        actions = actions.child(destructive(l, round_button("palette-delete", "Delete palette", &TRASH)).on_press(move |s: &mut App| s.delete_palette(&id)));
    }
    col().key("palette-editor").w_full().gap(4.0).child(header).child(row().w_full().gap(4.0).center_y().child(strip).child(actions))
}

/// "Extract Palette from Image": a quiet, small button (`PaletteUpload`).
pub fn extract_button(l: &Look) -> El {
    el().key("palette-load")
        .role("button")
        .label("Extract Palette from Image")
        .h(28.0)
        .px(12.0)
        .radius(14.0)
        .center()
        .hover(l.hover)
        .press_scale(0.97)
        .cursor(rune::Cursor::Pointer)
        .on_press_tx(load_palette)
        .child(row().gap(8.0).center_y().child(icon(&PALETTE, 16.0).color(l.text)).child(text("Extract Palette from Image").font(MEDIUM).color(l.text)))
}

pub fn load_palette(_: &mut App, tx: &mut Tx) {
    let opts = FileDialogOptions { title: "Extract a palette from an image".into(), ..Default::default() }.filter("Images", crate::media::IMAGE_EXTENSIONS);
    tx.open_file(opts, |s: &mut App, r, _| match r {
        Ok(Some(path)) => s.palette_from_image(&path),
        Ok(None) => {}
        Err(e) => s.toast(e.to_string()),
    });
}

/// A drag across a track or area: every move sets the colour (the session's undo is open).
/// Positions map through the thumb's inset, as the web's thumbs sit inside their tracks.
fn track(key: &'static str, label: &str, set: fn(&mut App, f32, f32)) -> El {
    el().key(key).role("slider").label(label).w_full().cursor(rune::Cursor::Crosshair).on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| {
        if d.phase != Phase::Up || !d.cancelled() {
            let along = |v: f32, len: f32| ((v - THUMB / 2.0) / (len - THUMB).max(1.0)).clamp(0.0, 1.0);
            set(s, along(d.x, d.w), along(d.y, d.h));
        }
        tx.instant();
    })
}

/// `.color-area__thumb` / `.color-slider__thumb`: a 20 pt white ring with a dark hairline and
/// a soft shadow, centred on (`x`, `y`).
fn thumb(x: f32, y: f32) -> El {
    let outer = THUMB + 2.0;
    el().absolute(x - outer / 2.0, y - outer / 2.0)
        .size(outer, outer)
        .radius(outer / 2.0)
        .border(1.0, Color::BLACK.alpha(0.3))
        .shadow(1.0, 3.0, Color::BLACK.alpha(0.3))
        .center()
        .inert()
        .child(el().size(THUMB, THUMB).radius(THUMB / 2.0).border(2.0, Color::WHITE))
}

/// A slider row: its `.field-label` over the track.
fn labelled(l: &Look, label: &str, track: El) -> El {
    col().w_full().gap(4.0).child(text(label).font(MEDIUM).color(l.text_muted)).child(track)
}

/// The picker popover for colour `index`, anchored under the swatch at window rect `anchor`,
/// held inside a window `window` points big, and the press-outside catcher under it.
pub fn picker(l: &Look, s: &App, anchor: [f32; 4], window: [f32; 2]) -> El {
    let Some(k) = s.picker.as_ref() else { return el() };
    let (o, index) = (k.oklch, k.index);
    let removable = s.focus().is_some_and(|e| e.params.palette.colors.len() > 2);
    let w = POPUP_W - 2.0 * POPUP_PAD;
    let inset = |t: f32, len: f32| THUMB / 2.0 + t * (len - THUMB);
    let area = track("color-area", "Colour area: drag to set lightness and chroma", |s, x, y| {
        if let Some(mut o) = s.picker.as_ref().map(|k| k.oklch) {
            (o.c, o.l) = (x * MAX_CHROMA, 1.0 - y);
            s.pick_oklch(o);
        }
    })
    .h(AREA_H)
    .radius(RADIUS_XL)
    .clip_rounded(RADIUS_XL)
    .effect(AREA_MARK)
    .child(thumb(inset((o.c / MAX_CHROMA).min(1.0), w), inset(1.0 - o.l, AREA_H)));
    let hue = track("color-hue", "Hue", |s, x, _| {
        if let Some(mut o) = s.picker.as_ref().map(|k| k.oklch) {
            o.h = x * 360.0;
            s.pick_oklch(o);
        }
    })
    .h(TRACK_H)
    .radius(TRACK_H / 2.0)
    .clip_rounded(TRACK_H / 2.0)
    .effect(HUE_MARK)
    .child(thumb(inset(o.h / 360.0, w), TRACK_H / 2.0));
    let alpha = track("color-alpha", "Opacity", |s, x, _| {
        if let Some(mut o) = s.picker.as_ref().map(|k| k.oklch) {
            o.a = (x * 100.0).round() / 100.0;
            s.pick_oklch(o);
        }
    })
    .h(TRACK_H)
    .radius(TRACK_H / 2.0)
    .clip_rounded(TRACK_H / 2.0)
    .effect(ALPHA_MARK)
    .child(thumb(inset(o.a, w), TRACK_H / 2.0));
    let value = text_input(&s.hex_edit, VALUE)
        .single_line()
        .key("color-hex")
        .label("Color value")
        .on_edit(|s: &mut App| &mut s.hex_edit)
        .on_input_change(|s: &mut App, _| s.pick_hex())
        // Return applies and leaves the field; the popover stays, as the web's.
        .on_submit(|s: &mut App, _| {
            s.pick_hex();
            s.hex_edit.focused = false;
        })
        .w_full()
        // 36 pt tall: the line and its padding, so the value sits centred.
        .px(12.0)
        .py(8.0)
        .min_h(FIELD_H)
        .radius(8.0)
        .fill(l.input)
        .color(l.text_value);
    let mut actions = row().key("color-actions").w_full().gap(8.0).center_y().justify_between();
    if crate::eyedropper::AVAILABLE {
        actions = actions.child(l.primary_button(round_button("color-eyedropper", "Pick color from screen", &EYEDROPPER)).on_press_tx(|s: &mut App, _| crate::eyedropper::sample(&s.loader)));
    }
    if removable {
        let remove = el()
            .key("color-remove")
            .role("button")
            .label("Remove color")
            .grow(1.0)
            .h(FIELD_H)
            .radius(FIELD_H / 2.0)
            .center()
            .press_scale(0.97)
            .cursor(rune::Cursor::Pointer)
            .on_press(move |s: &mut App| s.remove_palette_color(index))
            .child(text("Remove").font(BUTTON).color(Color::WHITE));
        actions = actions.child(destructive(l, remove));
    }
    let footer = col().w_full().gap(12.0).child(value).child(actions);
    let popup = col()
        .key("color-picker")
        .w(POPUP_W)
        .px(POPUP_PAD)
        .py(POPUP_PAD)
        .gap(8.0)
        .radius(RADIUS_XL)
        .child(area)
        .child(labelled(l, "Hue", hue))
        .child(labelled(l, "Alpha", alpha))
        .child(footer);
    // Under the swatch, 8 pt off, its left edge on the swatch's; above it when there's no
    // room below; always inside the window.
    const EDGE: f32 = 12.0;
    let h = popup_height(crate::eyedropper::AVAILABLE || removable);
    let below = anchor[1] + anchor[3] + 8.0;
    let y = if below + h <= window[1] - EDGE { below } else { (anchor[1] - 8.0 - h).max(EDGE) };
    let x = anchor[0].clamp(EDGE, (window[0] - POPUP_W - EDGE).max(EDGE));
    let catcher = el().key("color-picker-dismiss").absolute(0.0, 0.0).w_full().h_full().on_press(App::close_picker).on_drag(|s: &mut App, d: &mut Drag, _: &mut Tx| {
        if d.phase == Phase::Down {
            s.close_picker();
        }
    });
    el().key("color-picker-layer").absolute(0.0, 0.0).w_full().h_full().child(catcher).child(el().absolute(x, y).child(own_gestures(l.floating(popup))))
}

/// The popover's height: padding, area, two labelled sliders, the value field and the actions.
fn popup_height(actions: bool) -> f32 {
    let label = 18.0 + 4.0;
    2.0 * POPUP_PAD + AREA_H + 8.0 + 2.0 * (label + TRACK_H + 8.0) + FIELD_H + if actions { 12.0 + FIELD_H } else { 0.0 }
}
