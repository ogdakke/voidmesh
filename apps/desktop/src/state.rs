//! App state: entities on an infinite canvas, the camera, selection, undo and the commands that
//! change them. World units are media pixels: an image enters at its native pixel size.
//!
//! Each tab is a workspace in the store. The active tab's workspace lives in `App`'s own fields;
//! the others are parked (`Parked`) until shown, or not read yet. The active workspace saves
//! itself a moment after it changes (`App::autosave`), and before another tab shows.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use crate::effects::{Palette, Params};
use crate::media::{Asset, Loader};
use crate::store::{self, Doc, Meta, Saver, Store};
use crate::workspace::{self, Item, Progress, Viewport};

pub const MIN_SCALE: f32 = 0.005;
pub const MAX_SCALE: f32 = 8.0;
/// Snap cell and layout gap, in world units.
pub const GRID: f32 = 125.0;
const UNDO_CAP: usize = 100;
/// Seconds from a change to its save.
const AUTOSAVE_DELAY: f64 = 1.0;
/// The titlebar band's height in points: the canvas runs under it, the traffic lights sit in it.
pub const TITLEBAR: f32 = 52.0;

#[derive(Clone)]
pub struct Entity {
    /// This run's handle for it, unique across tabs.
    pub id: u32,
    /// Its id in the workspace document (a UUID).
    pub uid: String,
    pub name: String,
    pub asset: Arc<Asset>,
    /// Top-left, world units.
    pub pos: [f32; 2],
    pub size: [f32; 2],
    pub z: u32,
    pub params: Params,
    /// GIF and video playback.
    pub playing: bool,
    pub play_t: f64,
    /// Video sound; muted by default, as on the web.
    pub muted: bool,
    /// Bumped by a jump in `play_t` (seek, scrub) as opposed to playback moving it on.
    pub seek_gen: u32,
    /// Flowing glass's own clock.
    pub fx_t: f64,
}

impl Entity {
    pub fn rect(&self) -> [f32; 4] {
        [self.pos[0], self.pos[1], self.size[0], self.size[1]]
    }

    /// Jump the playhead (a seek, not playback).
    pub fn seek_to(&mut self, t: f64) {
        self.play_t = t;
        self.seek_gen = self.seek_gen.wrapping_add(1);
    }

    pub fn has_audio(&self) -> bool {
        self.asset.video.as_ref().is_some_and(|v| v.has_audio)
    }
}

/// Canvas camera: a canvas point shows world point `(q - pan) / scale`.
///
/// It reaches the screen through the view (the world's `offset` and `scale`), not `Live`
/// values: a native window samples live values when it acquires a drawable, after the view
/// committed, so during a fast pinch the media would be drawn with a newer camera than the UI
/// attached to it. Committing both together keeps them in step.
pub struct Camera {
    pub pan: [f32; 2],
    /// Points per world unit.
    pub scale: f32,
    pub anim: Option<CamAnim>,
}

#[derive(Clone, Copy)]
pub struct CamAnim {
    pub from: ([f32; 2], f32),
    pub to: ([f32; 2], f32),
    pub start: f64,
    pub dur: f64,
}

impl Camera {
    pub fn set(&mut self, pan: [f32; 2], scale: f32) {
        self.pan = pan;
        self.scale = scale.clamp(MIN_SCALE, MAX_SCALE);
    }

    pub fn world(&self, q: [f32; 2]) -> [f32; 2] {
        [(q[0] - self.pan[0]) / self.scale, (q[1] - self.pan[1]) / self.scale]
    }

    pub fn screen(&self, p: [f32; 2]) -> [f32; 2] {
        [p[0] * self.scale + self.pan[0], p[1] * self.scale + self.pan[1]]
    }

    pub fn screen_rect(&self, r: [f32; 4]) -> [f32; 4] {
        let [x, y] = self.screen([r[0], r[1]]);
        [x, y, r[2] * self.scale, r[3] * self.scale]
    }

    /// Zoom by `k` keeping canvas point `q` over the same world point.
    pub fn zoom_about(&mut self, q: [f32; 2], k: f32) {
        let p = self.world(q);
        let s = (self.scale * k).clamp(MIN_SCALE, MAX_SCALE);
        self.anim = None;
        self.set([q[0] - p[0] * s, q[1] - p[1] * s], s);
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarqueeMode {
    Replace,
    Add,
    Subtract,
}

pub struct Marquee {
    pub start: [f32; 2],
    pub end: [f32; 2],
    pub mode: MarqueeMode,
    pub base: BTreeSet<u32>,
}

impl Marquee {
    pub fn rect(&self) -> [f32; 4] {
        let (x0, y0) = (self.start[0].min(self.end[0]), self.start[1].min(self.end[1]));
        [x0, y0, (self.start[0] - self.end[0]).abs(), (self.start[1] - self.end[1]).abs()]
    }
}

/// An entity drag: who moves, from where, and the state to undo to.
pub struct MoveDrag {
    pub ids: Vec<(u32, [f32; 2])>,
    pub before: Snapshot,
    pub moved: bool,
    /// The press landed on an entity already in a multi-selection: a click collapses to it.
    pub collapse_to: Option<u32>,
    /// The press landed on the selected, single animated entity: a click toggles playback.
    pub toggle_play: Option<u32>,
    /// The press landed on empty space inside a multi-selection's box: a click clears it.
    pub clear_on_click: bool,
}

#[derive(Clone)]
pub struct Snapshot {
    entities: Vec<Entity>,
    selection: BTreeSet<u32>,
    /// User palettes change with the entities that use them (one step), as on the web.
    palettes: Vec<Palette>,
}

impl Snapshot {
    /// The same document: entities (media, place, name, effect) and user palettes. Selection
    /// and playback clocks aren't steps of their own.
    fn same_document(&self, other: &Snapshot) -> bool {
        self.palettes == other.palettes
            && self.entities.len() == other.entities.len()
            && self.entities.iter().zip(&other.entities).all(|(a, b)| {
                a.id == b.id && Arc::ptr_eq(&a.asset, &b.asset) && a.pos == b.pos && a.size == b.size && a.z == b.z && a.name == b.name && a.params == b.params
            })
    }
}

/// The colour picker's session: which palette colour it edits and its OKLCH working value
/// (kept so hue survives greys). A session is one undo step.
pub struct Picker {
    /// The colour's index in the palette as stored (not as shown reversed).
    pub index: usize,
    pub oklch: crate::color::Oklch,
}

pub struct Export {
    pub entity: u32,
    /// A file, or the clipboard (`None`) as a PNG.
    pub path: Option<PathBuf>,
}

/// A tab's workspace while another tab shows.
pub struct Parked {
    entities: Vec<Entity>,
    selection: BTreeSet<u32>,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    cam: ([f32; 2], f32),
    revision: u64,
    persisted: u64,
    persisted_cam: ([f32; 2], f32),
}

impl Parked {
    fn empty(cam: ([f32; 2], f32)) -> Parked {
        Parked { entities: Vec::new(), selection: BTreeSet::new(), undo: Vec::new(), redo: Vec::new(), cam, revision: 0, persisted: 0, persisted_cam: cam }
    }
}

/// An open workspace.
pub struct Tab {
    pub id: String,
    pub name: String,
    /// The store has it (it was read from there or saved): a view change alone saves it then.
    pub stored: bool,
    /// Its workspace while another tab shows; None for the active tab and one not read yet.
    pub parked: Option<Parked>,
    /// Being read, from the store or a `.vdmsh` file.
    pub loading: Option<Arc<Progress>>,
}

impl Tab {
    pub fn new() -> Tab {
        Tab { id: store::new_id(), name: workspace::random_name(), stored: false, parked: None, loading: None }
    }
}

/// Where a new tab's camera starts.
const HOME: ([f32; 2], f32) = ([0.0, 0.0], 0.5);

/// Files imported together: where they land and how many are still decoding.
pub struct Batch {
    pub id: u64,
    pub at: Option<[f32; 2]>,
    pub waiting: usize,
    pub ready: Vec<Arc<Asset>>,
}

/// Canvas lensing presets: the canvas bends at its edges like a thick glass slab.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Lensing {
    #[default]
    Off,
    Subtle,
    Extreme,
}

#[derive(Clone, Copy)]
pub struct LensParams {
    pub strength: f32,
    pub radius: f32,
    pub falloff: f32,
    pub dispersion: f32,
    pub scale: f32,
    pub reflection: f32,
    pub focus: f32,
    pub occlusion: f32,
    pub vignette_light: f32,
    pub vignette_dark: f32,
}

impl Lensing {
    pub fn next(self) -> Lensing {
        match self {
            Lensing::Off => Lensing::Subtle,
            Lensing::Subtle => Lensing::Extreme,
            Lensing::Extreme => Lensing::Off,
        }
    }

    pub fn preset(self) -> Option<LensParams> {
        match self {
            Lensing::Off => None,
            Lensing::Subtle => Some(LensParams { strength: 0.4, radius: 0.07, falloff: 1.8, dispersion: 0.25, scale: 1.0, reflection: 0.23, focus: 0.87, occlusion: 0.04, vignette_light: 0.16, vignette_dark: 0.32 }),
            Lensing::Extreme => Some(LensParams { strength: 0.35, radius: 0.33, falloff: 3.55, dispersion: 0.65, scale: 4.0, reflection: 0.16, focus: 0.0, occlusion: 0.03, vignette_light: 0.22, vignette_dark: 0.0 }),
        }
    }
}

/// A deletion to turn to dust (`gfx/dust.rs`): the entity and its world rect.
pub struct DustRequest {
    pub entity: u32,
    pub rect: [f32; 4],
}

/// At most this many deletions at once turn to dust (the web's `fancyDeleteMaxBatchSize`).
pub const DUST_MAX_BATCH: usize = 32;

/// The slider whose value field is being typed into.
#[derive(Clone, Copy)]
pub struct ValueTarget {
    pub key: &'static str,
    pub range: crate::effects::Range,
    pub set: fn(&mut Params, f32),
}

pub struct Toast {
    pub text: String,
    pub until: f64,
}

pub struct App {
    pub entities: Vec<Entity>,
    pub selection: BTreeSet<u32>,
    pub cam: Camera,
    pub canvas: [f32; 4],
    pub marquee: Option<Marquee>,
    pub drag: Option<MoveDrag>,
    pub panning: Option<[f32; 2]>,
    /// Space is held; a release without a drag toggles playback.
    pub space: bool,
    pub space_dragged: bool,
    pub snap: bool,
    pub lens: Lensing,
    pub undo: Vec<Snapshot>,
    pub redo: Vec<Snapshot>,
    /// A slider gesture's state before it began, pushed to undo when it ends.
    pub editing: Option<Snapshot>,
    /// The effect new media takes: the last one selected or edited.
    pub last_params: Params,
    pub next_id: u32,
    pub next_z: u32,
    pub loader: Loader,
    pub pending: usize,
    pub batches: Vec<Batch>,
    next_batch: u64,
    /// Where workspaces and their media are kept; None in tests and headless runs, which keep
    /// everything in memory.
    pub store: Option<Arc<dyn Store>>,
    pub saver: Option<Saver>,
    /// Open workspaces, and which one shows.
    pub tabs: Vec<Tab>,
    pub active: usize,
    /// The active workspace's revision, bumped by every undoable change, and the last one saved.
    pub revision: u64,
    pub persisted: u64,
    /// The camera as last saved: moving the view saves too, without an undo step.
    pub persisted_cam: ([f32; 2], f32),
    /// When the pending autosave runs.
    pub save_due: Option<f64>,
    /// The workspace library covers the canvas, with this listing.
    pub library: Option<Vec<Meta>>,
    /// The library row asking to confirm its deletion.
    pub confirm_delete: Option<String>,
    /// The active tab's name field, while renaming.
    pub tab_rename: Option<rune::TextEdit>,
    /// User palettes (custom and extracted).
    pub palettes: Vec<Palette>,
    pub prefs: rune::prefs::Prefs,
    /// The settings view covers the canvas.
    pub settings: bool,
    /// Chrome hidden (`\`): the canvas alone.
    pub bare: bool,
    /// The palette colour being edited.
    pub picker: Option<Picker>,
    /// The picker's hex field.
    pub hex_edit: rune::TextEdit,
    /// The palette name field, while renaming.
    pub name_edit: rune::TextEdit,
    /// A slider's value field, while typing into it (`value_target` says which).
    pub value_edit: rune::TextEdit,
    pub value_target: Option<ValueTarget>,
    /// The debug performance overlay (`D`).
    pub perf: crate::perf::Perf,
    /// Fancy deletions (dust), as stored; `None` follows the system's Reduce Motion.
    pub fancy_deletions: Option<bool>,
    /// The system asks for reduced motion (the compositor keeps this current).
    pub reduced_motion: bool,
    /// Deletions waiting for the compositor to turn them to dust.
    pub dust: Vec<DustRequest>,
    /// The dust layer shows until then (`now` seconds).
    pub dust_until: f64,
    pub renaming: bool,
    /// Flowing glass's Time control.
    pub time_slider: crate::ui::tick_slider::TickSlider,
    /// Sound for unmuted, playing videos, and the seek it last followed.
    pub audio: std::collections::HashMap<u32, (rune::Player, u32)>,
    /// Each showing video's latest frame by entity and asset, as the compositor last uploaded
    /// it: picking samples its alpha (`entity_at`).
    pub video_frames: std::collections::HashMap<(u32, u64), crate::video::VideoFrame>,
    pub toasts: Vec<Toast>,
    pub exports: Vec<Export>,
    /// Video and GIF export: the queue and its panel.
    pub export: crate::export_video::Exports,
    pub now: f64,
    pub drop_hover: bool,
    /// Inspector sections folded shut.
    pub folded: BTreeSet<&'static str>,
    /// Device points-to-pixels, from the last view.
    pub device_scale: f32,
    /// What the titlebar band covers at the canvas's top (0 where the native frame stays).
    pub top_inset: f32,
    /// When the last pinch event arrived. A trackpad also sends two-finger scrolls while the
    /// fingers' midpoint moves mid-pinch; those must not pan, or the point under the pointer
    /// slides away as the zoom changes.
    pub last_pinch: Option<std::time::Instant>,
    /// ⌘-scroll zoom: the canvas point it pivots on and the scale it eases toward. macOS sends
    /// those scrolls in coarse whole-point steps; easing turns them into smooth motion.
    pub zoom_to: Option<([f32; 2], f32)>,
}

impl Default for App {
    fn default() -> Self {
        App {
            entities: Vec::new(),
            selection: BTreeSet::new(),
            cam: Camera { pan: HOME.0, scale: HOME.1, anim: None },
            canvas: [0.0, 0.0, 0.0, 0.0],
            marquee: None,
            drag: None,
            panning: None,
            space: false,
            space_dragged: false,
            snap: false,
            lens: Lensing::Off,
            undo: Vec::new(),
            redo: Vec::new(),
            editing: None,
            last_params: Params::default(),
            next_id: 1,
            next_z: 1,
            loader: Loader::default(),
            pending: 0,
            batches: Vec::new(),
            next_batch: 1,
            store: None,
            saver: None,
            tabs: vec![Tab::new()],
            active: 0,
            revision: 0,
            persisted: 0,
            persisted_cam: HOME,
            save_due: None,
            library: None,
            confirm_delete: None,
            tab_rename: None,
            palettes: Vec::new(),
            audio: Default::default(),
            video_frames: Default::default(),
            prefs: rune::prefs::Prefs::memory(),
            settings: false,
            bare: false,
            time_slider: Default::default(),
            picker: None,
            hex_edit: rune::TextEdit::new(""),
            value_edit: rune::TextEdit::new(""),
            value_target: None,
            perf: Default::default(),
            fancy_deletions: None,
            reduced_motion: false,
            dust: Vec::new(),
            dust_until: f64::NEG_INFINITY,
            name_edit: rune::TextEdit::new(""),
            renaming: false,
            toasts: Vec::new(),
            exports: Vec::new(),
            export: Default::default(),
            now: 0.0,
            drop_hover: false,
            folded: BTreeSet::from(["adjust"]),
            device_scale: 2.0,
            top_inset: 0.0,
            last_pinch: None,
            zoom_to: None,
        }
    }
}

impl App {
    pub fn entity(&self, id: u32) -> Option<&Entity> {
        self.entities.iter().find(|e| e.id == id)
    }

    pub fn entity_mut(&mut self, id: u32) -> Option<&mut Entity> {
        self.entities.iter_mut().find(|e| e.id == id)
    }

    /// Selected entities in insertion order.
    pub fn selected(&self) -> impl Iterator<Item = &Entity> {
        self.entities.iter().filter(|e| self.selection.contains(&e.id))
    }

    /// The entity the inspector shows: the first selected.
    pub fn focus(&self) -> Option<&Entity> {
        self.selected().next()
    }

    pub fn toast(&mut self, text: impl Into<String>) {
        self.toasts.push(Toast { text: text.into(), until: self.now + 3.0 });
    }

    // ------------------------------------------------------------------ undo

    pub fn snapshot(&self) -> Snapshot {
        Snapshot { entities: self.entities.clone(), selection: self.selection.clone(), palettes: self.palettes.clone() }
    }

    pub fn push_undo(&mut self, s: Snapshot) {
        self.revision += 1;
        self.undo.push(s);
        if self.undo.len() > UNDO_CAP {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    /// Record the current state as one undo step, before a change. An open gesture or session
    /// (a value field, the colour picker, a slider) is closed into its own step first, so the
    /// history stays in order; the picker carries on in a new session.
    pub fn checkpoint(&mut self) {
        self.end_sessions();
        let s = self.snapshot();
        self.push_undo(s);
    }

    /// Close whatever gesture or session is recording, as its own step.
    fn end_sessions(&mut self) {
        self.commit_value();
        self.end_edit();
    }

    fn restore(&mut self, s: Snapshot) {
        // Playback clocks keep running across undo: take them from the live entities.
        let live: Vec<(u32, bool, f64, bool, u32)> = self.entities.iter().map(|e| (e.id, e.playing, e.play_t, e.muted, e.seek_gen)).collect();
        self.entities = s.entities;
        for e in &mut self.entities {
            if let Some((_, p, t, m, g)) = live.iter().find(|(id, ..)| *id == e.id) {
                (e.playing, e.play_t, e.muted, e.seek_gen) = (*p, *t, *m, *g);
            }
        }
        self.selection = s.selection.into_iter().filter(|id| self.entity(*id).is_some()).collect();
        if s.palettes != self.palettes {
            self.palettes = s.palettes;
            crate::prefs::save_palettes(self);
        }
        self.picker = None;
    }

    /// Undo the last step. An open session (the colour picker's, say) is that step: it closes
    /// and is taken back.
    pub fn undo(&mut self) -> bool {
        self.end_sessions();
        let Some(s) = self.undo.pop() else { return false };
        self.revision += 1;
        let now = self.snapshot();
        self.redo.push(now);
        self.restore(s);
        true
    }

    pub fn redo(&mut self) -> bool {
        self.end_sessions();
        let Some(s) = self.redo.pop() else { return false };
        self.revision += 1;
        let now = self.snapshot();
        self.undo.push(now);
        self.restore(s);
        true
    }

    // ------------------------------------------------------------------ params

    /// Change every selected entity's params with one undo step.
    pub fn edit(&mut self, f: impl Fn(&mut Params)) {
        if self.selection.is_empty() {
            return;
        }
        self.commit_value();
        if self.editing.is_none() {
            self.checkpoint();
        }
        self.edit_live(f);
    }

    /// Change params without an undo step (a slider mid-drag; the gesture pushes one).
    pub fn edit_live(&mut self, f: impl Fn(&mut Params)) {
        let sel = self.selection.clone();
        for e in self.entities.iter_mut().filter(|e| sel.contains(&e.id)) {
            f(&mut e.params);
        }
        if let Some(p) = self.focus().map(|e| e.params.clone()) {
            self.last_params = p;
        }
    }

    // ------------------------------------------------------------------ palette editing

    /// The focus's palette as one the user owns: a preset or Original forks into a new
    /// "Custom N" first, given to the whole selection. Returns its id. No undo step of its own.
    fn own_palette(&mut self) -> Option<String> {
        let p = self.focus()?.params.palette.clone();
        if crate::effects::is_user_palette(&p.id) {
            return Some(p.id);
        }
        let n = self.palettes.iter().filter(|q| q.name.starts_with("Custom")).count() + 1;
        let id = crate::effects::new_palette_id("cstm_");
        let fork = Palette { id: id.clone(), name: format!("Custom {n}"), short_name: format!("Custom {n}"), colors: p.colors };
        self.palettes.push(fork.clone());
        self.apply_palette(&fork);
        Some(id)
    }

    /// Give the selection `p` and keep the stored palette in step.
    fn apply_palette(&mut self, p: &Palette) {
        if let Some(q) = self.palettes.iter_mut().find(|q| q.id == p.id) {
            *q = p.clone();
        }
        let sel = self.selection.clone();
        for e in self.entities.iter_mut().filter(|e| sel.contains(&e.id)) {
            e.params.palette = p.clone();
        }
        if let Some(f) = self.focus().map(|e| e.params.clone()) {
            self.last_params = f;
        }
    }

    /// Change the selection's palette colours (forking a preset), one undo step.
    pub fn edit_palette(&mut self, f: impl FnOnce(&mut Vec<crate::effects::Rgba>)) {
        let Some(current) = self.focus().map(|e| e.params.palette.colors.clone()) else { return };
        let mut colors = current.clone();
        f(&mut colors);
        colors.truncate(crate::effects::MAX_COLORS);
        // Nothing changed (or too few colours left): no fork, no undo step.
        if colors.len() < 2 || colors == current {
            return;
        }
        // The open picker records a session (one step however many changes); anything else
        // is a step of its own.
        if self.editing.is_none() {
            if self.picker.is_some() {
                self.begin_edit();
            } else {
                self.checkpoint();
            }
        }
        let Some(id) = self.own_palette() else { return };
        let Some(mut p) = self.palettes.iter().find(|q| q.id == id).cloned() else { return };
        p.colors = colors;
        self.apply_palette(&p);
        crate::prefs::save_palettes(self);
    }

    pub fn add_palette_color(&mut self) {
        self.edit_palette(|c| {
            if c.len() < crate::effects::MAX_COLORS {
                c.push(crate::effects::NEW_COLOR);
            }
        });
    }

    /// Remove colour `index`: the picker's session closes first, so the removal is its own
    /// step, as the web's popover commits before it removes.
    pub fn remove_palette_color(&mut self, index: usize) {
        self.close_picker();
        self.edit_palette(|c| {
            if c.len() > 2 && index < c.len() {
                c.remove(index);
            }
        });
    }

    pub fn rename_palette(&mut self, name: &str) {
        let name = name.trim();
        let Some(id) = self.focus().map(|e| e.params.palette.id.clone()).filter(|id| crate::effects::is_user_palette(id)) else { return };
        if name.is_empty() || self.palettes.iter().any(|p| p.id == id && p.name == name) {
            return;
        }
        self.checkpoint();
        for p in self.palettes.iter_mut().filter(|p| p.id == id) {
            (p.name, p.short_name) = (name.to_string(), name.to_string());
        }
        for e in self.entities.iter_mut().filter(|e| e.params.palette.id == id) {
            (e.params.palette.name, e.params.palette.short_name) = (name.to_string(), name.to_string());
        }
        crate::prefs::save_palettes(self);
    }

    /// Delete a user palette, one undo step.
    pub fn delete_palette(&mut self, id: &str) {
        if !self.palettes.iter().any(|p| p.id == id) {
            return;
        }
        self.close_picker();
        self.checkpoint();
        self.palettes.retain(|p| p.id != id);
        // As the web's: the selected entities that used it fall back to the first preset; the
        // rest keep its colours as an unlisted copy.
        let fallback = crate::effects::presets()[0].clone();
        let sel = self.selection.clone();
        for e in self.entities.iter_mut().filter(|e| sel.contains(&e.id) && e.params.palette.id == id) {
            e.params.palette = fallback.clone();
        }
        crate::prefs::save_palettes(self);
    }

    /// Open the picker on palette colour `index` (as stored). The session is one undo step.
    pub fn open_picker(&mut self, index: usize) {
        let Some(c) = self.focus().and_then(|e| e.params.palette.colors.get(index).copied()) else { return };
        self.close_picker();
        self.begin_edit();
        let oklch = crate::color::from_rgba(c, 0.0);
        self.picker = Some(Picker { index, oklch });
        self.hex_edit = rune::TextEdit::new(crate::color::hex(c));
    }

    /// Set the picked colour from OKLCH (the area and sliders).
    pub fn pick_oklch(&mut self, o: crate::color::Oklch) {
        let Some(index) = self.picker.as_ref().map(|p| p.index) else { return };
        let rgba = crate::color::to_rgba(o);
        self.edit_palette(|c| {
            if let Some(x) = c.get_mut(index) {
                *x = rgba;
            }
        });
        if let Some(p) = self.picker.as_mut() {
            p.oklch = o;
        }
        self.hex_edit = rune::TextEdit::new(crate::color::hex(rgba));
    }

    /// The eyedropper (`eyedropper.rs`) picked `rgba` (sRGB) for the open picker.
    pub fn pick_rgba(&mut self, rgba: crate::effects::Rgba) {
        let Some((index, h)) = self.picker.as_ref().map(|p| (p.index, p.oklch.h)) else { return };
        self.edit_palette(|c| {
            if let Some(x) = c.get_mut(index) {
                *x = rgba;
            }
        });
        if let Some(p) = self.picker.as_mut() {
            p.oklch = crate::color::from_rgba(rgba, h);
        }
        self.hex_edit = rune::TextEdit::new(crate::color::hex(rgba));
    }

    /// Set the picked colour from the hex field, when it parses.
    pub fn pick_hex(&mut self) {
        let Some((rgba, h)) = self.picker.as_ref().and_then(|p| crate::color::parse_hex(&self.hex_edit.text).map(|c| (c, p.oklch.h))) else { return };
        let o = crate::color::from_rgba(rgba, h);
        let Some(index) = self.picker.as_ref().map(|p| p.index) else { return };
        self.edit_palette(|c| {
            if let Some(x) = c.get_mut(index) {
                *x = rgba;
            }
        });
        if let Some(p) = self.picker.as_mut() {
            p.oklch = o;
        }
    }

    pub fn close_picker(&mut self) {
        if self.picker.take().is_some() {
            self.end_edit();
        }
    }

    /// Load Palette…: extract 16 colours from an image file into a new user palette for the
    /// selection.
    pub fn palette_from_image(&mut self, path: &std::path::Path) {
        let asset = match crate::media::decode_file(0, path) {
            Ok(a) => a,
            Err(e) => return self.toast(format!("Couldn't read {}: {e}", path.display())),
        };
        let Some(f) = asset.frames.first() else { return self.toast("That file has no image to take colours from") };
        let colors = crate::palette::extract(&f.rgba, asset.width, asset.height, 16);
        let n = self.palettes.iter().filter(|p| p.name.starts_with("Extracted")).count() + 1;
        let p = Palette { id: crate::effects::new_palette_id("ext_"), name: format!("Extracted {n}"), short_name: format!("Extr. {n}"), colors };
        self.checkpoint();
        self.palettes.push(p.clone());
        if !self.selection.is_empty() {
            self.apply_palette(&p);
        }
        crate::prefs::save_palettes(self);
    }

    /// Reset: the selection's effect back to the defaults (keeping each one's style), one step.
    pub fn reset_selection(&mut self) {
        self.edit(|p| {
            let shader = p.shader;
            *p = Params::default();
            p.set_shader(shader);
        });
    }

    /// The palette choices: user palettes, the presets, then Original when the focus has one.
    pub fn palette_options(&self) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self.palettes.iter().chain(crate::effects::presets()).map(|p| (p.id.clone(), p.name.clone())).collect();
        if self.focus().is_some_and(|e| e.asset.palette.is_some()) {
            v.push((crate::effects::ORIGINAL_ID.into(), "Original".into()));
        }
        v
    }

    /// Give the selection the palette `id`, one undo step. Original is each entity's own.
    pub fn set_palette(&mut self, id: &str) {
        let shared = self.palettes.iter().chain(crate::effects::presets()).find(|p| p.id == id).cloned();
        if self.selection.is_empty() || (shared.is_none() && id != crate::effects::ORIGINAL_ID) {
            return;
        }
        self.checkpoint();
        let sel = self.selection.clone();
        for e in self.entities.iter_mut().filter(|e| sel.contains(&e.id)) {
            let pal = shared.clone().or_else(|| e.asset.original_palette());
            if let Some(pal) = pal {
                e.params.palette = pal;
            }
        }
        if let Some(p) = self.focus().map(|e| e.params.clone()) {
            self.last_params = p;
        }
    }

    /// Start typing into slider `key`'s value field, its text selected (the web's readout input).
    /// The typing is one undo step, closed by `commit_value`.
    pub fn start_value(&mut self, key: &'static str, value: f32, range: crate::effects::Range, set: fn(&mut Params, f32)) {
        self.commit_value();
        self.begin_edit();
        let text = crate::effects::format_value(value, range);
        self.value_edit = rune::TextEdit::new(text.clone());
        self.value_edit.set_selection(0, text.len());
        self.value_edit.focused = true;
        self.value_target = Some(ValueTarget { key, range, set });
    }

    /// The typed value, when it reads as a number, applied live and clamped to the range.
    pub fn type_value(&mut self) {
        let Some(t) = self.value_target else { return };
        if let Ok(v) = self.value_edit.text.trim().parse::<f32>()
            && v.is_finite()
        {
            self.edit_live(|p| (t.set)(p, v.clamp(t.range.min, t.range.max)));
        }
    }

    /// ↑/↓ in the value field: a step, shown in the field.
    pub fn step_value(&mut self, steps: f32) {
        let Some(t) = self.value_target else { return };
        let Ok(v) = self.value_edit.text.trim().parse::<f32>() else { return };
        let v = (v + steps * t.range.step).clamp(t.range.min, t.range.max);
        let text = crate::effects::format_value(v, t.range);
        let len = text.len();
        self.value_edit.text = text;
        self.value_edit.set_selection(len, len);
        self.edit_live(|p| (t.set)(p, v));
    }

    /// Enter, Escape or focus leaving: the value stays, and the typing becomes one undo step.
    pub fn commit_value(&mut self) {
        if self.value_target.take().is_some() {
            self.value_edit.focused = false;
            self.end_edit();
        }
    }

    pub fn begin_edit(&mut self) {
        self.commit_value();
        if self.editing.is_none() && !self.selection.is_empty() {
            self.editing = Some(self.snapshot());
        }
    }

    /// Close the open session into one undo step, when it changed anything.
    pub fn end_edit(&mut self) {
        if let Some(s) = self.editing.take()
            && !s.same_document(&self.snapshot())
        {
            self.push_undo(s);
        }
    }

    // ------------------------------------------------------------------ selection

    pub fn select_only(&mut self, id: u32) {
        self.selection.clear();
        self.selection.insert(id);
        if let Some(p) = self.entity(id).map(|e| e.params.clone()) {
            self.last_params = p;
        }
    }

    pub fn select_all(&mut self) {
        self.selection = self.entities.iter().map(|e| e.id).collect();
    }

    /// Select the next (or previous) entity in insertion order and fit it.
    pub fn cycle(&mut self, step: i32) {
        if self.entities.is_empty() {
            return;
        }
        let n = self.entities.len() as i32;
        let cur = self.focus().and_then(|f| self.entities.iter().position(|e| e.id == f.id)).map(|i| i as i32);
        let next = match cur {
            Some(i) => (i + step).rem_euclid(n),
            None if step > 0 => 0,
            None => n - 1,
        };
        let id = self.entities[next as usize].id;
        self.select_only(id);
        self.fit_selection();
    }

    /// Entities whose canvas rect meets `r` (canvas points).
    pub fn hits(&self, r: [f32; 4]) -> Vec<u32> {
        self.entities
            .iter()
            .filter(|e| {
                let s = self.cam.screen_rect(e.rect());
                s[0] < r[0] + r[2] && s[0] + s[2] > r[0] && s[1] < r[1] + r[3] && s[1] + s[3] > r[1]
            })
            .map(|e| e.id)
            .collect()
    }

    /// The top-most entity at canvas point `q`, alpha-aware (`hit.rs`): transparent cells let the
    /// point through to what's beneath. A video with no frame yet hits its whole rect.
    pub fn entity_at(&self, q: [f32; 2]) -> Option<u32> {
        let mut under: Vec<&Entity> = self
            .entities
            .iter()
            .filter(|e| {
                let r = self.cam.screen_rect(e.rect());
                q[0] >= r[0] && q[0] < r[0] + r[2] && q[1] >= r[1] && q[1] < r[1] + r[3]
            })
            .collect();
        under.sort_by_key(|e| std::cmp::Reverse(e.z));
        under
            .into_iter()
            .find(|e| {
                let r = self.cam.screen_rect(e.rect());
                let (u, v) = ((q[0] - r[0]) / r[2], (q[1] - r[1]) / r[3]);
                let a = &e.asset;
                if a.video_path().is_some() {
                    return self.video_frames.get(&(e.id, a.id)).is_none_or(|f| crate::hit::cell_opaque(&f.rgba, f.width, f.height, u, v));
                }
                a.frames.get(a.frame_at(e.play_t)).is_some_and(|f| crate::hit::cell_opaque(&f.rgba, a.width, a.height, u, v))
            })
            .map(|e| e.id)
    }

    pub fn update_marquee(&mut self) {
        let Some(m) = &self.marquee else { return };
        let hit: BTreeSet<u32> = self.hits(m.rect()).into_iter().collect();
        self.selection = match m.mode {
            MarqueeMode::Replace => hit,
            MarqueeMode::Add => m.base.union(&hit).copied().collect(),
            MarqueeMode::Subtract => m.base.difference(&hit).copied().collect(),
        };
    }

    // ------------------------------------------------------------------ camera

    pub fn bounds(&self, ids: &BTreeSet<u32>) -> Option<[f32; 4]> {
        let mut it = self.entities.iter().filter(|e| ids.contains(&e.id));
        let first = it.next()?.rect();
        let (mut x0, mut y0, mut x1, mut y1) = (first[0], first[1], first[0] + first[2], first[1] + first[3]);
        for e in it {
            let r = e.rect();
            (x0, y0, x1, y1) = (x0.min(r[0]), y0.min(r[1]), x1.max(r[0] + r[2]), y1.max(r[1] + r[3]));
        }
        Some([x0, y0, x1 - x0, y1 - y0])
    }

    /// Animate the camera to show world rect `r` with 10% padding a side, in the part of the
    /// canvas the inspector (which floats beside the selection) leaves.
    pub fn fit(&mut self, r: [f32; 4]) {
        let [_, _, cw, ch] = self.canvas;
        let cw = cw - crate::ui::inspector::WIDTH - 30.0;
        let top = self.top_inset;
        let ch = ch - top;
        if cw <= 0.0 || ch <= 0.0 || r[2] <= 0.0 || r[3] <= 0.0 {
            return;
        }
        let s = ((cw * 0.8) / r[2]).min((ch * 0.8) / r[3]);
        let pan = [cw / 2.0 - (r[0] + r[2] / 2.0) * s, top + ch / 2.0 - (r[1] + r[3] / 2.0) * s];
        self.animate_to(pan, s, 0.32);
    }

    pub fn fit_selection(&mut self) {
        if let Some(r) = self.bounds(&self.selection.clone()) {
            self.fit(r);
        }
    }

    /// Back to 100% (one world unit per device pixel) about the canvas centre.
    pub fn reset_zoom(&mut self, device_scale: f32) {
        let c = [self.canvas[2] / 2.0, self.canvas[3] / 2.0];
        let p = self.cam.world(c);
        let s = 1.0 / device_scale;
        self.animate_to([c[0] - p[0] * s, c[1] - p[1] * s], s, 0.25);
    }

    /// The canvas laid out at `r`. A resize pans by half the size change, so the view's centre
    /// stays put (the web's `resizeSurface`); the first layout, from nothing, doesn't.
    pub fn resize_canvas(&mut self, r: [f32; 4]) {
        let old = self.canvas;
        self.canvas = r;
        if old[2] <= 0.0 || old[3] <= 0.0 || (old[2] == r[2] && old[3] == r[3]) {
            return;
        }
        let d = [(r[2] - old[2]) / 2.0, (r[3] - old[3]) / 2.0];
        let shift = |p: [f32; 2]| [p[0] + d[0], p[1] + d[1]];
        self.cam.pan = shift(self.cam.pan);
        if let Some(a) = self.cam.anim.as_mut() {
            (a.from.0, a.to.0) = (shift(a.from.0), shift(a.to.0));
        }
        if let Some((q, _)) = self.zoom_to.as_mut() {
            *q = shift(*q);
        }
    }

    pub fn animate_to(&mut self, pan: [f32; 2], scale: f32, dur: f64) {
        self.zoom_to = None;
        self.cam.anim = Some(CamAnim { from: (self.cam.pan, self.cam.scale), to: (pan, scale), start: self.now, dur });
    }

    /// Move the ⌘-scroll zoom target by `k`, pivoting on canvas point `q`.
    pub fn zoom_toward(&mut self, q: [f32; 2], k: f32) {
        let base = self.zoom_to.map(|z| z.1).unwrap_or(self.cam.scale);
        self.cam.anim = None;
        self.zoom_to = Some((q, (base * k).clamp(MIN_SCALE, MAX_SCALE)));
    }

    /// Eases the camera toward the ⌘-scroll target (about 60 ms to close most of the gap, in
    /// log scale so zooming in and out feel alike); true while it moves.
    pub fn step_zoom(&mut self, dt: f64) -> bool {
        const TAU: f64 = 0.06;
        let Some((q, target)) = self.zoom_to else { return false };
        let s = self.cam.scale;
        let a = (1.0 - (-dt / TAU).exp()) as f32;
        let mut next = (s.ln() + (target.ln() - s.ln()) * a).exp();
        if (target / next).ln().abs() < 0.002 {
            next = target;
            self.zoom_to = None;
        }
        self.cam.zoom_about(q, next / s);
        true
    }

    /// Steps a running camera animation (ease-out cubic); true while it runs.
    pub fn step_camera(&mut self) -> bool {
        let Some(a) = self.cam.anim else { return false };
        let t = ((self.now - a.start) / a.dur).clamp(0.0, 1.0) as f32;
        let e = 1.0 - (1.0 - t).powi(3);
        // Interpolate scale in log space so zooms feel even.
        let s = (a.from.1.ln() + (a.to.1.ln() - a.from.1.ln()) * e).exp();
        // Keep the world point at the target's centre on the path the eye expects.
        let lerp = |a: f32, b: f32| a + (b - a) * e;
        let pan = [lerp(a.from.0[0], a.to.0[0]), lerp(a.from.0[1], a.to.0[1])];
        self.cam.set(pan, s);
        if t >= 1.0 {
            self.cam.anim = None;
        }
        true
    }

    // ------------------------------------------------------------------ entities

    /// Media to add. Dropped files land at the drop's world point; opened ones at the view's
    /// centre, and the view fits them.
    pub fn import(&mut self, paths: Vec<PathBuf>, at: Option<[f32; 2]>) {
        // A workspace among the files opens instead (the first one); the rest is media.
        let (ws, paths): (Vec<PathBuf>, Vec<PathBuf>) = paths.into_iter().partition(|p| workspace::is_workspace(p));
        if let Some(p) = ws.into_iter().next() {
            self.import_workspace(p);
            return;
        }
        if paths.is_empty() {
            return;
        }
        let batch = self.next_batch;
        self.next_batch += 1;
        self.batches.push(Batch { id: batch, at, waiting: paths.len(), ready: Vec::new() });
        for p in paths {
            self.pending += 1;
            self.loader.load(crate::media::next_asset_id(), p, batch, self.store.clone());
        }
    }

    /// Take in decoded media; a batch is placed once all of it has arrived.
    pub fn receive(&mut self, d: crate::media::Decoded) {
        self.pending = self.pending.saturating_sub(1);
        let Some(i) = self.batches.iter().position(|b| b.id == d.batch) else { return };
        match d.result {
            Ok(a) => self.batches[i].ready.push(a),
            Err((name, e)) => self.toast(format!("Couldn't open {name}: {e}")),
        }
        self.batches[i].waiting -= 1;
        if self.batches[i].waiting == 0 {
            let b = self.batches.remove(i);
            let anchor = b.at.unwrap_or_else(|| self.cam.world([self.canvas[2] / 2.0, self.canvas[3] / 2.0]));
            self.place(b.ready, anchor, b.at.is_none());
        }
    }

    /// Place decoded assets centred on `anchor`, shelf-packed four to a row with a grid gap.
    pub fn place(&mut self, assets: Vec<Arc<Asset>>, anchor: [f32; 2], fit: bool) {
        if assets.is_empty() {
            return;
        }
        self.checkpoint();
        let mut order: Vec<Arc<Asset>> = assets;
        order.sort_by_key(|a| std::cmp::Reverse(a.width * a.height));
        let mut slots = Vec::with_capacity(order.len());
        let (mut x, mut y, mut row_h, mut w_max) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        for (i, a) in order.iter().enumerate() {
            if i > 0 && i % 4 == 0 {
                (x, y, row_h) = (0.0, y + row_h + GRID, 0.0);
            }
            slots.push([x, y]);
            x += a.width as f32 + GRID;
            row_h = row_h.max(a.height as f32);
            w_max = w_max.max(x - GRID);
        }
        let total = [w_max, y + row_h];
        self.selection.clear();
        for (a, [sx, sy]) in order.into_iter().zip(slots) {
            let mut pos = [anchor[0] - total[0] / 2.0 + sx, anchor[1] - total[1] / 2.0 + sy];
            if self.snap {
                pos = pos.map(|v| (v / GRID).round() * GRID);
            }
            let id = self.next_id;
            self.next_id += 1;
            let animated = a.animated();
            // Original is each entity's own: new media takes its own colours, or Black & White
            // when it has none (video), as the web's does.
            let mut params = self.last_params.clone();
            if params.palette.id == crate::effects::ORIGINAL_ID {
                params.palette = a.original_palette().unwrap_or_else(|| crate::effects::presets()[0].clone());
            }
            self.entities.push(Entity {
                id,
                uid: store::new_id(),
                name: a.name.clone(),
                size: [a.width as f32, a.height as f32],
                asset: a,
                pos,
                z: self.next_z,
                params,
                playing: animated,
                play_t: 0.0,
                fx_t: 0.0,
                muted: true,
                seek_gen: 0,
            });
            self.next_z += 1;
            self.selection.insert(id);
        }
        if fit {
            self.fit_selection();
        }
    }

    /// Deletions turn to dust: on unless set off, or the system asks for reduced motion.
    pub fn fancy_deletions(&self) -> bool {
        self.fancy_deletions.unwrap_or(!self.reduced_motion)
    }

    pub fn delete_selection(&mut self) {
        if self.selection.is_empty() {
            return;
        }
        self.checkpoint();
        let sel = std::mem::take(&mut self.selection);
        if self.fancy_deletions() && sel.len() <= DUST_MAX_BATCH {
            let doomed = self.entities.iter().filter(|e| sel.contains(&e.id)).map(|e| DustRequest { entity: e.id, rect: e.rect() });
            self.dust.extend(doomed);
            self.dust_until = self.now + f64::from(crate::gfx::DUST_SECONDS) + 0.25;
        }
        self.entities.retain(|e| !sel.contains(&e.id));
    }

    pub fn duplicate_selection(&mut self) {
        if self.selection.is_empty() {
            return;
        }
        self.checkpoint();
        let copies: Vec<Entity> = self.selected().cloned().collect();
        self.selection.clear();
        for mut e in copies {
            e.id = self.next_id;
            e.uid = store::new_id();
            self.next_id += 1;
            e.z = self.next_z;
            self.next_z += 1;
            e.pos = [e.pos[0] + 30.0, e.pos[1] + 30.0];
            e.name = self.unique_name(&e.name);
            e.seek_to(0.0);
            self.selection.insert(e.id);
            self.entities.push(e);
        }
    }

    fn unique_name(&self, name: &str) -> String {
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) => (s.to_string(), format!(".{e}")),
            None => (name.to_string(), String::new()),
        };
        // Drop an earlier copy's " N" suffix, keeping digits that belong to the name.
        let stem = match stem.rsplit_once(' ') {
            Some((base, n)) if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => base.to_string(),
            _ => stem,
        };
        (2..).map(|n| format!("{stem} {n}{ext}")).find(|n| self.entities.iter().all(|e| &e.name != n)).unwrap_or_default()
    }

    // ------------------------------------------------------------------ workspaces and tabs

    pub fn tab(&self) -> &Tab {
        &self.tabs[self.active]
    }

    /// The active tab is being read.
    pub fn loading(&self) -> Option<&Arc<Progress>> {
        self.tab().loading.as_ref()
    }

    /// A fresh tab nothing has happened in: opening a workspace takes it over.
    fn blank(&self) -> bool {
        let t = self.tab();
        !t.stored && t.loading.is_none() && self.entities.is_empty() && self.revision == 0 && self.pending == 0
    }

    fn take_state(&mut self) -> Parked {
        self.end_edit();
        self.picker = None;
        self.drag = None;
        self.marquee = None;
        self.tab_rename = None;
        self.save_due = None;
        Parked {
            entities: std::mem::take(&mut self.entities),
            selection: std::mem::take(&mut self.selection),
            undo: std::mem::take(&mut self.undo),
            redo: std::mem::take(&mut self.redo),
            cam: (self.cam.pan, self.cam.scale),
            revision: self.revision,
            persisted: self.persisted,
            persisted_cam: self.persisted_cam,
        }
    }

    fn put_state(&mut self, p: Parked) {
        self.entities = p.entities;
        self.selection = p.selection;
        self.undo = p.undo;
        self.redo = p.redo;
        self.cam.anim = None;
        self.zoom_to = None;
        self.cam.set(p.cam.0, p.cam.1);
        self.revision = p.revision;
        self.persisted = p.persisted;
        self.persisted_cam = p.persisted_cam;
    }

    /// Show tab `i` in place of the current one, whose state the caller has dealt with.
    fn show_tab(&mut self, i: usize) {
        self.active = i;
        match self.tabs[i].parked.take() {
            Some(p) => self.put_state(p),
            None => {
                self.put_state(Parked::empty(HOME));
                if self.tabs[i].stored && self.tabs[i].loading.is_none() {
                    self.load_tab(i);
                }
            }
        }
        crate::prefs::save_tabs(self);
    }

    /// Save the current tab and set it aside.
    fn park(&mut self) {
        self.persist_if_dirty();
        let p = self.take_state();
        self.tabs[self.active].parked = Some(p);
    }

    pub fn switch_tab(&mut self, i: usize) {
        if i == self.active || i >= self.tabs.len() {
            return;
        }
        self.park();
        self.show_tab(i);
    }

    /// ⌃Tab and ⌃⇧Tab.
    pub fn cycle_tab(&mut self, step: i32) {
        let n = self.tabs.len() as i32;
        self.switch_tab((self.active as i32 + step).rem_euclid(n) as usize);
    }

    pub fn new_tab(&mut self) {
        if self.blank() {
            return;
        }
        self.park();
        self.tabs.push(Tab::new());
        self.show_tab(self.tabs.len() - 1);
    }

    /// Close tab `i`, saving it first.
    pub fn close_tab(&mut self, i: usize) {
        if i >= self.tabs.len() {
            return;
        }
        if i == self.active {
            self.persist_if_dirty();
        }
        self.drop_tab(i);
    }

    /// Remove tab `i` without saving it (it's saved, gone, or failed to read).
    fn drop_tab(&mut self, i: usize) {
        let was_active = i == self.active;
        if was_active {
            self.take_state();
            self.audio.clear();
        }
        self.tabs.remove(i);
        if self.tabs.is_empty() {
            self.tabs.push(Tab::new());
            self.show_tab(0);
        } else if was_active {
            self.show_tab(i.min(self.tabs.len() - 1));
        } else {
            if i < self.active {
                self.active -= 1;
            }
            crate::prefs::save_tabs(self);
        }
    }

    /// Open a stored workspace: its tab if it has one, else a new tab (or the blank one).
    pub fn open_stored(&mut self, id: &str, name: &str) {
        if let Some(i) = self.tabs.iter().position(|t| t.id == id) {
            return self.switch_tab(i);
        }
        let tab = Tab { id: id.to_string(), name: name.to_string(), stored: true, parked: None, loading: None };
        if self.blank() {
            self.tabs[self.active] = tab;
            self.show_tab(self.active);
        } else {
            self.park();
            self.tabs.push(tab);
            self.show_tab(self.tabs.len() - 1);
        }
    }

    fn load_tab(&mut self, i: usize) {
        let Some(store) = self.store.clone() else { return };
        let progress = Arc::new(Progress::default());
        self.tabs[i].loading = Some(progress.clone());
        self.loader.load_workspace(self.tabs[i].id.clone(), store, progress);
    }

    /// A `.vdmsh` file opens as a new workspace (a copy: the file isn't written back to).
    pub fn import_workspace(&mut self, path: PathBuf) {
        let Some(store) = self.store.clone() else { return self.toast("Workspaces can't be opened here") };
        let name = path.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(workspace::random_name);
        if self.blank() {
            self.tabs[self.active].name = name;
        } else {
            self.park();
            self.tabs.push(Tab { name, ..Tab::new() });
            self.show_tab(self.tabs.len() - 1);
        }
        let progress = Arc::new(Progress::default());
        self.tabs[self.active].loading = Some(progress.clone());
        self.loader.import_workspace(self.tab().id.clone(), path, store, progress);
    }

    /// Stop reading a `.vdmsh` file. A stored workspace always finishes reading: a tab left
    /// half-read would save over it.
    pub fn cancel_open(&mut self) {
        if let Some(p) = &self.tab().loading
            && !self.tab().stored
        {
            p.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// Take in a read workspace for tab `tab`: its entities, view and palettes. If the tab shows,
    /// anything added to it meanwhile stays, on top.
    pub fn receive_workspace(&mut self, tab: &str, imported: bool, result: Result<workspace::Workspace, String>) {
        let Some(i) = self.tabs.iter().position(|t| t.id == tab) else { return };
        self.tabs[i].loading = None;
        let name = self.tabs[i].name.clone();
        let ws = match result {
            Ok(ws) if ws.items.is_empty() && !ws.failed.is_empty() => Err(ws.failed[0].clone()),
            r => r,
        };
        let ws = match ws {
            Ok(ws) => ws,
            Err(e) => {
                if e != "cancelled" {
                    self.toast(format!("Couldn't open {name}: {e}"));
                }
                return self.drop_tab(i);
            }
        };
        if imported && let Some(n) = ws.name.clone().filter(|n| !n.trim().is_empty()) {
            self.tabs[i].name = n;
        }
        let mut entities = Vec::with_capacity(ws.items.len());
        for it in ws.items {
            let id = self.next_id;
            self.next_id += 1;
            entities.push(Entity { id, uid: it.uid, name: it.name, asset: it.asset, pos: it.pos, size: it.size, z: it.z, params: it.params, playing: it.playing, play_t: it.play_t, fx_t: it.fx_t, muted: it.muted, seek_gen: 0 });
        }
        // The workspace's palettes join the user's, as the web merges them into its store.
        let before = self.palettes.len();
        for p in ws.palettes {
            if !self.palettes.iter().any(|q| q.id == p.id) {
                self.palettes.push(p);
            }
        }
        if self.palettes.len() != before {
            crate::prefs::save_palettes(self);
        }
        let cam = self.cam_for(ws.viewport);
        // An import isn't in the store until it saves; a stored one is as read.
        let (revision, persisted) = if imported { (1, 0) } else { (1, 1) };
        self.tabs[i].stored |= !imported;
        if i == self.active {
            let added = std::mem::take(&mut self.entities);
            let top = entities.iter().map(|e| e.z).max().unwrap_or(0);
            entities.extend(added.into_iter().map(|mut e| {
                e.z += top;
                e
            }));
            self.entities = entities;
            self.selection.clear();
            self.undo.clear();
            self.redo.clear();
            self.editing = None;
            self.cam.anim = None;
            self.zoom_to = None;
            self.cam.set(cam.0, cam.1);
            self.revision = revision;
            self.persisted = persisted;
            self.persisted_cam = cam;
        } else {
            self.tabs[i].parked = Some(Parked { entities, cam, revision, persisted, persisted_cam: cam, ..Parked::empty(cam) });
        }
        self.next_z = self.next_z.max(self.entities.iter().map(|e| e.z).max().unwrap_or(0) + 1);
        if !ws.failed.is_empty() {
            let n = ws.failed.len();
            self.toast(format!("Failed to import {n} of {} files", n + self.entities.len()));
        }
    }

    pub fn rename_tab(&mut self, name: &str) {
        let name = name.trim();
        self.tab_rename = None;
        if name.is_empty() || name == self.tab().name {
            return;
        }
        self.tabs[self.active].name = name.to_string();
        self.persist();
    }

    /// Delete a stored workspace, closing its tab without saving it.
    pub fn delete_workspace(&mut self, id: &str) {
        self.confirm_delete = None;
        if let Some(i) = self.tabs.iter().position(|t| t.id == id) {
            self.drop_tab(i);
        }
        if let Some(saver) = &self.saver {
            saver.delete(id.to_string());
        }
        if let Some(list) = &mut self.library {
            list.retain(|m| m.id != id);
        }
    }

    pub fn open_library(&mut self) {
        self.settings = false;
        self.confirm_delete = None;
        let list = self.store.as_ref().map_or(Ok(Vec::new()), |st| st.list());
        self.library = Some(list.unwrap_or_else(|e| {
            self.toast(format!("Couldn't list workspaces: {e}"));
            Vec::new()
        }));
    }

    /// Reopen the tabs the last run had open, showing the one it showed.
    pub fn restore_tabs(&mut self, ids: &[String], active: Option<&str>) {
        let Some(store) = &self.store else { return };
        let stored = store.list().unwrap_or_default();
        let tabs: Vec<Tab> = ids.iter().filter_map(|id| stored.iter().find(|m| &m.id == id)).map(|m| Tab { id: m.id.clone(), name: m.name.clone(), stored: true, parked: None, loading: None }).collect();
        if tabs.is_empty() {
            return;
        }
        let i = active.and_then(|a| tabs.iter().position(|t| t.id == a)).unwrap_or(0);
        self.tabs = tabs;
        self.show_tab(i);
    }

    /// The camera that shows viewport `v`.
    fn cam_for(&self, v: Viewport) -> ([f32; 2], f32) {
        let s = ((v.zoom / f64::from(self.device_scale.max(0.5))) as f32).clamp(MIN_SCALE, MAX_SCALE);
        ([self.canvas[0] - v.offset[0] as f32 * s, self.canvas[1] - v.offset[1] as f32 * s], s)
    }

    /// The camera as the web's viewport (device pixels per world unit, world at the top-left).
    pub fn viewport(&self) -> Viewport {
        let s = f64::from(self.cam.scale);
        let o = self.cam.world([self.canvas[0], self.canvas[1]]);
        Viewport { offset: [f64::from(o[0]), f64::from(o[1])], zoom: s * f64::from(self.device_scale) }
    }

    pub fn items(&self) -> Vec<Item> {
        self.entities
            .iter()
            .map(|e| Item { uid: e.uid.clone(), name: e.name.clone(), asset: e.asset.clone(), pos: e.pos, size: e.size, z: e.z, params: e.params.clone(), fx_t: e.fx_t, playing: e.playing, play_t: e.play_t, muted: e.muted })
            .collect()
    }

    /// The active workspace as a document.
    pub fn doc(&self) -> Doc {
        Doc { id: self.tab().id.clone(), name: self.tab().name.clone(), items: self.items(), viewport: self.viewport(), palettes: self.palettes.clone() }
    }

    /// The active workspace has changes the store doesn't.
    pub fn needs_save(&self) -> bool {
        let t = self.tab();
        t.loading.is_none() && (self.revision != self.persisted || (t.stored && (self.cam.pan, self.cam.scale) != self.persisted_cam))
    }

    /// Queue a save of the active workspace.
    fn persist(&mut self) {
        let Some(saver) = &self.saver else { return };
        if self.tab().loading.is_some() {
            return;
        }
        saver.save(self.doc());
        self.persisted = self.revision;
        self.persisted_cam = (self.cam.pan, self.cam.scale);
        self.tabs[self.active].stored = true;
        self.save_due = None;
    }

    pub fn persist_if_dirty(&mut self) {
        if self.needs_save() {
            self.persist();
        }
    }

    /// Save the active workspace once it has sat changed for a moment, waiting out gestures.
    /// Returns how long until it's due, while one is pending.
    pub fn autosave(&mut self) -> Option<f64> {
        if self.saver.is_none() || !self.needs_save() {
            self.save_due = None;
            return None;
        }
        if self.drag.is_some() || self.editing.is_some() || self.cam.anim.is_some() || self.zoom_to.is_some() || self.panning.is_some() {
            return Some(0.25);
        }
        let due = *self.save_due.get_or_insert(self.now + AUTOSAVE_DELAY);
        if self.now >= due {
            self.persist();
            return None;
        }
        Some(due - self.now)
    }

    /// Quitting: save what's changed and wait for the writes.
    pub fn flush(&mut self) {
        self.end_edit();
        self.persist_if_dirty();
        crate::prefs::save_tabs(self);
        if let Some(s) = &self.saver {
            s.flush();
        }
    }

    /// Write the active workspace to a `.vdmsh` file on a worker.
    pub fn export_workspace(&mut self, path: PathBuf) {
        self.loader.export_workspace(path, self.doc());
    }

    pub fn exported_workspace(&mut self, path: PathBuf, result: Result<(), String>) {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match result {
            Ok(()) => self.toast(format!("Exported {name}")),
            Err(e) => self.toast(format!("Couldn't export {name}: {e}")),
        }
    }

    // ------------------------------------------------------------------ effect time

    /// The Time control's state for the selection: (time, auto-playing, mixed), or None when no
    /// selected effect reads time. Time edits aren't undoable, as on the web.
    pub fn effect_time(&self) -> Option<(f64, bool, bool)> {
        let timed: Vec<&Entity> = self.selected().filter(|e| e.params.uses_time()).collect();
        let first = timed.first()?;
        // The time follows the first auto-playing entity, as the web's source entity.
        let src = timed.iter().find(|e| e.params.time_autoplay).unwrap_or(first);
        let mixed = timed.iter().any(|e| (e.fx_t - first.fx_t).abs() > 1e-4 || e.params.time_autoplay != first.params.time_autoplay);
        Some((src.fx_t, src.params.time_autoplay, mixed))
    }

    /// Play or pause the selection's effect clocks.
    pub fn toggle_effect_time(&mut self) {
        let Some((_, playing, _)) = self.effect_time() else { return };
        let sel = self.selection.clone();
        for e in self.entities.iter_mut().filter(|e| sel.contains(&e.id) && e.params.uses_time()) {
            e.params.time_autoplay = !playing;
        }
    }

    /// A Time gesture starts: every selected clock pauses at the shown time.
    pub fn begin_effect_time(&mut self) {
        let Some((t, ..)) = self.effect_time() else { return };
        let sel = self.selection.clone();
        for e in self.entities.iter_mut().filter(|e| sel.contains(&e.id) && e.params.uses_time()) {
            e.params.time_autoplay = false;
            e.fx_t = t;
        }
    }

    pub fn set_effect_time(&mut self, t: f64) {
        let sel = self.selection.clone();
        for e in self.entities.iter_mut().filter(|e| sel.contains(&e.id) && e.params.uses_time()) {
            e.fx_t = t;
        }
    }

    /// Toggle playback of the selected animated media.
    pub fn toggle_play(&mut self) {
        let sel = self.selection.clone();
        for e in self.entities.iter_mut().filter(|e| sel.contains(&e.id) && e.asset.animated()) {
            e.playing = !e.playing;
        }
    }

    pub fn seek(&mut self, dt: f64) {
        let sel = self.selection.clone();
        for e in self.entities.iter_mut().filter(|e| sel.contains(&e.id) && e.asset.animated()) {
            let d = e.asset.duration.as_secs_f64();
            e.seek_to((e.play_t + dt).rem_euclid(d.max(1e-3)));
        }
    }

    /// The playback bar's keys, for clip `id`: a frame either way (`,` `.`), a jump to `t`
    /// (Home, End), or a relative seek.
    pub fn step_frame(&mut self, id: u32, dir: i32) {
        if let Some(e) = self.entity_mut(id) {
            let t = e.asset.adjacent_frame(e.play_t, dir);
            e.seek_to(t);
        }
    }

    pub fn seek_clip_to(&mut self, id: u32, t: f64) {
        if let Some(e) = self.entity_mut(id) {
            // The very end shows the last frame rather than wrapping to the first.
            let end = (e.asset.duration.as_secs_f64() - 1e-4).max(0.0);
            e.seek_to(t.clamp(0.0, end));
        }
    }

    pub fn seek_clip(&mut self, id: u32, dt: f64) {
        if let Some(e) = self.entity_mut(id) {
            let d = e.asset.duration.as_secs_f64().max(1e-3);
            e.seek_to((e.play_t + dt).rem_euclid(d));
        }
    }

    /// M: sound on or off for the selected videos that have it.
    pub fn toggle_mute(&mut self) {
        let sel = self.selection.clone();
        let vids: Vec<&mut Entity> = self.entities.iter_mut().filter(|e| sel.contains(&e.id) && e.has_audio()).collect();
        let mute = !vids.iter().all(|e| e.muted);
        for e in vids {
            e.muted = mute;
        }
    }

    /// Keep each audible video's sound playing in step with its clock: the sound's own clock
    /// leads while it plays (so picture follows sound), and a seek moves the sound.
    pub fn sync_audio(&mut self) {
        let mut live = std::mem::take(&mut self.audio);
        for e in &mut self.entities {
            let want = e.playing && !e.muted && e.has_audio();
            let Some(path) = e.asset.video_path().filter(|_| want) else { continue };
            let (player, followed) = live.remove(&e.id).unwrap_or_else(|| {
                let p = rune::Player::audio(path);
                p.set_looping(true);
                p.seek(e.play_t);
                (p, e.seek_gen)
            });
            if followed != e.seek_gen {
                player.seek(e.play_t);
            }
            if !player.is_playing() {
                player.play();
            }
            if player.state() == rune::PlayerState::Playing {
                let t = player.time();
                if (t - e.play_t).abs() < 1.0 || (e.play_t - t).abs() > e.asset.duration.as_secs_f64() * 0.5 {
                    e.play_t = t;
                }
            }
            self.audio.insert(e.id, (player, e.seek_gen));
        }
        // The rest (paused, muted, gone) stop as they drop.
        for (p, _) in live.values() {
            p.pause();
        }
    }

    /// Advance clocks by `dt`; true when the view shows the change: a selected clip's playback
    /// bar, or an on-screen clip's progress hairline moving by a whole pixel.
    pub fn tick(&mut self, dt: f64) -> bool {
        let mut shown = false;
        for e in &mut self.entities {
            if e.playing && e.asset.animated() {
                let dur = e.asset.duration.as_secs_f64().max(1e-3);
                let before = e.play_t;
                e.play_t = (e.play_t + dt).rem_euclid(dur);
                if self.selection.contains(&e.id) {
                    shown = true;
                } else if !self.bare {
                    let r = self.cam.screen_rect(e.rect());
                    let on_screen = r[0] < self.canvas[2] && r[0] + r[2] > 0.0 && r[1] < self.canvas[3] && r[1] + r[3] > 0.0;
                    let px = |t: f64| (t / dur * f64::from(r[2])).floor();
                    shown |= on_screen && px(before) != px(e.play_t);
                }
            }
            if e.params.animated() {
                e.fx_t += dt;
            }
        }
        shown
    }

    pub fn animating(&self) -> bool {
        self.cam.anim.is_some() || self.zoom_to.is_some() || self.perf.wants_frames() || self.entities.iter().any(|e| (e.playing && e.asset.animated()) || e.params.animated())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(id: u64, w: u32, h: u32) -> Arc<Asset> {
        Arc::new(crate::media::test_asset(id, w, h))
    }

    /// A 10 s, two-frame GIF-like asset.
    fn clip(id: u64, w: u32, h: u32) -> Arc<Asset> {
        let mut a = crate::media::test_asset(id, w, h);
        a.frames[0].delay = std::time::Duration::from_secs(5);
        a.frames.push(crate::media::Frame { rgba: a.frames[0].rgba.clone(), ..a.frames[0] });
        a.duration = std::time::Duration::from_secs(10);
        Arc::new(a)
    }

    #[test]
    fn unselected_playback_redraws_only_when_its_hairline_moves_a_pixel() {
        let mut a = App { canvas: [0.0, 0.0, 1000.0, 800.0], ..App::default() };
        a.place(vec![clip(1, 100, 100)], [0.0, 0.0], false);
        a.selection.clear();
        let id = a.entities[0].id;
        a.entity_mut(id).expect("placed").playing = true;
        // 100 px wide over 10 s: a pixel every 0.1 s.
        a.cam.set(a.cam.pan, 1.0);
        let w = a.cam.screen_rect(a.entities[0].rect())[2];
        assert!((w - 100.0).abs() < 1e-3, "rect width {w}");
        assert!(!a.tick(0.01), "under a pixel");
        assert!(a.tick(0.1), "a whole pixel");
        a.bare = true;
        assert!(!a.tick(0.5), "hidden chrome hides the hairline");
        a.bare = false;
        a.cam.set([100_000.0, 0.0], 1.0);
        assert!(!a.tick(0.5), "off screen");
    }

    #[test]
    fn placing_two_centres_the_block_on_the_anchor() {
        let mut a = App::default();
        a.place(vec![asset(1, 100, 100), asset(2, 200, 100)], [0.0, 0.0], false);
        let b = a.bounds(&a.selection.clone()).expect("bounds");
        assert_eq!(b, [-212.5, -50.0, 425.0, 100.0]);
        // Largest first, from the left.
        let x_of = |w: f32| a.entities.iter().find(|e| e.size[0] == w).map(|e| e.pos[0]).expect("placed");
        assert!(x_of(200.0) < x_of(100.0));
    }

    #[test]
    fn resizing_the_window_keeps_the_view_centred() {
        let mut a = App::default();
        a.resize_canvas([0.0, 0.0, 1000.0, 800.0]);
        a.cam.set([10.0, 20.0], 0.5);
        assert_eq!(a.cam.pan, [10.0, 20.0], "the first layout doesn't pan");
        let centre = |a: &App| a.cam.world([a.canvas[2] / 2.0, a.canvas[3] / 2.0]);
        let before = centre(&a);
        a.resize_canvas([0.0, 0.0, 1400.0, 600.0]);
        assert_eq!(centre(&a), before);
    }

    #[test]
    fn new_media_after_an_original_palette_takes_its_own_original() {
        let mut a = App::default();
        let coloured = |id: u64, c: [f32; 4]| {
            let mut x = crate::media::test_asset(id, 10, 10);
            x.palette = Some(vec![c, [1.0; 4]]);
            Arc::new(x)
        };
        a.place(vec![coloured(1, [1.0, 0.0, 0.0, 1.0])], [0.0, 0.0], false);
        a.set_palette(crate::effects::ORIGINAL_ID);
        a.place(vec![coloured(2, [0.0, 0.0, 1.0, 1.0])], [0.0, 0.0], false);
        let second = &a.entities[1].params.palette;
        assert_eq!(second.id, crate::effects::ORIGINAL_ID);
        assert_eq!(Some(second.colors.clone()), a.entities[1].asset.original_palette().map(|p| p.colors));
        // Media without an Original (video) starts on Black & White.
        a.place(vec![asset(3, 10, 10)], [0.0, 0.0], false);
        assert_eq!(a.entities[2].params.palette.id, crate::effects::presets()[0].id);
    }

    #[test]
    fn delete_and_duplicate_undo_as_one_step_each() {
        let mut a = App::default();
        a.place(vec![asset(1, 10, 10), asset(2, 10, 10)], [0.0, 0.0], false);
        a.next_id = 3;
        a.duplicate_selection();
        assert_eq!(a.entities.len(), 4);
        assert!(a.selection.iter().all(|id| *id >= 3));
        a.delete_selection();
        assert_eq!(a.entities.len(), 2);
        assert!(a.undo());
        assert_eq!(a.entities.len(), 4);
        assert!(a.undo());
        assert_eq!(a.entities.len(), 2);
        assert!(a.redo());
        assert_eq!(a.entities.len(), 4);
    }

    #[test]
    fn duplicate_names_are_unique() {
        let mut a = App::default();
        a.place(vec![asset(1, 10, 10)], [0.0, 0.0], false);
        a.next_id = 2;
        a.duplicate_selection();
        a.duplicate_selection();
        let names: Vec<&str> = a.entities.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["a1.png", "a1 2.png", "a1 3.png"]);
    }

    #[test]
    fn zoom_about_keeps_the_point_under_the_pointer() {
        let mut a = App::default();
        let q = [120.0, 80.0];
        let before = a.cam.world(q);
        a.cam.zoom_about(q, 1.6);
        let after = a.cam.world(q);
        assert!((before[0] - after[0]).abs() < 1e-3 && (before[1] - after[1]).abs() < 1e-3);
    }

    #[test]
    fn editing_a_preset_forks_it_and_one_undo_takes_both_back() {
        let mut a = App::default();
        a.place(vec![asset(1, 10, 10), asset(2, 10, 10)], [0.0, 0.0], false);
        let (one, two) = (a.entities[0].id, a.entities[1].id);
        a.select_only(one);
        a.open_picker(1);
        a.pick_oklch(crate::color::Oklch { l: 0.6, c: 0.2, h: 30.0, a: 1.0 });
        a.pick_oklch(crate::color::Oklch { l: 0.7, c: 0.2, h: 30.0, a: 1.0 });
        a.close_picker();
        let p = a.entity(one).map(|e| e.params.palette.clone()).expect("one");
        assert!(p.id.starts_with("cstm_") && p.name == "Custom 1");
        assert_eq!(a.palettes, vec![p.clone()]);
        assert_eq!(a.entity(two).map(|e| e.params.palette.id.clone()).as_deref(), Some("blackAndWhite"), "only the selection changes");
        // A user palette edits in place.
        a.add_palette_color();
        assert_eq!(a.palettes[0].colors.len(), 3);
        assert_eq!(a.palettes[0].id, p.id);
        assert!(a.undo());
        assert!(a.undo(), "the picker session was one step");
        assert!(a.palettes.is_empty());
        assert_eq!(a.entity(one).map(|e| e.params.palette.id.clone()).as_deref(), Some("blackAndWhite"));
    }

    #[test]
    fn deleting_a_palette_moves_the_selection_using_it_to_the_first_preset() {
        let mut a = App::default();
        a.place(vec![asset(1, 10, 10), asset(2, 10, 10)], [0.0, 0.0], false);
        a.add_palette_color();
        let id = a.palettes[0].id.clone();
        let (one, two) = (a.entities[0].id, a.entities[1].id);
        a.select_only(one);
        a.delete_palette(&id);
        let pal = |a: &App, e: u32| a.entity(e).map(|e| e.params.palette.clone()).expect("entity");
        assert_eq!(pal(&a, one).id, crate::effects::presets()[0].id);
        assert_eq!(pal(&a, two).id, id, "unselected keep their copy");
        assert!(a.palettes.is_empty());
        assert!(a.undo());
        assert_eq!((pal(&a, one).id, a.palettes.len()), (id, 1), "one undo brings both back");
    }

    #[test]
    fn an_eyedropper_pick_lands_in_the_open_picker_session() {
        let mut a = App::default();
        a.place(vec![asset(1, 10, 10)], [0.0, 0.0], false);
        let undo = a.undo.len();
        a.open_picker(0);
        a.loader.sampled(Some([1.0, 0.5, 0.0, 1.0]));
        a.loader.sampled(None);
        for c in a.loader.drain_sampled().into_iter().flatten() {
            a.pick_rgba(c);
        }
        assert_eq!(a.focus().map(|e| e.params.palette.colors[0]), Some([1.0, 0.5, 0.0, 1.0]));
        assert_eq!(a.hex_edit.text, crate::color::hex([1.0, 0.5, 0.0, 1.0]));
        a.close_picker();
        assert_eq!(a.undo.len(), undo + 1, "the session is one step");
        // With the picker closed, a late pick changes nothing.
        a.pick_rgba([0.0, 1.0, 0.0, 1.0]);
        assert_eq!(a.focus().map(|e| e.params.palette.colors[0]), Some([1.0, 0.5, 0.0, 1.0]));
    }

    #[test]
    fn deletions_turn_to_dust_unless_off_reduced_or_too_many() {
        let mut a = App::default();
        a.place(vec![asset(1, 10, 10), asset(2, 10, 10)], [0.0, 0.0], false);
        a.delete_selection();
        assert_eq!(a.dust.iter().map(|d| d.entity).collect::<Vec<_>>(), [1, 2]);
        assert!(a.dust_until > a.now);
        a.dust.clear();
        a.undo();
        a.reduced_motion = true;
        a.select_all();
        a.delete_selection();
        assert!(a.dust.is_empty(), "Reduce Motion turns it off by default");
        a.undo();
        crate::prefs::set_fancy_deletions(&mut a, true);
        a.select_all();
        a.delete_selection();
        assert_eq!(a.dust.len(), 2, "an explicit choice wins");
        a.dust.clear();
        a.undo();
        let many: Vec<_> = (10..10 + DUST_MAX_BATCH as u64).map(|i| asset(i, 10, 10)).collect();
        a.place(many, [0.0, 0.0], false);
        a.select_all();
        a.delete_selection();
        assert!(a.dust.is_empty(), "past the batch limit, deletions are plain");
    }

    #[test]
    fn the_fancy_preference_keeps_the_webs_other_effect() {
        let mut a = App::default();
        crate::prefs::set_fancy_deletions(&mut a, false);
        assert_eq!(a.prefs.get::<String>("fancyEffects").as_deref(), Some("prismWake"));
        crate::prefs::set_fancy_deletions(&mut a, true);
        assert_eq!(a.prefs.get::<String>("fancyEffects").as_deref(), Some("all"));
        a.prefs.set("fancyEffects", &serde_json::Value::from("deletions")).expect("set");
        crate::prefs::set_fancy_deletions(&mut a, false);
        assert_eq!(a.prefs.get::<String>("fancyEffects").as_deref(), Some("none"));
    }

    /// Two images on Black & White, the first selected, nothing in the history.
    fn picked_app() -> App {
        let mut a = App::default();
        a.place(vec![asset(1, 10, 10), asset(2, 10, 10)], [0.0, 0.0], false);
        let one = a.entities[0].id;
        a.select_only(one);
        a.undo.clear();
        a
    }

    fn colours(a: &App) -> Vec<crate::effects::Rgba> {
        a.focus().map(|e| e.params.palette.colors.clone()).expect("focus")
    }

    const RED: crate::color::Oklch = crate::color::Oklch { l: 0.6, c: 0.2, h: 30.0, a: 1.0 };

    #[test]
    fn removing_a_colour_from_the_picker_ends_its_session() {
        let mut a = picked_app();
        let before = colours(&a);
        a.add_palette_color();
        a.open_picker(2);
        a.pick_oklch(RED);
        a.remove_palette_color(2);
        assert!(a.editing.is_none(), "no session left open");
        // Later edits are their own steps.
        a.edit(|p| p.preserve_colors = !p.preserve_colors);
        assert!(a.undo());
        assert!(!a.focus().expect("focus").params.preserve_colors, "the toggle undoes alone");
        assert!(a.undo(), "the removal");
        assert_eq!(colours(&a).len(), 3);
        assert!(a.undo(), "the picked colour");
        assert!(a.undo(), "the added colour");
        assert_eq!(colours(&a), before);
        assert!(!a.undo(), "nothing else");
    }

    #[test]
    fn undo_with_the_picker_open_takes_back_its_colour() {
        let mut a = picked_app();
        let before = colours(&a);
        a.open_picker(1);
        a.pick_oklch(RED);
        assert!(a.undo());
        assert_eq!(colours(&a), before);
        assert!(a.picker.is_none() && a.editing.is_none());
        assert!(a.redo());
        assert_ne!(colours(&a), before);
        // And everything after is undoable again.
        a.edit(|p| p.reverse_palette = true);
        assert!(a.undo());
        assert!(!a.focus().expect("focus").params.reverse_palette);
    }

    #[test]
    fn a_step_taken_mid_session_keeps_the_history_in_order() {
        let mut a = picked_app();
        let before = colours(&a);
        a.open_picker(1);
        a.pick_oklch(RED);
        let picked = colours(&a);
        a.duplicate_selection();
        // The picker carries on in a session of its own.
        a.pick_oklch(crate::color::Oklch { l: 0.3, ..RED });
        a.close_picker();
        assert!(a.undo(), "the second colour");
        assert!(a.undo(), "the duplicate");
        assert_eq!(a.entities.len(), 2);
        assert_eq!(colours(&a), picked);
        assert!(a.undo(), "the first colour");
        assert_eq!(colours(&a), before);
    }

    #[test]
    fn opening_and_closing_the_picker_without_a_change_leaves_no_step() {
        let mut a = picked_app();
        a.open_picker(0);
        a.close_picker();
        a.begin_edit();
        a.end_edit();
        assert!(a.undo.is_empty());
    }

    #[test]
    fn a_palette_keeps_two_colours_and_at_most_sixteen() {
        let mut a = App::default();
        a.place(vec![asset(1, 10, 10)], [0.0, 0.0], false);
        a.remove_palette_color(0);
        assert_eq!(a.focus().map(|e| e.params.palette.colors.len()), Some(2));
        assert!(a.palettes.is_empty() && a.undo.len() == 1, "a no-op edit forks nothing");
        for _ in 0..20 {
            a.add_palette_color();
        }
        assert_eq!(a.focus().map(|e| e.params.palette.colors.len()), Some(16));
    }

    fn stored_app(st: &Arc<dyn Store>) -> App {
        let mut a = App::default();
        a.store = Some(st.clone());
        a.saver = Some(Saver::new(st.clone(), a.loader.clone()));
        a
    }

    /// Wait for the workspaces being read on workers and take them in.
    fn settle_loads(a: &mut App) {
        for _ in 0..500 {
            for d in a.loader.drain_workspaces() {
                if let crate::media::WorkspaceDone::Loaded { tab, imported, result } = d {
                    a.receive_workspace(&tab, imported, result);
                }
            }
            if a.tabs.iter().all(|t| t.loading.is_none()) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("workspaces never finished reading");
    }

    #[test]
    fn tabs_keep_their_own_workspace_and_history() {
        let mut a = App::default();
        a.new_tab();
        assert_eq!(a.tabs.len(), 1, "a blank tab isn't doubled");
        a.place(vec![asset(1, 10, 10)], [0.0, 0.0], false);
        a.new_tab();
        assert_eq!((a.tabs.len(), a.active), (2, 1));
        assert!(a.entities.is_empty() && a.undo.is_empty());
        a.place(vec![asset(2, 10, 10), asset(3, 10, 10)], [0.0, 0.0], false);
        let second: Vec<u32> = a.entities.iter().map(|e| e.id).collect();
        a.switch_tab(0);
        assert_eq!(a.entities.len(), 1);
        assert!(!second.contains(&a.entities[0].id), "ids are unique across tabs");
        assert!(a.undo());
        assert!(a.entities.is_empty(), "each tab undoes its own changes");
        a.cycle_tab(1);
        assert_eq!(a.entities.len(), 2);
        a.close_tab(1);
        assert_eq!((a.tabs.len(), a.active), (1, 0));
        a.close_tab(0);
        assert_eq!(a.tabs.len(), 1, "closing the last tab leaves a blank one");
        assert!(a.entities.is_empty());
    }

    #[test]
    fn workspaces_autosave_and_reopen() {
        let st: Arc<dyn Store> = Arc::new(crate::store::LocalStore::new(crate::store::test_dir("autosave")));
        let mut a = stored_app(&st);
        a.place(vec![asset(1, 10, 10)], [0.0, 0.0], false);
        let first = a.tab().id.clone();
        assert!(a.needs_save());
        assert!(a.autosave().is_some(), "waits a moment");
        a.now = 2.0;
        assert!(a.autosave().is_none());
        assert!(!a.needs_save());
        a.new_tab();
        a.place(vec![asset(2, 10, 10), asset(3, 10, 10)], [0.0, 0.0], false);
        a.rename_tab("  Second  ");
        let second = a.tab().id.clone();
        a.switch_tab(0);
        // Moving the view of a stored workspace saves it too.
        a.cam.set([40.0, 40.0], 1.0);
        assert!(a.needs_save());
        a.flush();
        let names: Vec<String> = st.list().expect("list").into_iter().map(|m| m.name).collect();
        assert_eq!(names.len(), 2);
        assert!(names.contains(&"Second".to_string()));

        let mut b = stored_app(&st);
        b.restore_tabs(&[first.clone(), second.clone(), "gone".into()], Some(&second));
        assert_eq!(b.tabs.len(), 2, "tabs whose workspace is gone are skipped");
        assert_eq!(b.active, 1);
        assert!(b.loading().is_some());
        assert!(!b.needs_save(), "a workspace being read never saves");
        settle_loads(&mut b);
        assert_eq!(b.entities.len(), 2);
        assert!(!b.needs_save());
        b.switch_tab(0);
        settle_loads(&mut b);
        assert_eq!(b.entities.len(), 1);
        assert_eq!((b.cam.pan, b.cam.scale), ([40.0, 40.0], 1.0), "the view comes back");
        b.delete_workspace(&second);
        b.flush();
        assert_eq!(b.tabs.len(), 1);
        assert_eq!(st.list().expect("list").len(), 1);
    }

    #[test]
    fn marquee_subtracts_from_the_selection() {
        let mut a = App::default();
        a.cam.set([0.0, 0.0], 1.0);
        a.place(vec![asset(1, 100, 100), asset(2, 100, 100)], [0.0, 0.0], false);
        let left = a.entity(1).expect("1").rect();
        a.marquee = Some(Marquee { start: [left[0] + 1.0, left[1] + 1.0], end: [left[0] + 5.0, left[1] + 5.0], mode: MarqueeMode::Subtract, base: a.selection.clone() });
        a.update_marquee();
        assert_eq!(a.selection.len(), 1);
        assert!(!a.selection.contains(&1));
    }
}
