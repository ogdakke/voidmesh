//! The palette editor and colour picker in the inspector (FEATURES.md §6.5): the palette's name
//! (editable for user palettes), its count, swatches to pick, "+" to add, delete for user
//! palettes and Load… to extract one from an image. Editing a preset or Original forks it into
//! "Custom N" first. The picker opens in place under the swatches (no popover window): an OKLCH
//! area (x chroma 0–0.37, y lightness), hue and alpha sliders, a hex field and Remove. One picker
//! session is one undo step.

use rune::{Color, Drag, El, FileDialogOptions, Phase, Tx, col, el, icon, row, text, text_input};

use super::look::{Look, MEDIUM, NUMBER, SMALL};
use super::widgets::{PLUS, TRASH, icon_button};
use crate::color::{MAX_CHROMA, Oklch};
use crate::effects::{MAX_COLORS, Params, Rgba, is_user_palette};
use crate::state::App;

/// Effect marks the compositor paints for the picker (see `gfx`).
pub const AREA_MARK: u32 = 3;
pub const HUE_MARK: u32 = 4;
pub const ALPHA_MARK: u32 = 5;

const SWATCH: f32 = 32.0;
const AREA_H: f32 = 150.0;
const TRACK_H: f32 = 14.0;

fn srgb_color(c: Rgba) -> Color {
    let lin = |v: f32| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
    Color { r: lin(c[0]), g: lin(c[1]), b: lin(c[2]), a: c[3] }
}

pub fn editor(l: &Look, s: &App, p: &Params) -> El {
    let pal = &p.palette;
    let user = is_user_palette(&pal.id);
    let n = pal.colors.len();
    // Shown reversed when Reverse is on; edits map back to the stored order.
    let order: Vec<usize> = if p.reverse_palette { (0..n).rev().collect() } else { (0..n).collect() };
    let picked = s.picker.as_ref().map(|k| k.index);

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
            .w(180.0)
            .color(l.text)
    } else {
        let mut t = el().key("palette-name").child(text(pal.name.clone()).font(SMALL).color(l.text_muted));
        if user {
            t = t.role("button").label("Rename palette").help("Rename").cursor(rune::Cursor::Text).on_press(|s: &mut App| {
                if let Some(name) = s.focus().map(|e| e.params.palette.name.clone()) {
                    s.name_edit = rune::TextEdit::new(name);
                    s.renaming = true;
                }
            });
        }
        t
    };
    let header = row().w_full().justify_between().center_y().child(name).child(text(format!("{n}/{MAX_COLORS}")).font(SMALL).color(l.text_faint));

    let swatches = order.iter().fold(row().gap(4.0).flex_wrap(), |r, &i| {
        let c = pal.colors[i];
        let mut sw = el()
            .key(format!("swatch-{i}"))
            .role("button")
            .label(format!("Edit colour {}", i + 1))
            .help(crate::color::hex(c))
            .size(SWATCH, SWATCH)
            .radius(SWATCH / 2.0)
            .border(1.0, l.border)
            .fill(srgb_color(c))
            .press_scale(0.94)
            .cursor(rune::Cursor::Pointer)
            .on_press(move |s: &mut App| {
                if s.picker.as_ref().is_some_and(|k| k.index == i) {
                    s.close_picker();
                } else {
                    s.open_picker(i);
                }
            });
        if picked == Some(i) {
            sw = sw.border(2.0, l.primary);
        }
        r.child(sw)
    });
    let mut add = l.primary_button(
        el().key("palette-add").role("button").label("Add colour").help("Add colour").size(28.0, 28.0).radius(14.0).center().press_scale(0.97).cursor(rune::Cursor::Pointer).child(icon(&PLUS, 15.0).color(Color::WHITE)),
    );
    if n < MAX_COLORS {
        add = add.on_press(App::add_palette_color);
    } else {
        add = add.dim(0.5);
    }
    let load = el()
        .key("palette-load")
        .role("button")
        .label("Load palette from an image")
        .help("Take colours from an image")
        .h(28.0)
        .px(10.0)
        .radius(14.0)
        .center()
        .hover(l.hover)
        .cursor(rune::Cursor::Pointer)
        .on_press_tx(load_palette)
        .child(text("Load…").font(MEDIUM).color(l.text_strong));
    let mut actions = row().gap(4.0).center_y().child(add).child(load);
    if user {
        let id = pal.id.clone();
        actions = actions.child(icon_button(l, "palette-delete", "Delete palette", &TRASH, move |s, _| s.delete_palette(&id)));
    }
    let mut c = col().w_full().gap(8.0).child(header).child(swatches).child(actions);
    if let Some(k) = &s.picker {
        c = c.child(picker(l, s, k.oklch, n > 2, k.index));
    }
    c
}

pub fn load_palette(_: &mut App, tx: &mut Tx) {
    let opts = FileDialogOptions { title: "Take a palette from an image".into(), ..Default::default() }.filter("Images", crate::media::IMAGE_EXTENSIONS);
    tx.open_file(opts, |s: &mut App, r, _| match r {
        Ok(Some(path)) => s.palette_from_image(&path),
        Ok(None) => {}
        Err(e) => s.toast(e.to_string()),
    });
}

/// A drag across a track or area: every move sets the colour (the session's undo is open).
fn track(key: &'static str, label: &str, w_full: bool, set: fn(&mut App, f32, f32)) -> El {
    let e = el().key(key).role("slider").label(label).cursor(rune::Cursor::Crosshair).on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| {
        if d.phase != Phase::Up || !d.cancelled() {
            set(s, (d.x / d.w.max(1.0)).clamp(0.0, 1.0), (d.y / d.h.max(1.0)).clamp(0.0, 1.0));
        }
        tx.instant();
    });
    if w_full { e.w_full() } else { e }
}

fn knob(l: &Look, x: f32, y: f32, c: Rgba) -> El {
    el().absolute(x - 8.0, y - 8.0).size(16.0, 16.0).radius(8.0).border(2.0, Color::WHITE).fill(srgb_color([c[0], c[1], c[2], 1.0])).shadow(1.0, 3.0, l.shadow).inert()
}

fn picker(l: &Look, s: &App, o: Oklch, removable: bool, index: usize) -> El {
    let c = crate::color::to_rgba(o);
    let w = super::inspector::WIDTH - 32.0;
    let area = track("color-area", "Colour area: lightness and chroma", true, |s, x, y| {
        if let Some(mut o) = s.picker.as_ref().map(|k| k.oklch) {
            (o.c, o.l) = (x * MAX_CHROMA, 1.0 - y);
            s.pick_oklch(o);
        }
    })
    .h(AREA_H)
    .radius(10.0)
    .clip_rounded(10.0)
    .effect(AREA_MARK)
    .child(knob(l, (o.c / MAX_CHROMA).min(1.0) * w, (1.0 - o.l) * AREA_H, c));
    let hue = track("color-hue", "Hue", true, |s, x, _| {
        if let Some(mut o) = s.picker.as_ref().map(|k| k.oklch) {
            o.h = x * 360.0;
            s.pick_oklch(o);
        }
    })
    .h(TRACK_H)
    .radius(TRACK_H / 2.0)
    .clip_rounded(TRACK_H / 2.0)
    .effect(HUE_MARK)
    .child(knob(l, o.h / 360.0 * w, TRACK_H / 2.0, crate::color::to_rgba(Oklch { l: 0.75, c: 0.15, h: o.h, a: 1.0 })));
    let alpha = track("color-alpha", "Alpha", true, |s, x, _| {
        if let Some(mut o) = s.picker.as_ref().map(|k| k.oklch) {
            o.a = (x * 100.0).round() / 100.0;
            s.pick_oklch(o);
        }
    })
    .h(TRACK_H)
    .radius(TRACK_H / 2.0)
    .clip_rounded(TRACK_H / 2.0)
    .effect(ALPHA_MARK)
    .child(knob(l, o.a * w, TRACK_H / 2.0, c));
    let hex = text_input(&s.hex_edit, NUMBER)
        .single_line()
        .key("color-hex")
        .label("Hex colour")
        .on_edit(|s: &mut App| &mut s.hex_edit)
        .on_input_change(|s: &mut App, _| s.pick_hex())
        .on_submit(|s: &mut App, _| s.close_picker())
        .grow(1.0)
        .h(32.0)
        .px(12.0)
        .radius(10.0)
        .fill(l.surface)
        .border(1.0, l.field_border)
        .color(l.text);
    let mut foot = row().w_full().gap(6.0).center_y().child(hex);
    if removable {
        foot = foot.child(icon_button(l, "color-remove", "Remove colour", &TRASH, move |s, _| s.remove_palette_color(index)));
    }
    let done = el().key("color-done").role("button").label("Done").h(28.0).px(12.0).radius(14.0).center().border(1.0, l.border).fill(l.surface).hover(l.hover).cursor(rune::Cursor::Pointer).on_press(App::close_picker).child(text("Done").font(MEDIUM).color(l.text));
    col().key("color-picker").w_full().gap(10.0).pt(4.0).child(area).child(hue).child(alpha).child(foot.child(done))
}
