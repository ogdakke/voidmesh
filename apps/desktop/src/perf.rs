//! The debug performance overlay's numbers (`D`, the web's `engine/perf-overlay.ts`): frames
//! per second, the compositor's CPU time per frame (median and p95), and entities on screen
//! out of all. The compositor records each frame it draws; the overlay reads a summary that
//! refreshes four times a second.
//!
//! Two modes, as the web's: "continuous" keeps frames coming, so the rate is what the app can
//! draw (the web's rAF rate); "rendered" counts only the frames something asked for. The
//! overlay's own refreshes are left out of the count, so it doesn't measure itself.

use std::collections::VecDeque;
use std::time::Instant;

/// CPU times kept for the median and p95.
const CPU_SAMPLES: usize = 200;
/// FPS readings the graph shows, one per refresh.
pub const GRAPH_SAMPLES: usize = 100;
/// Seconds between refreshes of what the overlay shows.
pub const REFRESH: f64 = 0.25;
/// How fast the graph's scale falls back toward the readings (the web's `SCALE_DECAY`).
const SCALE_DECAY: f32 = 0.08;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Continuous,
    Rendered,
}

impl Mode {
    pub fn label(self) -> &'static str {
        match self {
            Mode::Continuous => "continuous",
            Mode::Rendered => "rendered",
        }
    }
}

/// What the overlay shows, as of its last refresh.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Shown {
    pub fps: u32,
    pub cpu_median: f32,
    pub cpu_p95: f32,
    pub drawn: usize,
    pub total: usize,
    /// FPS readings, oldest first, and the scale they're drawn against.
    pub graph: Vec<f32>,
    pub scale: f32,
}

pub struct Perf {
    pub visible: bool,
    pub mode: Mode,
    epoch: Instant,
    /// Counted frames in the last second, as seconds since `epoch`.
    frames: VecDeque<f64>,
    cpu: VecDeque<f32>,
    graph: VecDeque<f32>,
    scale: f32,
    /// Entities on screen and in all, at the last frame.
    counts: (usize, usize),
    /// The next frame draws a refresh of the overlay alone: leave it out.
    skip_next: bool,
    /// Frames counted since the last refresh.
    fresh: usize,
    last_refresh: f64,
    pub shown: Shown,
}

impl Default for Perf {
    fn default() -> Self {
        Perf {
            visible: false,
            mode: Mode::Continuous,
            epoch: Instant::now(),
            frames: VecDeque::new(),
            cpu: VecDeque::with_capacity(CPU_SAMPLES),
            graph: VecDeque::with_capacity(GRAPH_SAMPLES),
            scale: 60.0,
            counts: (0, 0),
            skip_next: false,
            fresh: 0,
            last_refresh: f64::NEG_INFINITY,
            shown: Shown::default(),
        }
    }
}

impl Perf {
    fn now(&self) -> f64 {
        self.epoch.elapsed().as_secs_f64()
    }

    /// `D`: show or hide, starting afresh.
    pub fn toggle(&mut self) {
        let visible = !self.visible;
        *self = Perf { visible, mode: self.mode, ..Perf::default() };
    }

    /// A click on the overlay: the other mode, its readings afresh.
    pub fn switch_mode(&mut self) {
        let mode = if self.mode == Mode::Continuous { Mode::Rendered } else { Mode::Continuous };
        *self = Perf { visible: self.visible, mode, ..Perf::default() };
    }

    /// Frames keep coming while it measures the continuous rate.
    pub fn wants_frames(&self) -> bool {
        self.visible && self.mode == Mode::Continuous
    }

    /// The compositor drew a frame in `cpu_ms`, with `drawn` of `total` entities on screen.
    pub fn record(&mut self, cpu_ms: f32, drawn: usize, total: usize) {
        if !self.visible {
            return;
        }
        self.counts = (drawn, total);
        if std::mem::take(&mut self.skip_next) {
            return;
        }
        let now = self.now();
        self.push_frame(now, cpu_ms);
    }

    fn push_frame(&mut self, at: f64, cpu_ms: f32) {
        self.frames.push_back(at);
        if self.cpu.len() == CPU_SAMPLES {
            self.cpu.pop_front();
        }
        self.cpu.push_back(cpu_ms);
        self.fresh += 1;
    }

    /// Refresh what shows, at most every `REFRESH` seconds and only when it would change. True
    /// when it did (the view then redraws, and that frame isn't counted).
    pub fn refresh(&mut self) -> bool {
        let now = self.now();
        self.refresh_at(now)
    }

    fn refresh_at(&mut self, now: f64) -> bool {
        if !self.visible || now - self.last_refresh < REFRESH {
            return false;
        }
        while self.frames.front().is_some_and(|t| now - t > 1.0) {
            self.frames.pop_front();
        }
        let fps = self.frames.len() as u32;
        if self.fresh == 0 && fps == self.shown.fps && self.shown.total == self.counts.1 && self.shown.drawn == self.counts.0 {
            return false;
        }
        self.fresh = 0;
        self.last_refresh = now;
        if self.graph.len() == GRAPH_SAMPLES {
            self.graph.pop_front();
        }
        self.graph.push_back(fps as f32);
        let target = self.graph.iter().copied().fold(1.0f32, f32::max) * 1.1;
        self.scale = if target >= self.scale { target } else { (self.scale - (self.scale - target) * SCALE_DECAY).max(target) };
        let mut sorted: Vec<f32> = self.cpu.iter().copied().collect();
        sorted.sort_by(f32::total_cmp);
        let at = |q: f64| sorted.get(((sorted.len() as f64 * q) as usize).min(sorted.len().saturating_sub(1))).copied().unwrap_or(0.0);
        self.shown = Shown { fps, cpu_median: at(0.5), cpu_p95: at(0.95), drawn: self.counts.0, total: self.counts.1, graph: self.graph.iter().copied().collect(), scale: self.scale };
        self.skip_next = self.mode == Mode::Rendered;
        true
    }

    /// Still reading frames from the last second: the overlay needs another refresh to settle.
    pub fn settling(&self) -> bool {
        self.visible && (self.shown.fps > 0 || self.fresh > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(p: &Perf) -> (u32, f32, f32) {
        (p.shown.fps, p.shown.cpu_median, p.shown.cpu_p95)
    }

    #[test]
    fn it_counts_frames_in_the_last_second_and_ranks_cpu_times() {
        let mut p = Perf { visible: true, mode: Mode::Rendered, ..Perf::default() };
        for i in 0..30 {
            p.push_frame(f64::from(i) / 60.0, (i % 10) as f32);
        }
        p.counts = (2, 5);
        assert!(p.refresh_at(0.6));
        assert_eq!(shown(&p), (30, 5.0, 9.0));
        assert_eq!((p.shown.drawn, p.shown.total), (2, 5));
        // Nothing new within the refresh interval, then the second runs out.
        assert!(!p.refresh_at(0.7));
        assert!(p.refresh_at(2.0));
        assert_eq!(p.shown.fps, 0);
        assert!(!p.refresh_at(3.0), "settled: no more refreshes");
    }

    #[test]
    fn the_overlays_own_redraw_isnt_counted_in_rendered_mode() {
        let mut p = Perf { visible: true, mode: Mode::Rendered, ..Perf::default() };
        p.record(1.0, 1, 1);
        assert!(p.refresh());
        // The refresh's frame.
        p.record(1.0, 1, 1);
        assert_eq!(p.fresh, 0);
        assert_eq!(p.frames.len(), 1);
    }
}
