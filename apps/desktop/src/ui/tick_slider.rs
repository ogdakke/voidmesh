//! The web app's infinite tick slider (`components/ui/infinite-slider/`) and the time control
//! built on it (`components/desktop-time-slider/`, `components/ui/time-slider/`).
//!
//! A strip of ticks scrolls under a fixed centre pointer. Drag it (pointer travel maps 1:1 to the
//! scroll offset, dragging right lowers the value), flick it to coast on momentum, scroll it
//! with the wheel or trackpad, or step it with the arrow, Page, Home and End keys. When the
//! motion stops it settles on the nearest step and, after `commit_delay_ms`, commits. Bounded
//! sliders rubber-band past their ends while dragged and spring back; the wheel and keys clamp.
//!
//! The engine is a port of `slider-engine.ts` (with `lib/touch-scroll`'s scroller, spring-back
//! and velocity tracker) and keeps its constants. It runs on the app's frame clock:
//!
//! - The widget's handlers move it directly; anything that keeps moving afterwards (momentum,
//!   the spring back, the settle, a seek to an external value, the wheel and commit debounces)
//!   is stepped by [`step`], which the app calls from its `poll` every frame. `step` asks Rune
//!   for the next frame (`Tx::wake_after`) only while something moves or a debounce is due, so a
//!   still slider costs no frames.
//! - [`step`] is also how the app feeds it the value it should show ([`Source`]): an external
//!   value it seeks to when it changes (the React `value` prop), or a value it follows exactly
//!   every frame while auto-playing (`TimeSlider`'s `driveValue`). Whatever the user is doing
//!   wins: a drag, momentum, spring, settle or pending wheel/key settle holds external values off
//!   until it ends.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use rune::{Color, Cursor, Drag, El, Phase, Tx, WheelEvent, col, el, icon, row, text};

use super::look::{Look, SMALL};
use super::widgets::{PAUSE, PLAY};

/// Rubber-band resistance when dragging past a bound.
const RUBBER_BAND: f64 = 0.3;
/// Minimum release velocity (px/ms) for a fling.
const FLING_MIN: f64 = 0.05;
/// Fastest fling (px/ms); keeps the coasting ticks readable.
const FLING_MAX: f64 = 4.0;
/// The settle onto a step, ms, ease-out cubic.
const SNAP_MS: f64 = 120.0;
/// The glide to a changed external value, ms, ease-out cubic.
const SEEK_MS: f64 = 200.0;
/// Quiet time after the last wheel or key step before settling, ms.
const WHEEL_SNAP_MS: f64 = 100.0;
/// A release this long (ms) after the last move is a release from rest: no fling. The web
/// tracker keeps its last samples however old they are, so letting go after holding still
/// flings at the speed the drag had before stopping; this is `lib/touch-scroll`'s own velocity
/// horizon.
const STALE_RELEASE_MS: f64 = 100.0;
/// `DecelerationRate.REASONABLE`: velocity is multiplied by this every ms.
const DECELERATION: f64 = 0.995;
/// Momentum ends below this velocity (px/ms).
const SCROLL_STOP: f64 = 0.01;
/// Spring-back response, seconds.
const SPRING_RESPONSE: f64 = 0.4;
/// Spring-back settles when both its offset (px) and velocity fall under these.
const SPRING_STOP_OFFSET: f64 = 0.1;
const SPRING_STOP_VELOCITY: f64 = 0.01;

/// `slider-renderer.ts` `defaultRenderConfig` and `.infinite-slider` (`--tick-h: 2.5rem`).
const HEIGHT: f32 = 40.0;
const TICK_W: f32 = 2.0;
const TICK_H: f32 = 40.0;
const MAJOR_H: f32 = 48.0;
const POINTER_W: f32 = 2.0;
/// Every other tick index is drawn (the CSS `nth-child(odd)` transparent pattern).
const TICKS_PER_GROUP: i64 = 2;
/// The canvas mask: transparent to opaque over 15% of the width at each end.
const EDGE_FADE: f32 = 0.15;
/// Half the width ticks are laid out over before layout has reported the slider's width (its
/// first frame only); wide enough for the inspector so the ticks don't pop in a frame late.
const FIRST_FRAME_HALF_WIDTH: f32 = 240.0;

/// What a slider measures and how its ticks look. `TickSpec::DEFAULT` is `<InfiniteSlider>`'s
/// defaults; `TickSpec::TIME` is `<TimeSlider>`'s.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TickSpec {
    /// Value per step.
    pub step: f64,
    /// Bounds; leave either out for an infinite slider (rubber-banding needs both).
    pub min: Option<f64>,
    pub max: Option<f64>,
    /// Points between tick centres.
    pub tick_spacing: f32,
    /// Points of drag per step; `None` is `tick_spacing`.
    pub pixels_per_step: Option<f64>,
    /// Exponential falloff of tick height left of the centre, per point.
    pub falloff: f32,
    /// Height scale of distant ticks and of everything right of the centre.
    pub min_scale: f32,
    /// Height scale at the centre.
    pub max_scale: f32,
    /// Every Nth drawn tick is a taller major tick; 0 turns them off. Page Up and Down move this
    /// many steps (10 when 0).
    pub major_every: u32,
    /// How long after settling the commit callback runs, ms; a new gesture inside it cancels it,
    /// so consecutive flicks commit once.
    pub commit_delay_ms: f64,
}

impl TickSpec {
    pub const DEFAULT: TickSpec = TickSpec {
        step: 1.0,
        min: None,
        max: None,
        tick_spacing: 5.0,
        pixels_per_step: None,
        falloff: 0.06,
        min_scale: 0.4,
        max_scale: 1.0,
        major_every: 10,
        commit_delay_ms: 150.0,
    };

    /// Shader time: 0.005 a step, half a point of drag per step (so a drawn tick is 0.1 and a
    /// major tick 1.0), unbounded.
    pub const TIME: TickSpec = TickSpec { step: 0.005, pixels_per_step: Some(0.5), ..TickSpec::DEFAULT };

    fn pps(&self) -> f64 {
        self.pixels_per_step.unwrap_or(f64::from(self.tick_spacing))
    }

    fn offset_of(&self, value: f64) -> f64 {
        value / self.step * self.pps()
    }

    /// Offsets of the bounds, when both are set (the engine's finite mode).
    fn bounds(&self) -> Option<(f64, f64)> {
        Some((self.offset_of(self.min?), self.offset_of(self.max?)))
    }

    fn page_steps(&self) -> i32 {
        if self.major_every > 0 { self.major_every as i32 } else { 10 }
    }

    /// Decimals that show one step.
    fn decimals(&self) -> usize {
        let mut d = 0;
        while d < 6 && ((self.step * 10f64.powi(d as i32)).round() - self.step * 10f64.powi(d as i32)).abs() > 1e-9 {
            d += 1;
        }
        d
    }
}

impl Default for TickSpec {
    fn default() -> Self {
        TickSpec::DEFAULT
    }
}

/// How a slider reaches the app: where its state lives and what it reports.
pub struct Hooks<S> {
    pub access: fn(&mut S) -> &mut TickSlider,
    /// The first movement of a gesture (a drag's first move, a wheel delta, a key step); again
    /// only after the gesture committed.
    pub on_start: fn(&mut S),
    /// The value (rounded to a step, clamped) changed while moving.
    pub on_change: fn(&mut S, f64),
    /// The slider settled; `commit_delay_ms` after it came to rest.
    pub on_commit: fn(&mut S, f64),
}

impl<S> Clone for Hooks<S> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<S> Copy for Hooks<S> {}

/// The value the app gives the slider each frame, through [`step`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Source {
    /// The slider isn't on screen. It forgets its motion, and shows the next value at once.
    Hidden,
    /// The value to show. A change glides there (200 ms) unless the user is moving the slider.
    Value(f64),
    /// A value that moves on its own (auto-play), followed exactly every frame unless the user
    /// is moving the slider. Changes it causes aren't reported back.
    Driven(f64),
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Anim {
    #[default]
    Idle,
    /// A fling: `v0` px/ms decaying, `last` the distance applied so far.
    Momentum { v0: f64, last: f64 },
    /// Back to `boundary` from past it; `sign` is the overshoot's side.
    Spring { lambda: f64, c1: f64, c2: f64, boundary: f64, sign: f64 },
    Snap { from: f64, to: f64 },
    Seek { from: f64, to: f64 },
}

/// What one engine call reports, in the order the hooks run.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Out {
    start: bool,
    change: Option<f64>,
    commit: Option<f64>,
}

/// `VelocityTracker.calculate()`: a weighted recurrence over the last four samples.
#[derive(Clone, Copy, Debug, Default)]
struct Velocity {
    t: [f64; 4],
    x: [f64; 4],
    newest: usize,
    count: usize,
}

impl Velocity {
    fn reset(&mut self) {
        self.count = 0;
        self.newest = 0;
    }

    fn add(&mut self, t: f64, x: f64) {
        self.newest = (self.newest + 1) % 4;
        self.t[self.newest] = t;
        self.x[self.newest] = x;
        self.count = (self.count + 1).min(4);
    }

    /// Px per ms at the last sample.
    fn last_time(&self) -> Option<f64> {
        (self.count > 0).then_some(self.t[self.newest])
    }

    fn calculate(&self) -> f64 {
        let n = self.count;
        if n < 2 {
            return 0.0;
        }
        let at = |k: usize| (self.newest + 4 + 1 + k - n) % 4;
        let mut v = [0.0; 3];
        let mut len = 0;
        for k in 0..n - 1 {
            let (a, b) = (at(k), at(k + 1));
            let dt = self.t[b] - self.t[a];
            if dt > 0.0 {
                v[len] = (self.x[b] - self.x[a]) / dt;
                len += 1;
            }
        }
        match len {
            0 => 0.0,
            // Two samples are unreliable: dampen.
            1 => v[0] * 0.7,
            _ => {
                let mut prev = None;
                let mut cur: Option<f64> = None;
                for i in 0..len - 1 {
                    let blended = v[i] * 0.4 + v[i + 1] * 0.6;
                    cur = Some(match cur {
                        Some(c) => {
                            prev = Some(c);
                            c * 0.8 + blended * 0.2
                        }
                        None => blended,
                    });
                }
                let cur = cur.unwrap_or(v[0]);
                prev.map_or(cur, |p| p * 0.75 + cur * 0.25)
            }
        }
    }
}

/// A slider's state: keep one in app state per slider and hand it to [`tick_slider`] and
/// [`step`] through [`Hooks::access`].
#[derive(Debug, Default)]
pub struct TickSlider {
    /// Scroll offset in points: value / step × pixels per step.
    offset: f64,
    /// The value last reported through `on_change` (or shown, after a seek or drive).
    emitted: f64,
    pointer: bool,
    last_x: f64,
    velocity: Velocity,
    anim: Anim,
    /// When `anim` started, ms on the frame clock.
    anim_start: f64,
    /// When the wheel/key settle is due, ms.
    wheel_snap_at: Option<f64>,
    /// When the pending commit is due, and its value.
    commit_at: Option<(f64, f64)>,
    /// `on_start` ran and the gesture hasn't committed.
    started: bool,
    /// On screen since the last `Source::Hidden`.
    mounted: bool,
    /// The last `Source` value seen, to tell when it changes.
    external: Option<f64>,
    /// The frame clock (seconds) at the last `step`, and the instant it ran: places input
    /// events on the frame clock.
    clock: Option<(f64, Instant)>,
    /// The laid-out width.
    width: f32,
    out: Out,
}

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        0.0
    }
}

fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}

/// Input timestamps for the velocity tracker: ms since the first one this process saw. Kept
/// apart from the frame clock so the tracker only ever compares event times with each other.
fn input_ms(at: Instant) -> f64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    at.saturating_duration_since(*EPOCH.get_or_init(|| at)).as_secs_f64() * 1000.0
}

impl TickSlider {
    /// The scroll offset in points.
    #[cfg(test)]
    pub fn offset(&self) -> f64 {
        self.offset
    }


    /// The value shown: the offset rounded to a step and clamped.
    pub fn value(&self, spec: &TickSpec) -> f64 {
        let mut v = js_round(self.offset / spec.pps()) * spec.step;
        if let Some(min) = spec.min
            && v < min
        {
            v = min;
        }
        if let Some(max) = spec.max
            && v > max
        {
            v = max;
        }
        v
    }

    /// The user is moving it (dragging, coasting, springing back, settling, or between wheel or
    /// key steps); external values wait.
    pub fn interacting(&self) -> bool {
        self.pointer || matches!(self.anim, Anim::Momentum { .. } | Anim::Spring { .. } | Anim::Snap { .. }) || self.wheel_snap_at.is_some()
    }

    /// An input event's time on the frame clock, ms. Before the first `step` there is no frame
    /// clock yet, and input counts from the first event.
    fn frame_ms(&self, at: Instant) -> f64 {
        match self.clock {
            Some((t, then)) => {
                let d = if at >= then { at.duration_since(then).as_secs_f64() } else { -then.duration_since(at).as_secs_f64() };
                (t + d) * 1000.0
            }
            None => input_ms(at),
        }
    }

    /// How long until `step` has something to do, ms: 0 while animating.
    fn next_wake(&self, now: f64) -> Option<f64> {
        if self.anim != Anim::Idle {
            return Some(0.0);
        }
        [self.wheel_snap_at, self.commit_at.map(|c| c.0)].into_iter().flatten().map(|at| (at - now).max(0.0)).reduce(f64::min)
    }

    fn overshoot(spec: &TickSpec, offset: f64) -> f64 {
        match spec.bounds() {
            Some((lo, _)) if offset < lo => offset - lo,
            Some((_, hi)) if offset > hi => offset - hi,
            _ => 0.0,
        }
    }

    fn clamp(spec: &TickSpec, offset: f64) -> f64 {
        spec.bounds().map_or(offset, |(lo, hi)| offset.min(hi).max(lo))
    }

    fn stop(&mut self) {
        self.anim = Anim::Idle;
        self.wheel_snap_at = None;
    }

    fn begin(&mut self) {
        if !self.started {
            self.started = true;
            self.out.start = true;
        }
    }

    fn emit_change(&mut self, spec: &TickSpec) {
        let v = self.value(spec);
        if v != self.emitted {
            self.emitted = v;
            self.out.change = Some(v);
        }
    }

    fn emit_commit(&mut self, spec: &TickSpec, now: f64) {
        let v = self.value(spec);
        self.started = false;
        if spec.commit_delay_ms <= 0.0 {
            self.out.commit = Some(v);
        } else {
            self.commit_at = Some((now + spec.commit_delay_ms, v));
        }
    }

    fn start_snap(&mut self, spec: &TickSpec, now: f64) {
        let pps = spec.pps();
        let nearest = js_round(self.offset / pps) * pps;
        if (self.offset - nearest).abs() < 0.5 {
            self.offset = nearest;
            self.anim = Anim::Idle;
            self.emit_commit(spec, now);
            return;
        }
        self.anim = Anim::Snap { from: self.offset, to: nearest };
        self.anim_start = now;
    }

    fn spring(&mut self, velocity: f64, overshoot: f64, now: f64, spec: &TickSpec) {
        let boundary = Self::clamp(spec, self.offset);
        let lambda = 2.0 * std::f64::consts::PI / SPRING_RESPONSE;
        self.anim = Anim::Spring { lambda, c1: overshoot, c2: velocity * 1000.0 + lambda * overshoot, boundary, sign: sign(overshoot) };
        self.anim_start = now;
    }

    /// A press at `x` (points along the drag axis) at input time `t` (ms).
    fn pointer_down(&mut self, x: f64, t: f64) {
        self.stop();
        // A consecutive flick stays in the same transaction.
        self.commit_at = None;
        self.pointer = true;
        self.last_x = x;
        self.velocity.reset();
        self.velocity.add(t, x);
    }

    fn pointer_move(&mut self, spec: &TickSpec, x: f64, t: f64) {
        if !self.pointer {
            return;
        }
        self.begin();
        let delta = x - self.last_x;
        self.last_x = x;
        self.velocity.add(t, x);
        // Dragging right lowers the offset.
        self.offset = if Self::overshoot(spec, self.offset) != 0.0 {
            self.offset - delta * RUBBER_BAND
        } else {
            let next = self.offset - delta;
            match spec.bounds() {
                Some((lo, hi)) if next < lo || next > hi => {
                    let boundary = if next < lo { lo } else { hi };
                    boundary + (next - boundary) * RUBBER_BAND
                }
                _ => next,
            }
        };
        self.emit_change(spec);
    }

    /// The release, at `now` on the frame clock and `t` on the input clock.
    fn pointer_up(&mut self, spec: &TickSpec, now: f64, t: f64) {
        if !self.pointer {
            return;
        }
        self.pointer = false;
        let still = self.velocity.last_time().is_some_and(|last| t - last > STALE_RELEASE_MS);
        let v = if still { 0.0 } else { self.velocity.calculate() };
        let overshoot = Self::overshoot(spec, self.offset);
        if overshoot != 0.0 {
            self.spring(-v, overshoot, now, spec);
        } else if v.abs() > FLING_MIN {
            self.anim = Anim::Momentum { v0: sign(v) * v.abs().min(FLING_MAX), last: 0.0 };
            self.anim_start = now;
        } else {
            self.start_snap(spec, now);
        }
    }

    /// Wheel deltas as the DOM gives them: positive scrolls the value up.
    fn wheel(&mut self, spec: &TickSpec, dx: f64, dy: f64, now: f64) {
        // Undo a settle in flight so it doesn't pull toward a tick while scrolling.
        if let Anim::Snap { from, .. } = self.anim {
            self.offset = from;
        }
        self.stop();
        self.commit_at = None;
        self.begin();
        let raw = if dx.abs() > dy.abs() { dx } else { dy };
        // Fine sliders (less than a tick per step) scale the wheel down to their precision.
        let scale = (spec.pps() / f64::from(spec.tick_spacing)).min(1.0);
        self.offset = Self::clamp(spec, self.offset + raw * scale);
        self.emit_change(spec);
        self.wheel_snap_at = Some(now + WHEEL_SNAP_MS);
    }

    /// Keyboard: move `steps` steps, clamped, and settle after a pause like the wheel.
    fn step_by(&mut self, spec: &TickSpec, steps: i32, now: f64) {
        self.stop();
        self.commit_at = None;
        self.begin();
        self.offset = Self::clamp(spec, self.offset + f64::from(steps) * spec.pps());
        self.emit_change(spec);
        self.wheel_snap_at = Some(now + WHEEL_SNAP_MS);
    }

    /// Home (`false`) and End (`true`): to a bound, when there is one.
    fn step_to_limit(&mut self, spec: &TickSpec, end: bool, now: f64) {
        if let Some(b) = if end { spec.max } else { spec.min } {
            let steps = js_round((b - self.value(spec)) / spec.step);
            self.step_by(spec, steps.clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32, now);
        }
    }

    /// Follow an auto-playing value; false (and nothing changes) while the user moves it.
    fn drive(&mut self, spec: &TickSpec, value: f64) -> bool {
        if self.interacting() {
            return false;
        }
        self.stop();
        self.offset = spec.offset_of(value);
        // The web leaves its last reported value stale here, so a click on a driven slider can
        // report a change nobody made; remember what's shown instead.
        self.emitted = self.value(spec);
        true
    }

    /// Show `value`, gliding there when `animate`; nothing while the user moves it.
    fn set_value(&mut self, spec: &TickSpec, value: f64, animate: bool, now: f64) {
        let target = spec.offset_of(value);
        if (self.offset - target).abs() < 0.5 || self.interacting() || self.anim != Anim::Idle {
            return;
        }
        self.stop();
        if animate {
            self.anim = Anim::Seek { from: self.offset, to: target };
            self.anim_start = now;
        } else {
            self.offset = target;
            self.emitted = value;
        }
    }

    fn mount(&mut self, spec: &TickSpec, value: f64) {
        self.mounted = true;
        self.external = Some(value);
        self.offset = spec.offset_of(value);
        self.emitted = value;
    }

    fn sync(&mut self, spec: &TickSpec, source: Source, now: f64) {
        match source {
            Source::Hidden => {
                if self.mounted || self.anim != Anim::Idle || self.pointer {
                    *self = TickSlider { clock: self.clock, width: self.width, ..TickSlider::default() };
                }
            }
            Source::Value(v) if !self.mounted => self.mount(spec, v),
            Source::Value(v) => {
                if self.external != Some(v) {
                    self.external = Some(v);
                    self.set_value(spec, v, true, now);
                }
            }
            Source::Driven(v) if !self.mounted => self.mount(spec, v),
            Source::Driven(v) => {
                self.external = Some(v);
                self.drive(spec, v);
            }
        }
    }

    /// Run due debounces and the animation up to `now` (ms on the frame clock).
    fn advance(&mut self, spec: &TickSpec, now: f64) {
        if let Some(at) = self.wheel_snap_at
            && now >= at
        {
            self.wheel_snap_at = None;
            self.start_snap(spec, now);
        }
        if self.anim != Anim::Idle {
            self.tick(spec, now);
        }
        if let Some((at, v)) = self.commit_at
            && now >= at
        {
            self.commit_at = None;
            self.out.commit = Some(v);
        }
    }

    fn tick(&mut self, spec: &TickSpec, now: f64) {
        let elapsed = (now - self.anim_start).max(0.0);
        match self.anim {
            Anim::Idle => {}
            Anim::Momentum { v0, last } => {
                let coefficient = DECELERATION.powf(elapsed);
                let velocity = v0 * coefficient;
                if velocity.abs() < SCROLL_STOP {
                    self.start_snap(spec, now);
                } else {
                    let travelled = v0 / DECELERATION.ln() * (coefficient - 1.0);
                    // The fling is in pointer space; the offset runs the other way.
                    self.offset -= travelled - last;
                    self.anim = Anim::Momentum { v0, last: travelled };
                    let overshoot = Self::overshoot(spec, self.offset);
                    if overshoot != 0.0 {
                        self.spring(-velocity, overshoot, now, spec);
                    }
                }
            }
            Anim::Spring { lambda, c1, c2, boundary, sign: side } => {
                let t = elapsed / 1000.0;
                let decay = (-lambda * t).exp();
                let offset = (c1 + c2 * t) * decay;
                let velocity = (c2 - lambda * (c1 + c2 * t)) * decay;
                if offset.abs() < SPRING_STOP_OFFSET && velocity.abs() < SPRING_STOP_VELOCITY {
                    self.offset = Self::clamp(spec, self.offset);
                    self.start_snap(spec, now);
                } else if sign(offset) != 0.0 && sign(offset) != side {
                    // Crossing back over the bound: land on it rather than wobble.
                    self.offset = boundary;
                    self.start_snap(spec, now);
                } else {
                    self.offset = boundary + offset;
                }
            }
            Anim::Snap { from, to } => {
                let t = (elapsed / SNAP_MS).min(1.0);
                self.offset = from + (to - from) * ease_out_cubic(t);
                if t >= 1.0 {
                    self.offset = to;
                    self.anim = Anim::Idle;
                    self.emit_commit(spec, now);
                }
            }
            Anim::Seek { from, to } => {
                let t = (elapsed / SEEK_MS).min(1.0);
                self.offset = from + (to - from) * ease_out_cubic(t);
                if t >= 1.0 {
                    self.offset = to;
                    self.emitted = self.value(spec);
                    self.anim = Anim::Idle;
                }
            }
        }
        // A seek is the app's own change; reporting it would echo back (and into undo).
        if !matches!(self.anim, Anim::Seek { .. }) {
            self.emit_change(spec);
        }
    }
}

fn dispatch<S>(s: &mut S, hooks: Hooks<S>, out: Out) {
    if out.start {
        (hooks.on_start)(s);
    }
    if let Some(v) = out.change {
        (hooks.on_change)(s, v);
    }
    if let Some(v) = out.commit {
        (hooks.on_commit)(s, v);
    }
}

fn wake(tx: &mut Tx, ms: Option<f64>) {
    if let Some(ms) = ms {
        tx.wake_after(Duration::from_secs_f64(ms / 1000.0));
    }
}

/// Run an input event through the engine: `f` gets the slider, the event's frame-clock time and
/// its input time (ms).
fn input<S>(s: &mut S, tx: &mut Tx, hooks: Hooks<S>, f: impl FnOnce(&mut TickSlider, f64, f64)) {
    // Input fed to a headless runtime has no timestamp; it happens now.
    let at = tx.input_time().unwrap_or_else(Instant::now);
    let sl = (hooks.access)(s);
    let now = sl.frame_ms(at);
    f(sl, now, input_ms(at));
    let out = std::mem::take(&mut sl.out);
    wake(tx, sl.next_wake(now));
    dispatch(s, hooks, out);
    tx.instant();
}

/// Step a slider on the frame clock and feed it the app's value. Call it from `poll` every frame
/// with `poll`'s clock (seconds), whether or not the slider is on screen, and OR the result into
/// what `poll` returns: true when the slider moved or reported something, so the view should run.
/// It asks for the next frame itself while it moves, and for nothing when it's still.
pub fn step<S>(s: &mut S, now: f64, tx: &mut Tx, spec: &TickSpec, hooks: Hooks<S>, source: Source) -> bool {
    let sl = (hooks.access)(s);
    sl.clock = Some((now, Instant::now()));
    let now = now * 1000.0;
    let before = sl.offset;
    sl.sync(spec, source, now);
    sl.advance(spec, now);
    let moved = sl.offset != before;
    let out = std::mem::take(&mut sl.out);
    wake(tx, sl.next_wake(now));
    let reported = out != Out::default();
    dispatch(s, hooks, out);
    moved || reported
}

/// A tick in points from the slider's centre (its left edge), bottom-anchored.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Tick {
    index: i64,
    x: f32,
    y: f32,
    h: f32,
    major: bool,
}

/// `renderHorizontalTicks`: the ticks within `half` points of the centre (regular ones first,
/// majors after so they draw on top) and the pointer's `[x, y, h]`, all centre-relative.
fn layout_ticks(spec: &TickSpec, offset: f64, half: f32) -> (Vec<Tick>, [f32; 3]) {
    let spacing = f64::from(spec.tick_spacing);
    let pointer_h = if spec.major_every > 0 { MAJOR_H } else { TICK_H } * spec.max_scale;
    let min_tick = spec.min.map(|m| (m / spec.step).ceil() as i64);
    let max_tick = spec.max.map(|m| (m / spec.step).floor() as i64);
    let mut pointer_x = 0.0f64;
    if let Some(i) = min_tick {
        pointer_x = pointer_x.max(i as f64 * spacing - offset);
    }
    if let Some(i) = max_tick {
        let x = i as f64 * spacing - offset;
        if x < 0.0 {
            pointer_x = x;
        }
    }
    let pointer = [pointer_x as f32 - POINTER_W / 2.0, HEIGHT - pointer_h, pointer_h];
    if spacing <= 0.0 || !offset.is_finite() {
        return (Vec::new(), pointer);
    }
    let reach = f64::from(half) + spacing * 2.0;
    let first = ((offset - reach) / spacing).floor() as i64;
    let last = ((offset + reach) / spacing).ceil() as i64;
    let major_mod = i64::from(spec.major_every) * TICKS_PER_GROUP;
    let cull = f64::from(half + TICK_W);
    let (lo, hi) = (f64::from(spec.min_scale), f64::from(spec.max_scale));
    let mut ticks: Vec<Tick> = Vec::with_capacity(((last - first) / TICKS_PER_GROUP + 1).max(0) as usize);
    for i in first..=last {
        if min_tick.is_some_and(|m| i < m) || max_tick.is_some_and(|m| i > m) || i % TICKS_PER_GROUP != 0 {
            continue;
        }
        let x = i as f64 * spacing - offset;
        if x < -cull || x > cull {
            continue;
        }
        // Only ticks left of the pointer grow toward it.
        let scale = if x <= 0.0 { lo + (hi - lo) * (-x.abs() * f64::from(spec.falloff)).exp() } else { lo };
        let major = major_mod > 0 && i % major_mod == 0;
        let h = (f64::from(if major { MAJOR_H } else { TICK_H }) * scale) as f32;
        ticks.push(Tick { index: i, x: x as f32 - TICK_W / 2.0, y: HEIGHT - h, h, major });
    }
    ticks.sort_by_key(|t| t.major);
    (ticks, pointer)
}

/// `.infinite-slider`: a 40 pt strip of ticks under a fixed pointer, faded out at both ends.
/// `value` is what assistive technology reads; the strip shows `state`, which [`step`] keeps in
/// step with the app.
pub fn tick_slider<S: 'static>(l: &Look, key: &'static str, label: &str, spec: TickSpec, value: f64, state: &TickSlider, hooks: Hooks<S>) -> El {
    let half = if state.width > 0.0 { state.width / 2.0 } else { FIRST_FRAME_HALF_WIDTH };
    let (ticks, [px, py, ph]) = layout_ticks(&spec, state.offset, half);
    let mut anchor = el().w(0.0).h(HEIGHT);
    for t in &ticks {
        anchor = anchor.child(el().key(format!("t{}", t.index)).absolute(t.x, t.y).size(TICK_W, t.h).fill(if t.major { l.tick_major } else { l.tick }));
    }
    anchor = anchor.child(el().key("pointer").absolute(px, py).size(POINTER_W, ph).fill(l.tick_highlight));
    let fade = state.width * EDGE_FADE;
    let decimals = spec.decimals();
    let mut root = el()
        .key(key)
        .role("slider")
        .label(label)
        .focusable(true)
        .focus_ring(2.0, 0.0, l.primary)
        .w_full()
        .h(HEIGHT)
        .radius(8.0)
        .clip_fade_linear(fade, 0.0, fade, 0.0)
        .instant_changes()
        .cursor(if state.pointer { Cursor::Grabbing } else { Cursor::Grab })
        .on_layout_tx(move |s: &mut S, r: [f32; 4], tx: &mut Tx| {
            let sl = (hooks.access)(s);
            if (sl.width - r[2]).abs() > 0.5 {
                sl.width = r[2];
            } else {
                tx.live_only();
            }
        })
        .on_drag(move |s: &mut S, d: &mut Drag, tx: &mut Tx| {
            // Travel since the press in window points: the strip never moves under the pointer.
            let x = f64::from(d.dx);
            let phase = d.phase;
            input(s, tx, hooks, |sl, now, t| match phase {
                Phase::Down => sl.pointer_down(x, t),
                Phase::Move => sl.pointer_move(&spec, x, t),
                // A cancelled drag ends like a release, as `pointercancel` does.
                Phase::Up => sl.pointer_up(&spec, now, t),
            });
        })
        .on_wheel(move |s: &mut S, e: WheelEvent, tx: &mut Tx| {
            // Rune's deltas move content with the fingers; the DOM's scroll against them.
            input(s, tx, hooks, |sl, now, _| sl.wheel(&spec, -f64::from(e.dx), -f64::from(e.dy), now));
            true
        })
        .on_step(move |s: &mut S, steps: i32, tx: &mut Tx| {
            // Rune pages by 10; the slider pages by its major tick interval.
            let steps = if steps.abs() >= 10 { steps / 10 * spec.page_steps() } else { steps };
            input(s, tx, hooks, |sl, now, _| sl.step_by(&spec, steps, now));
        });
    if spec.min.is_some() || spec.max.is_some() {
        root = root.on_step_limit(move |s: &mut S, end: bool, tx: &mut Tx| input(s, tx, hooks, |sl, now, _| sl.step_to_limit(&spec, end, now)));
    }
    root = match (spec.min, spec.max) {
        (Some(min), Some(max)) => root.range_value(value, min, max).range_step(spec.step),
        _ => root.a11y_value(format!("{value:.decimals$}")),
    };
    root.child(row().absolute(0.0, 0.0).w_full().h(HEIGHT).justify_center().inert().a11y_hidden().child(anchor))
}

/// `DesktopTimeSlider`: the "Time" label ("Time (Mixed)" when the selection disagrees) over the
/// time strip, with the primary play/pause button floating at its left. Feed the slider through
/// [`step`] with [`TickSpec::TIME`] and `Source::Driven(time)` while playing (and not mixed),
/// `Source::Value(time)` otherwise. `hooks.on_start` should sync the selection's times and pause
/// it; changes aren't undo steps.
pub fn time_control<S: 'static>(l: &Look, mixed: bool, playing: bool, value: f64, state: &TickSlider, hooks: Hooks<S>, on_toggle: fn(&mut S)) -> El {
    let label = if mixed { "Time (Mixed)" } else { "Time" };
    let what = if playing { "Pause" } else { "Play" };
    let button = l.primary_button(
        el().key("time-play")
            .role("button")
            .label(what)
            .focusable(true)
            .focus_ring(2.0, 2.0, l.primary)
            .absolute(12.0, (HEIGHT - 28.0) / 2.0)
            .size(28.0, 28.0)
            .radius(14.0)
            .center()
            .press_scale(0.97)
            .cursor(Cursor::Pointer)
            .help(what)
            .on_press(on_toggle)
            .child(icon(if playing { &PAUSE } else { &PLAY }, 16.0).color(Color::WHITE)),
    );
    col()
        .key("time-control")
        .w_full()
        .pb(8.0)
        .child(row().px(12.0).pt(4.0).child(text(label).font(SMALL).color(l.text_muted)))
        .child(el().w_full().h(HEIGHT).child(tick_slider(l, "time", label, TickSpec::TIME, value, state, hooks)).child(button))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOUNDED: TickSpec = TickSpec { min: Some(0.0), max: Some(100.0), ..TickSpec::DEFAULT };

    /// Advance in 8 ms frames from `from` until idle (or `limit` ms), collecting reports.
    fn run(sl: &mut TickSlider, spec: &TickSpec, from: f64, limit: f64) -> (f64, Vec<Out>) {
        let mut now = from;
        let mut outs = Vec::new();
        while now < from + limit {
            now += 8.0;
            sl.advance(spec, now);
            outs.push(std::mem::take(&mut sl.out));
            if sl.next_wake(now).is_none() {
                break;
            }
        }
        (now, outs)
    }

    fn commits(outs: &[Out]) -> Vec<f64> {
        outs.iter().filter_map(|o| o.commit).collect()
    }

    /// A drag from 0 by `dx` per 8 ms move, `moves` times.
    fn drag(sl: &mut TickSlider, spec: &TickSpec, dx: f64, moves: usize) -> Vec<Out> {
        sl.pointer_down(0.0, 0.0);
        let mut outs = vec![std::mem::take(&mut sl.out)];
        for k in 1..=moves {
            sl.pointer_move(spec, dx * k as f64, 8.0 * k as f64);
            outs.push(std::mem::take(&mut sl.out));
        }
        outs
    }

    #[test]
    fn dragging_right_lowers_the_value_one_step_per_tick() {
        let spec = TickSpec::DEFAULT;
        let mut sl = TickSlider::default();
        let outs = drag(&mut sl, &spec, 5.0, 2);
        assert_eq!(sl.offset(), -10.0);
        assert_eq!(sl.value(&spec), -2.0);
        assert!(!outs[0].start, "a press alone doesn't start an interaction");
        assert!(outs[1].start);
        assert!(!outs[2].start, "start runs once per gesture");
        assert_eq!(outs[1].change, Some(-1.0));
        assert_eq!(outs[2].change, Some(-2.0));
    }

    #[test]
    fn time_spec_maps_half_a_point_to_a_step() {
        let spec = TickSpec::TIME;
        let mut sl = TickSlider::default();
        drag(&mut sl, &spec, -1.0, 10);
        assert!((sl.value(&spec) - 0.1).abs() < 1e-9);
        assert_eq!(spec.decimals(), 3);
    }

    #[test]
    fn a_slow_release_settles_on_the_nearest_step_and_commits_after_the_delay() {
        let spec = TickSpec::DEFAULT;
        let mut sl = TickSlider::default();
        sl.pointer_down(0.0, 0.0);
        sl.pointer_move(&spec, -7.0, 500.0);
        sl.pointer_move(&spec, -7.0, 1000.0);
        sl.out = Out::default();
        sl.pointer_up(&spec, 1000.0, 1000.0);
        assert!(matches!(sl.anim, Anim::Snap { .. }));
        let (end, outs) = run(&mut sl, &spec, 1000.0, 1000.0);
        assert_eq!(sl.offset(), 5.0);
        assert_eq!(commits(&outs), vec![1.0]);
        // Settles in 120 ms, then 150 ms to the commit.
        assert!((1270.0..1290.0).contains(&end), "{end}");
        assert!(!sl.started);
    }

    #[test]
    fn a_flick_coasts_decays_and_lands_on_a_step() {
        let spec = TickSpec::DEFAULT;
        let mut sl = TickSlider::default();
        drag(&mut sl, &spec, 10.0, 4); // 1.25 px/ms right
        let flung = sl.offset();
        sl.pointer_up(&spec, 32.0, 32.0);
        let Anim::Momentum { v0, .. } = sl.anim else { panic!("no momentum: {:?}", sl.anim) };
        assert!(v0 > 1.0 && v0 <= FLING_MAX);
        let (_, outs) = run(&mut sl, &spec, 32.0, 5000.0);
        // v0 / ln(0.995) is the full glide; it stops at 0.01 px/ms, so a little short of it.
        let glide = flung - sl.offset();
        assert!(glide > 150.0 && glide < v0 / -DECELERATION.ln() + spec.pps(), "{glide}");
        assert_eq!(sl.offset() % 5.0, 0.0);
        assert!(outs.iter().any(|o| o.change.is_some()));
        assert_eq!(commits(&outs), vec![sl.value(&spec)]);
        assert_eq!(sl.anim, Anim::Idle);
    }

    #[test]
    fn a_very_fast_flick_is_capped() {
        let spec = TickSpec::DEFAULT;
        let mut sl = TickSlider::default();
        drag(&mut sl, &spec, -400.0, 4);
        sl.pointer_up(&spec, 32.0, 32.0);
        assert_eq!(sl.anim, Anim::Momentum { v0: -FLING_MAX, last: 0.0 });
    }

    #[test]
    fn dragging_past_a_bound_rubber_bands_and_springs_back() {
        let spec = BOUNDED;
        let mut sl = TickSlider::default();
        sl.mount(&spec, 100.0);
        drag(&mut sl, &spec, -10.0, 4); // 40 px past the end
        assert!((sl.offset() - (500.0 + 40.0 * RUBBER_BAND)).abs() < 1e-9);
        assert_eq!(sl.value(&spec), 100.0, "the value clamps");
        sl.pointer_move(&spec, -40.0, 100.0);
        sl.pointer_up(&spec, 600.0, 100.0);
        assert!(matches!(sl.anim, Anim::Spring { .. }));
        let (_, outs) = run(&mut sl, &spec, 600.0, 3000.0);
        assert_eq!(sl.offset(), 500.0);
        assert_eq!(commits(&outs), vec![100.0]);
    }

    #[test]
    fn momentum_into_a_bound_springs_without_crossing_back() {
        let spec = BOUNDED;
        let mut sl = TickSlider::default();
        sl.mount(&spec, 90.0);
        drag(&mut sl, &spec, -10.0, 4);
        sl.pointer_up(&spec, 32.0, 32.0);
        let mut now = 32.0;
        let mut sprung = false;
        while now < 5000.0 {
            now += 8.0;
            sl.advance(&spec, now);
            sprung |= matches!(sl.anim, Anim::Spring { .. });
            assert!(sl.offset() >= 500.0 - 1e-9 || !sprung, "spring crossed the bound");
            if sl.next_wake(now).is_none() {
                break;
            }
        }
        assert!(sprung);
        assert_eq!(sl.offset(), 500.0);
    }

    #[test]
    fn the_wheel_clamps_hard_and_settles_after_a_pause() {
        let spec = BOUNDED;
        let mut sl = TickSlider::default();
        sl.mount(&spec, 99.0);
        sl.wheel(&spec, 0.0, 12.0, 0.0);
        assert_eq!(sl.offset(), 500.0);
        assert!(sl.out.start);
        assert!(sl.interacting());
        sl.wheel(&spec, -3.0, 1.0, 50.0); // the larger axis wins
        assert_eq!(sl.offset(), 497.0);
        sl.out = Out::default();
        sl.advance(&spec, 149.0);
        assert_eq!(sl.anim, Anim::Idle, "still waiting out the pause");
        let (_, outs) = run(&mut sl, &spec, 150.0, 1000.0);
        assert_eq!(sl.offset(), 495.0);
        assert_eq!(commits(&outs), vec![99.0]);
    }

    #[test]
    fn a_fine_slider_scales_the_wheel_down() {
        let spec = TickSpec::TIME;
        let mut sl = TickSlider::default();
        sl.wheel(&spec, 0.0, 10.0, 0.0);
        assert!((sl.offset() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn infinite_sliders_go_negative_without_springing() {
        let spec = TickSpec::DEFAULT;
        let mut sl = TickSlider::default();
        drag(&mut sl, &spec, 50.0, 4);
        assert_eq!(sl.offset(), -200.0);
        assert_eq!(sl.value(&spec), -40.0);
        // Held still, then let go: no fling.
        sl.pointer_up(&spec, 500.0, 500.0);
        assert_eq!(sl.anim, Anim::Idle);
        assert_eq!(sl.commit_at, Some((650.0, -40.0)));
    }

    #[test]
    fn keys_step_clamp_and_jump_to_the_ends() {
        let spec = BOUNDED;
        let mut sl = TickSlider::default();
        sl.mount(&spec, 50.0);
        sl.step_by(&spec, 1, 0.0);
        assert_eq!(sl.value(&spec), 51.0);
        assert_eq!(sl.out.change, Some(51.0));
        sl.step_by(&spec, spec.page_steps(), 10.0);
        assert_eq!(sl.value(&spec), 61.0);
        sl.step_to_limit(&spec, true, 20.0);
        assert_eq!(sl.value(&spec), 100.0);
        sl.step_by(&spec, 5, 30.0);
        assert_eq!(sl.value(&spec), 100.0);
        sl.step_to_limit(&spec, false, 40.0);
        assert_eq!(sl.value(&spec), 0.0);
        sl.out = Out::default();
        let (_, outs) = run(&mut sl, &spec, 40.0, 1000.0);
        assert_eq!(commits(&outs), vec![0.0]);
        // Unbounded: Home and End do nothing.
        let mut free = TickSlider::default();
        free.step_to_limit(&TickSpec::DEFAULT, true, 0.0);
        assert_eq!(free.offset(), 0.0);
        assert!(!free.out.start);
    }

    #[test]
    fn the_user_wins_over_a_driven_value_until_it_settles() {
        let spec = TickSpec::TIME;
        let mut sl = TickSlider::default();
        sl.sync(&spec, Source::Driven(1.0), 0.0);
        assert!((sl.offset() - 100.0).abs() < 1e-9);
        sl.sync(&spec, Source::Driven(1.01), 8.0);
        assert!((sl.offset() - 101.0).abs() < 1e-9);
        // Press, drag and fling: the driven value doesn't move it.
        sl.pointer_down(0.0, 0.0);
        sl.sync(&spec, Source::Driven(1.02), 16.0);
        assert!((sl.offset() - 101.0).abs() < 1e-9);
        sl.pointer_move(&spec, 20.0, 8.0);
        sl.pointer_move(&spec, 40.0, 16.0);
        sl.pointer_up(&spec, 16.0, 16.0);
        assert!(matches!(sl.anim, Anim::Momentum { .. }));
        let mut now = 16.0;
        while sl.interacting() {
            now += 8.0;
            sl.sync(&spec, Source::Driven(1.03), now);
            sl.advance(&spec, now);
            assert!(sl.interacting() || sl.anim == Anim::Idle);
        }
        let settled = sl.offset();
        assert!(settled < 70.0);
        // Settled: driving resumes.
        sl.sync(&spec, Source::Driven(1.04), now + 8.0);
        assert!((sl.offset() - 104.0).abs() < 1e-9);
        assert_eq!(sl.out.change.map(|_| ()), Some(()), "the user's own moves were reported");
        sl.out = Out::default();
        sl.sync(&spec, Source::Driven(1.05), now + 16.0);
        assert_eq!(sl.out, Out::default(), "driving reports nothing");
    }

    #[test]
    fn a_changed_value_glides_there_without_reporting() {
        let spec = TickSpec::DEFAULT;
        let mut sl = TickSlider::default();
        sl.sync(&spec, Source::Value(0.0), 0.0);
        sl.sync(&spec, Source::Value(10.0), 0.0);
        assert!(matches!(sl.anim, Anim::Seek { .. }));
        sl.advance(&spec, 100.0);
        assert!(sl.offset() > 25.0 && sl.offset() < 50.0);
        sl.sync(&spec, Source::Value(10.0), 100.0);
        let (end, outs) = run(&mut sl, &spec, 100.0, 1000.0);
        assert_eq!(sl.offset(), 50.0);
        assert!(end <= 208.0);
        assert!(outs.iter().all(|o| *o == Out::default()));
        // An unchanged value doesn't pull a moved slider back.
        sl.step_by(&spec, 3, 300.0);
        run(&mut sl, &spec, 300.0, 1000.0);
        sl.sync(&spec, Source::Value(10.0), 1000.0);
        assert_eq!(sl.value(&spec), 13.0);
    }

    #[test]
    fn values_wait_for_the_user() {
        let spec = TickSpec::DEFAULT;
        let mut sl = TickSlider::default();
        sl.sync(&spec, Source::Value(0.0), 0.0);
        sl.wheel(&spec, 0.0, 20.0, 0.0);
        sl.sync(&spec, Source::Value(-30.0), 10.0);
        assert_eq!(sl.offset(), 20.0, "no seek between wheel steps");
    }

    #[test]
    fn hidden_forgets_and_shows_the_next_value_at_once() {
        let spec = TickSpec::DEFAULT;
        let mut sl = TickSlider::default();
        sl.sync(&spec, Source::Value(3.0), 0.0);
        drag(&mut sl, &spec, 10.0, 2);
        sl.sync(&spec, Source::Hidden, 20.0);
        assert!(!sl.pointer && !sl.started && sl.offset() == 0.0);
        sl.sync(&spec, Source::Value(7.0), 30.0);
        assert_eq!(sl.offset(), 35.0);
        assert_eq!(sl.anim, Anim::Idle);
    }

    #[test]
    fn a_new_press_cancels_the_pending_commit() {
        let spec = TickSpec::DEFAULT;
        let mut sl = TickSlider::default();
        drag(&mut sl, &spec, 5.0, 1);
        sl.pointer_up(&spec, 500.0, 500.0);
        assert!(sl.commit_at.is_some());
        sl.pointer_down(0.0, 600.0);
        assert!(sl.commit_at.is_none());
        // Settling ended the gesture (as `emitCommit` does), so this is a new one.
        sl.pointer_move(&spec, 5.0, 608.0);
        assert!(sl.out.start);
    }

    #[test]
    fn catching_a_coasting_slider_continues_the_gesture() {
        let spec = TickSpec::DEFAULT;
        let mut sl = TickSlider::default();
        drag(&mut sl, &spec, 10.0, 4);
        sl.pointer_up(&spec, 32.0, 32.0);
        sl.advance(&spec, 40.0);
        sl.out = Out::default();
        sl.pointer_down(0.0, 100.0);
        assert_eq!(sl.anim, Anim::Idle, "the press stops it where it is");
        sl.pointer_move(&spec, 5.0, 108.0);
        assert!(!sl.out.start);
    }

    #[test]
    fn velocity_matches_the_web_tracker() {
        let mut v = Velocity::default();
        v.add(0.0, 0.0);
        assert_eq!(v.calculate(), 0.0);
        v.add(10.0, 10.0);
        assert!((v.calculate() - 0.7).abs() < 1e-12);
        v.add(20.0, 30.0);
        v.add(30.0, 60.0);
        // velocities 1, 2, 3: blends 1.6 then 1.6*0.8 + 2.6*0.2 = 1.8; 1.6*0.75 + 1.8*0.25.
        assert!((v.calculate() - 1.65).abs() < 1e-12);
        v.add(40.0, 100.0); // only the last four count: 2, 3, 4
        assert!((v.calculate() - (2.6 * 0.75 + (2.6 * 0.8 + 3.6 * 0.2) * 0.25)).abs() < 1e-12);
    }

    #[test]
    fn ticks_grow_toward_the_pointer_from_the_left_only() {
        let spec = TickSpec::DEFAULT;
        let (ticks, [px, py, ph]) = layout_ticks(&spec, 0.0, 100.0);
        let at = |i: i64| ticks.iter().find(|t| t.index == i).copied();
        let (Some(centre), Some(left), Some(right)) = (at(0), at(-2), at(2)) else { panic!("missing ticks: {ticks:?}") };
        assert!(centre.major && (centre.h - MAJOR_H).abs() < 1e-4);
        assert!((right.h - TICK_H * 0.4).abs() < 1e-4);
        assert!(left.h > right.h && left.h < TICK_H);
        assert!(at(1).is_none(), "odd ticks are skipped");
        assert!(at(20).is_some_and(|t| t.major) && at(-20).is_some_and(|t| t.major));
        assert!(ticks.iter().all(|t| t.x.abs() <= 100.0 + TICK_W));
        assert!(ticks.last().is_some_and(|t| t.major), "majors draw last");
        assert_eq!([px, py, ph], [-1.0, HEIGHT - MAJOR_H, MAJOR_H]);
    }

    #[test]
    fn the_pointer_sticks_to_the_end_while_rubber_banding() {
        let spec = BOUNDED;
        let (ticks, [px, ..]) = layout_ticks(&spec, 520.0, 100.0);
        assert!((px - (-20.0 - POINTER_W / 2.0)).abs() < 1e-4);
        assert!(ticks.iter().all(|t| t.index <= 100));
        let (_, [px, ..]) = layout_ticks(&spec, -15.0, 100.0);
        assert!((px - (15.0 - POINTER_W / 2.0)).abs() < 1e-4);
    }

    #[test]
    fn input_maps_onto_the_frame_clock() {
        let mut sl = TickSlider::default();
        let then = Instant::now();
        sl.clock = Some((2.0, then));
        assert!((sl.frame_ms(then + Duration::from_millis(5)) - 2005.0).abs() < 1e-6);
        assert!((sl.frame_ms(then - Duration::from_millis(5)) - 1995.0).abs() < 1e-6);
    }
}
