//! App state: entities on an infinite canvas, the camera, selection, undo and the commands that
//! change them. World units are media pixels: an image enters at its native pixel size.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use crate::effects::Params;
use crate::media::{Asset, Loader};

pub const MIN_SCALE: f32 = 0.005;
pub const MAX_SCALE: f32 = 8.0;
/// Snap cell and layout gap, in world units.
pub const GRID: f32 = 125.0;
const UNDO_CAP: usize = 100;
/// The titlebar band's height in points: the canvas runs under it, the traffic lights sit in it.
pub const TITLEBAR: f32 = 52.0;

#[derive(Clone)]
pub struct Entity {
    pub id: u32,
    pub name: String,
    pub asset: Arc<Asset>,
    /// Top-left, world units.
    pub pos: [f32; 2],
    pub size: [f32; 2],
    pub z: u32,
    pub params: Params,
    /// GIF playback.
    pub playing: bool,
    pub play_t: f64,
    /// Flowing glass's own clock.
    pub fx_t: f64,
}

impl Entity {
    pub fn rect(&self) -> [f32; 4] {
        [self.pos[0], self.pos[1], self.size[0], self.size[1]]
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
}

#[derive(Clone)]
pub struct Snapshot {
    entities: Vec<Entity>,
    selection: BTreeSet<u32>,
}

pub struct Export {
    pub entity: u32,
    pub path: PathBuf,
}

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

    pub fn label(self) -> &'static str {
        match self {
            Lensing::Off => "Lensing",
            Lensing::Subtle => "Lensing: Subtle",
            Lensing::Extreme => "Lensing: Extreme",
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
    next_asset: u64,
    pub toasts: Vec<Toast>,
    pub exports: Vec<Export>,
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
            cam: Camera { pan: [0.0, 0.0], scale: 0.5, anim: None },
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
            next_asset: 1,
            toasts: Vec::new(),
            exports: Vec::new(),
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
        Snapshot { entities: self.entities.clone(), selection: self.selection.clone() }
    }

    pub fn push_undo(&mut self, s: Snapshot) {
        self.undo.push(s);
        if self.undo.len() > UNDO_CAP {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    /// Record the current state as one undo step, before a change.
    pub fn checkpoint(&mut self) {
        let s = self.snapshot();
        self.push_undo(s);
    }

    fn restore(&mut self, s: Snapshot) {
        // Playback clocks keep running across undo: take them from the live entities.
        let live: Vec<(u32, bool, f64)> = self.entities.iter().map(|e| (e.id, e.playing, e.play_t)).collect();
        self.entities = s.entities;
        for e in &mut self.entities {
            if let Some((_, p, t)) = live.iter().find(|(id, ..)| *id == e.id) {
                (e.playing, e.play_t) = (*p, *t);
            }
        }
        self.selection = s.selection.into_iter().filter(|id| self.entity(*id).is_some()).collect();
    }

    pub fn undo(&mut self) -> bool {
        let Some(s) = self.undo.pop() else { return false };
        let now = self.snapshot();
        self.redo.push(now);
        self.restore(s);
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(s) = self.redo.pop() else { return false };
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

    pub fn begin_edit(&mut self) {
        if self.editing.is_none() && !self.selection.is_empty() {
            self.editing = Some(self.snapshot());
        }
    }

    pub fn end_edit(&mut self) {
        if let Some(s) = self.editing.take() {
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
        let batch = self.next_batch;
        self.next_batch += 1;
        self.batches.push(Batch { id: batch, at, waiting: paths.len(), ready: Vec::new() });
        for p in paths {
            let asset = self.next_asset;
            self.next_asset += 1;
            self.pending += 1;
            self.loader.load(asset, p, batch);
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
        order.sort_by(|a, b| (b.width * b.height).cmp(&(a.width * a.height)));
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
            self.entities.push(Entity {
                id,
                name: a.name.clone(),
                size: [a.width as f32, a.height as f32],
                asset: a,
                pos,
                z: self.next_z,
                params: self.last_params.clone(),
                playing: animated,
                play_t: 0.0,
                fx_t: 0.0,
            });
            self.next_z += 1;
            self.selection.insert(id);
        }
        if fit {
            self.fit_selection();
        }
    }

    pub fn delete_selection(&mut self) {
        if self.selection.is_empty() {
            return;
        }
        self.checkpoint();
        let sel = std::mem::take(&mut self.selection);
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
            self.next_id += 1;
            e.z = self.next_z;
            self.next_z += 1;
            e.pos = [e.pos[0] + 30.0, e.pos[1] + 30.0];
            e.name = self.unique_name(&e.name);
            e.play_t = 0.0;
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
            e.play_t = (e.play_t + dt).rem_euclid(d.max(1e-3));
        }
    }

    /// Advance clocks by `dt`; true when a selected clip's progress moved (the view shows it).
    pub fn tick(&mut self, dt: f64) -> bool {
        let mut shown = false;
        for e in &mut self.entities {
            if e.playing && e.asset.animated() {
                e.play_t = (e.play_t + dt).rem_euclid(e.asset.duration.as_secs_f64().max(1e-3));
                shown |= self.selection.contains(&e.id);
            }
            if e.params.animated() {
                e.fx_t += dt;
            }
        }
        shown
    }

    pub fn animating(&self) -> bool {
        self.cam.anim.is_some() || self.zoom_to.is_some() || self.entities.iter().any(|e| (e.playing && e.asset.animated()) || e.params.animated())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::Frame;
    use std::time::Duration;

    fn asset(id: u64, w: u32, h: u32) -> Arc<Asset> {
        Arc::new(Asset { id, name: format!("a{id}.png"), width: w, height: h, frames: vec![Frame { rgba: vec![], delay: Duration::ZERO }], duration: Duration::ZERO })
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
