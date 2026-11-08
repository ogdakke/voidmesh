//! The view. The canvas fills the window and everything else floats on it, in the web app's
//! styling: chrome at the corners (Add and the workspace tabs top-left, undo/redo bottom-left, view
//! controls and the zoom readout bottom-right), and the selection's own controls riding along
//! with it (its label bar above, the inspector beside, playback on the GIF itself).

mod canvas;
pub mod export_panel;
pub mod inspector;
pub mod library;
mod menu;
pub mod palette_editor;
pub mod settings;
pub mod look;
pub mod tick_slider;
pub mod tabs;
mod widgets;

use rune::{Color, Cx, El, FileDialogOptions, TextStyle, Tx, col, el, icon, row, text};

use crate::state::App;
use look::{Look, MEDIUM, SMALL};
use widgets::{COPY, EYE, FIT, GEAR, MUTED, PAUSE, PLAY, PLUS, REDO, SAVE, SOUND, TRASH, UNDO, icon_button};

/// The zoom readout is mono and tabular in the web app.
const MONO: TextStyle = TextStyle::new(13.0, 500.0).mono().features("tnum");
/// The media time label, a size under body text, with tabular digits.
const TIME: TextStyle = TextStyle::new(12.0, 400.0).features("tnum");
/// Room per character of a time label (12 pt tabular digits, with headroom for the colons).
const TIME_CHAR: f32 = 7.5;

pub fn view(s: &App, cx: &mut Cx<App>) -> El {
    let dark = cx.system_dark();
    let l = Look::new(dark);
    let insets = cx.chrome_insets();
    let mut root = el().key("root").on_key_up(crate::keys::on_key_up).on_paste_content(|s: &mut App, c: &rune::ClipboardContent, _: &mut Tx| crate::clip::paste(s, c)).w_full().h_full().fill(l.studio);
    root = root.child(canvas::surface(&l, s));
    if s.entities.is_empty() {
        root = root.child(empty_state(&l));
    }
    // The titlebar band: it moves the window, and floating UI keeps out of it. Under the chrome
    // it's a frosted bar, so the tabs read over busy media.
    let mut band = el().key("titlebar").absolute(0.0, 0.0).w_full().h(insets.height).window_drag().on_layout(|s: &mut App, r| s.top_inset = r[3]);
    if !s.bare && insets.height > 0.0 {
        band = band.backdrop_blur(16.0).fill(l.bar).child(el().absolute(0.0, insets.height - 1.0).w_full().h(1.0).fill(l.border).inert());
    }
    root = root.child(band);
    // `\` hides the chrome: the canvas alone, as the web's fullscreen.
    if let Some(sel) = s.bounds(&s.selection).filter(|_| !s.bare) {
        let r = s.cam.screen_rect(sel);
        if s.drag.as_ref().is_none_or(|m| !m.moved) && s.marquee.is_none() {
            root = root.child(entity_bar(&l, s, r, insets.height));
            if let Some(p) = s.focus().map(|e| e.params.clone()) {
                root = root.child(inspector::panel(&l, s, &p, r));
            }
        }
        if s.selection.len() == 1
            && let Some(e) = s.focus().filter(|e| e.asset.animated())
        {
            root = root.child(media_controls(&l, e, r));
        }
        // Over the playback bar it may hang across.
        if s.drag.as_ref().is_none_or(|m| !m.moved)
            && s.marquee.is_none()
            && let Some(panel) = export_panel::panel(&l, s, r, insets.height)
        {
            root = root.child(panel);
        }
    }
    if !s.bare {
        root = root.child(top_left(&l, s, insets)).child(bottom_left(&l, s)).child(bottom_right(&l, s, cx.env().scale));
    }
    if s.drop_hover {
        // `[data-drop-target]`: a 2 px primary outline inset into the canvas.
        root = root.child(el().key("drop").absolute(0.0, 0.0).w_full().h_full().p_all(4.0).inert().child(el().w_full().h_full().radius(16.0).border(2.0, l.primary)));
    }
    if s.settings {
        root = root.child(settings::view(&l, s, insets.height, dark)).child(el().key("titlebar-over").absolute(0.0, 0.0).w_full().h(insets.height).window_drag());
    } else if let Some(list) = &s.library {
        root = root.child(library::view(&l, s, list, insets.height)).child(el().key("titlebar-over").absolute(0.0, 0.0).w_full().h(insets.height).window_drag());
    }
    if let Some(t) = s.toasts.last() {
        root = root.child(
            row()
                .key("toast")
                .absolute(0.0, 0.0)
                .w_full()
                .h_full()
                .justify_center()
                .items_end()
                .pb(64.0)
                .inert()
                .child(l.floating(row().px(16.0).h(40.0).center_y().radius(12.0).child(text(t.text.clone()).font(MEDIUM).color(l.text)))),
        );
    }
    root
}

trait PadAll {
    fn p_all(self, v: f32) -> Self;
}

impl PadAll for El {
    fn p_all(self, v: f32) -> Self {
        self.px(v).py(v)
    }
}

/// Everything the canvas takes: media and workspaces.
pub fn accepted_extensions() -> Vec<&'static str> {
    [crate::media::IMAGE_EXTENSIONS, crate::media::VIDEO_EXTENSIONS, crate::workspace::EXTENSIONS].concat()
}

/// Add and ⌘O: a workspace opens, media lands on the canvas.
pub fn open_any(_: &mut App, tx: &mut Tx) {
    let opts = FileDialogOptions { title: "Open".into(), ..Default::default() }.filter("Media and workspaces", &accepted_extensions());
    tx.open_file(opts, |s: &mut App, r, _| match r {
        Ok(Some(path)) => s.import(vec![path], None),
        Ok(None) => {}
        Err(e) => s.toast(e.to_string()),
    });
}

/// ⌘S: workspaces save as they change; this saves now and says so.
pub fn save(s: &mut App) {
    if s.saver.is_none() {
        return s.toast("Workspaces aren't kept in this run");
    }
    s.persist_if_dirty();
    s.toast("Saved. Changes save as you work");
}

/// ⇧⌘S: write the workspace to a `.vdmsh` file, which the web app opens too.
pub fn export_workspace(s: &mut App, tx: &mut Tx) {
    if s.entities.is_empty() {
        return s.toast("Nothing to export");
    }
    let opts = FileDialogOptions { title: "Export workspace".into(), file_name: Some(format!("{}.vdmsh", s.tab().name)), ..Default::default() }.filter("Voidmesh workspace", &["vdmsh"]);
    tx.save_file(opts, |s: &mut App, r, _| match r {
        Ok(Some(mut path)) => {
            if path.extension().is_none() {
                path.set_extension("vdmsh");
            }
            s.export_workspace(path);
        }
        Ok(None) => {}
        Err(e) => s.toast(e.to_string()),
    });
}

pub fn export_selected(s: &mut App, tx: &mut Tx) {
    export_selected_as(s, tx, "png");
}

/// Save the focused entity's rendered image; the dialog starts on `ext` (png or jpg).
pub fn export_selected_as(s: &mut App, tx: &mut Tx, ext: &str) {
    let Some(e) = s.focus() else { return };
    let id = e.id;
    let stem = e.name.rsplit_once('.').map(|(a, _)| a.to_string()).unwrap_or_else(|| e.name.clone());
    let base = FileDialogOptions { title: "Save image".into(), file_name: Some(format!("{stem}.{ext}")), ..Default::default() };
    let opts = if ext == "png" { base.filter("PNG", &["png"]).filter("JPEG", &["jpg", "jpeg"]) } else { base.filter("JPEG", &["jpg", "jpeg"]).filter("PNG", &["png"]) };
    tx.save_file(opts, move |s: &mut App, r, _| match r {
        Ok(Some(path)) => s.exports.push(crate::state::Export { entity: id, path: Some(path) }),
        Ok(None) => {}
        Err(e) => s.toast(e.to_string()),
    });
}

/// A small secondary pill (`.ui-button[data-size="sm"]`): 28 pt, hairline, surface fill.
fn pill(l: &Look, e: El) -> El {
    look::own_gestures(e).h(28.0).radius(14.0).border(1.0, l.border).fill(l.surface).shadow(4.0, 12.0, Color::BLACK.alpha(0.07))
}

/// Add and the workspace tabs, in the titlebar band beside the traffic lights.
fn top_left(l: &Look, s: &App, insets: rune::ChromeInsets) -> El {
    let add = l.primary_button(
        el().key("add")
            .role("button")
            .label("Add")
            .focusable(true)
            .h(28.0)
            .px(12.0)
            .radius(14.0)
            .center()
            .press_scale(0.97)
            .cursor(rune::Cursor::Pointer)
            .on_press_tx(open_any)
            .child(row().gap(6.0).center_y().child(icon(&PLUS, 15.0).color(Color::WHITE)).child(text("Add").font(MEDIUM).color(Color::WHITE))),
    );
    let (x, y) = if insets.height > 0.0 { (insets.leading + 12.0, (insets.height - 28.0) / 2.0) } else { (12.0, 12.0) };
    // The tabs take what the titlebar has left after Add and room for progress, short of the
    // window's right edge.
    let add_w = 12.0 + 15.0 + 6.0 + rune::text::measure("Add", &[], MEDIUM, None).0 + 12.0;
    let busy = if s.loading().is_some() || s.pending > 0 { 220.0 } else { 0.0 };
    let room = s.canvas[2] - x - add_w - 10.0 - busy - 24.0;
    let mut r = look::own_gestures(row().key("top-left")).absolute(x, y).gap(10.0).center_y().child(add).child(tabs::strip(l, s, room));
    if let Some(p) = tabs::progress(l, s) {
        r = r.child(p);
    } else if s.pending > 0 {
        r = r.child(text(format!("Importing {}…", s.pending)).font(SMALL).color(l.text_muted));
    }
    r
}

/// `.undo-redo`: one pill holding both buttons.
fn bottom_left(l: &Look, s: &App) -> El {
    let b = |key: &'static str, label: &'static str, glyph: &'static rune::Icon, enabled: bool, f: fn(&mut App)| {
        let mut e = el().key(key).role("button").label(label).size(28.0, 28.0).center().cursor(rune::Cursor::Pointer).help(label).child(icon(glyph, 16.0).color(if enabled { l.text } else { l.text_muted.alpha(0.6) }));
        if enabled {
            e = e.on_press(f);
        }
        e
    };
    let group = pill(l, row().key("undo-redo").gap(8.0).px(2.0).center_y().child(b("undo", "Undo (⌘Z)", &UNDO, !s.undo.is_empty(), |s| {
        s.undo();
    })).child(b("redo", "Redo (⇧⌘Z)", &REDO, !s.redo.is_empty(), |s| {
        s.redo();
    })));
    let r = row().key("bottom-left").pin(Some(12.0), None, None, Some(12.0)).gap(8.0).items_end().child(group);
    match export_panel::queue(l, s) {
        Some(q) => r.child(q),
        None => r,
    }
}

fn bottom_right(l: &Look, s: &App, device_scale: f32) -> El {
    let pct = (s.cam.scale * device_scale * 100.0).round();
    let toggle = |key: &'static str, label: &str, help: &'static str, on: bool, f: fn(&mut App)| {
        let mut e = pill(l, el().key(key).role("switch").label(help).checked(on).px(12.0).center().hover(l.hover).press_scale(0.97).cursor(rune::Cursor::Pointer).help(help).on_press(f).child(text(label.to_string()).font(MEDIUM).color(if on { l.text } else { l.text_muted })));
        if on {
            e = e.border(1.0, l.pressed_ring);
        }
        e
    };
    let mut center = pill(l, el().key("fit").role("button").label("Center selection in view (F)").size(28.0, 28.0).center().hover(l.hover).cursor(rune::Cursor::Pointer).help("Center selection in view (F)").child(icon(&FIT, 15.0).color(l.text)));
    if !s.selection.is_empty() {
        center = center.on_press(|s: &mut App| s.fit_selection());
    } else {
        center = center.dim(0.5);
    }
    let zoom = pill(
        l,
        el().key("zoom").role("button").label("Zoom to 100%").px(10.0).center().hover(l.hover).press_scale(0.97).cursor(rune::Cursor::Pointer).help("Zoom to 100% (⌘0)").on_press(move |s: &mut App| s.reset_zoom(device_scale)).child(text(format!("{pct}%")).font(MONO).color(l.text)),
    );
    let gear = pill(l, el().key("settings-open").role("button").label("Settings (⌘,)").size(28.0, 28.0).center().hover(l.hover).cursor(rune::Cursor::Pointer).help("Settings (⌘,)").on_press(settings::toggle).child(icon(&GEAR, 16.0).color(l.text)));
    let mut r = row().key("bottom-right").pin(None, None, Some(12.0), Some(12.0)).gap(8.0).center_y();
    // Only what's on shows here; Settings holds the switches.
    if s.snap {
        r = r.child(toggle("snap", "Snap", "Snap to grid (G)", true, |s| crate::prefs::set_snap(s, false)));
    }
    r.child(gear).child(center).child(zoom)
}

/// Above the selection: its name (the web app's entity label) and what you can do to it.
fn entity_bar(l: &Look, s: &App, r: [f32; 4], top: f32) -> El {
    let label = match s.selection.len() {
        1 => s.focus().map(|e| e.name.clone()).unwrap_or_default(),
        n => format!("{n} items selected"),
    };
    let anim = s.selected().any(|e| e.asset.animated());
    let playing = s.selected().any(|e| e.playing);
    let mut actions = row().gap(0.0).center_y();
    if anim {
        actions = actions.child(icon_button(l, "bar-play", if playing { "Pause (Space)" } else { "Play (Space)" }, if playing { &PAUSE } else { &PLAY }, |s, _| s.toggle_play()));
    }
    let original = s.focus().is_some_and(|e| e.params.show_original);
    let mut eye = icon_button(l, "bar-original", "Show original (O)", &EYE, |s, _| s.edit(|p| p.show_original = !p.show_original));
    if original {
        eye = eye.fill(l.surface).border(1.0, l.pressed_ring);
    }
    actions = actions
        .child(eye)
        .child(icon_button(l, "bar-dup", "Duplicate (⌘D)", &COPY, |s, _| s.duplicate_selection()))
        .child(icon_button(l, "bar-save", if s.selection.len() == 1 && anim { "Export… (⌘E)" } else { "Save as PNG (⌘E)" }, &SAVE, export_panel::save_or_export))
        .child(icon_button(l, "bar-delete", "Delete (⌫)", &TRASH, |s, _| s.delete_selection()));
    let bar = l.floating(row().key("entity-bar").gap(4.0).pl(14.0).pr(4.0).h(40.0).radius(20.0).center_y().child(text(label).font(MEDIUM).color(l.text).truncate().max_w(320.0)).child(actions));
    let y = (r[1] - 50.0).max(top.max(12.0) + 8.0);
    el().key("entity-bar-wrap").absolute(r[0].max(12.0), y).instant_changes().child(bar)
}

/// Playback on the clip itself: play/pause, a scrubber and the time, along its bottom edge.
fn media_controls(l: &Look, e: &crate::state::Entity, r: [f32; 4]) -> El {
    let id = e.id;
    let dur = e.asset.duration.as_secs_f64().max(1e-3);
    let t = (e.play_t / dur) as f32;
    let w = (r[2] - 24.0).clamp(160.0, 480.0);
    let x = r[0] + (r[2] - w) / 2.0;
    let y = r[1] + r[3] - 52.0;
    let scrub = el()
        .key("scrub")
        .role("slider")
        .label("Playback position")
        .grow(1.0)
        .h(24.0)
        .center_y()
        .cursor(rune::Cursor::Pointer)
        .on_drag(move |s: &mut App, d: &mut rune::Drag, tx: &mut Tx| {
            if let Some(e) = s.entity_mut(id) {
                let dur = e.asset.duration.as_secs_f64();
                if d.phase == rune::Phase::Down {
                    d.data = if e.playing { 1.0 } else { 0.0 };
                    e.playing = false;
                }
                e.seek_to(f64::from((d.x / d.w).clamp(0.0, 0.999)) * dur);
                if d.phase == rune::Phase::Up {
                    e.playing = d.data > 0.5;
                }
            }
            tx.instant();
        })
        .child(el().w_full().h(4.0).radius(2.0).fill(l.indicator).child(el().h(4.0).w_frac(t.clamp(0.0, 1.0)).radius(2.0).fill(l.text)));
    let play = icon_button(l, "media-play", if e.playing { "Pause" } else { "Play" }, if e.playing { &PAUSE } else { &PLAY }, move |s, _| {
        if let Some(e) = s.entity_mut(id) {
            e.playing = !e.playing;
        }
    });
    // As the web: the current time left of the track, the duration right of it. The current
    // time sits in a fixed, right-aligned slot as wide as the duration's text, so the bar never
    // shifts as digits change.
    let total = media_time(dur);
    let slot = total.len() as f32 * TIME_CHAR;
    let now = row().w(slot).justify_end().child(text(media_time(e.play_t.min(dur))).font(TIME).color(l.text_strong));
    let end = row().w(slot).child(text(total).font(TIME).color(l.text_muted));
    let mut bar = row().key("media").absolute(x, y).w(w).h(40.0).pl(4.0).pr(12.0).gap(8.0).radius(20.0).center_y().instant_changes().child(play).child(now).child(scrub).child(end);
    if e.has_audio() {
        let (label, glyph) = if e.muted { ("Unmute (M)", &MUTED) } else { ("Mute (M)", &SOUND) };
        bar = bar.pr(4.0).child(icon_button(l, "media-mute", label, glyph, move |s, _| {
            if let Some(e) = s.entity_mut(id) {
                e.muted = !e.muted;
            }
        }));
    }
    l.floating(bar)
}

/// The web's media time: `S:cc` under a minute, `M:SS:cc` from one.
pub fn media_time(secs: f64) -> String {
    if !secs.is_finite() || secs < 0.0 {
        return "0:00".into();
    }
    let cs = (secs * 100.0).round() as u64;
    let (s, c) = (cs / 100, cs % 100);
    if s < 60 { format!("{s}:{c:02}") } else { format!("{}:{:02}:{c:02}", s / 60, s % 60) }
}

fn empty_state(l: &Look) -> El {
    col()
        .key("empty")
        .absolute(0.0, 0.0)
        .w_full()
        .h_full()
        .center()
        .gap(8.0)
        .inert()
        .child(text("Voidmesh").font(TextStyle::new(28.0, 600.0)).color(l.text))
        .child(text("Drop images, videos, GIFs, SVGs or a .vdmsh workspace").font(look::BODY).color(l.text_muted))
        .child(text("All local, nothing gets uploaded. Saved as you go.").font(look::BODY).color(l.text_faint))
}
