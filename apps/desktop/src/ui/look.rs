//! The web app's design tokens (`styles/variables.css`): a neutral OKLCH gray scale whose
//! lightness steps flip between light and dark, one primary blue, pill buttons, floating surfaces
//! at 90% over a 12 px blur, and the system rounded face at 14 px.

use rune::{Color, El, TextStyle, oklch, oklcha};

/// Selection ring and marquee blue, `rgb(59 130 246)` as linear light.
pub const BRAND: Color = Color { r: 0.0437, g: 0.2232, b: 0.9216, a: 1.0 };

/// Body text: `--font-size` 14 px, the rounded face.
pub const BODY: TextStyle = TextStyle::new(14.0, 400.0);
pub const MEDIUM: TextStyle = TextStyle::new(14.0, 500.0);
/// Select values and buttons: 16 px, 500.
pub const LARGE: TextStyle = TextStyle::new(16.0, 500.0);
/// Numeric readouts, tabular so they don't jitter while dragging.
pub const NUMBER: TextStyle = TextStyle::new(14.0, 400.0).features("tnum");
pub const SMALL: TextStyle = TextStyle::new(12.0, 500.0);

pub struct Look {
    /// `--studio-background`, the canvas.
    pub studio: Color,
    /// `--surface` / `--input-bg`: tracks, select triggers, pressed toggles.
    pub surface: Color,
    /// `--floating-background`: surface at 90%, over a blur.
    pub floating: Color,
    /// `--border`.
    pub border: Color,
    /// `--color`.
    pub text: Color,
    /// `--gray-1200`: slider labels and values, toggle text in dark.
    pub text_strong: Color,
    /// `--gray-1100`: select values.
    pub text_value: Color,
    /// `--gray-900`: field labels, section triggers, toggle text in light.
    pub text_muted: Color,
    /// `--gray-600`: secondary lines.
    pub text_faint: Color,
    /// `--slider-indicator-bg`.
    pub indicator: Color,
    /// Toggle and collapsible hover.
    pub hover: Color,
    /// A pressed toggle's inset ring.
    pub pressed_ring: Color,
    /// Select trigger border.
    pub field_border: Color,
    pub primary: Color,
    pub primary_lighter: Color,
    /// `--popover-shadow`.
    pub shadow: Color,
    pub marquee_fill: Color,
    /// `--slider-tick-color`: the tick slider's ticks.
    pub tick: Color,
    /// `--slider-major-tick-color`.
    pub tick_major: Color,
    /// `--slider-highlight-color`: its centre pointer.
    pub tick_highlight: Color,
    /// `--background`: full-window pages (Settings).
    pub background: Color,
    /// `--gray-1300`: settings row labels.
    pub text_label: Color,
    /// `--gray-800`: settings row descriptions.
    pub text_desc: Color,
    /// `--gray-400`: a switch's track when off.
    pub switch_off: Color,
    /// `--gray-100`: keyboard chips (`.kbd`).
    pub kbd: Color,
}

impl Look {
    pub fn new(dark: bool) -> Look {
        let gray = |l: f32| oklch(l, 0.0, 0.0);
        if dark {
            let surface = gray(0.16);
            Look {
                studio: Color { r: 0.0018, g: 0.0018, b: 0.0024, a: 1.0 },
                surface,
                floating: surface.alpha(0.9),
                border: gray(0.16),
                text: gray(0.98),
                text_strong: gray(0.7918),
                text_value: gray(0.7233),
                text_muted: gray(0.623),
                text_faint: gray(0.5797),
                indicator: gray(0.2967),
                hover: gray(0.2967),
                pressed_ring: gray(0.2967),
                field_border: gray(0.2067),
                primary: oklch(0.62, 0.23, 252.87),
                primary_lighter: oklch(0.7, 0.18, 250.78),
                shadow: oklcha(0.0, 0.0, 0.0, 0.5),
                marquee_fill: BRAND.alpha(0.25),
                tick: gray(0.2967),
                tick_major: gray(0.5191),
                tick_highlight: gray(0.7233),
                background: gray(0.02),
                text_label: gray(0.8518),
                text_desc: gray(0.5929),
                switch_off: gray(0.4691),
                kbd: gray(0.2967),
            }
        } else {
            let surface = gray(0.9812);
            Look {
                studio: Color { r: 0.955, g: 0.955, b: 0.955, a: 1.0 },
                surface,
                floating: surface.alpha(0.9),
                border: gray(0.952),
                text: gray(0.02),
                text_strong: gray(0.4108),
                text_value: gray(0.4691),
                text_muted: gray(0.5797),
                text_faint: gray(0.7233),
                indicator: gray(0.952),
                hover: gray(0.952),
                pressed_ring: gray(0.952),
                field_border: gray(0.952),
                primary: oklch(0.61, 0.23, 253.3),
                primary_lighter: oklch(0.7, 0.18, 250.78),
                shadow: oklcha(0.0, 0.0, 0.0, 0.12),
                marquee_fill: Color { r: 0.0, g: 0.01, b: 1.0, a: 0.15 },
                tick: gray(0.7918),
                tick_major: gray(0.6701),
                tick_highlight: gray(0.5797),
                background: gray(1.0),
                text_label: gray(0.3536),
                text_desc: gray(0.623),
                switch_off: gray(0.8518),
                kbd: gray(0.9812),
            }
        }
    }

    /// A floating surface over the canvas (`--floating-background`, `--floating-backdrop`). It
    /// owns the wheel, pinches, presses and drags over it, so none reach the canvas beneath: a
    /// click on its empty space neither deselects nor starts a marquee. Controls inside keep
    /// their own handlers (the innermost wins). `e` must not have press or drag handlers itself.
    pub fn floating(&self, e: El) -> El {
        own_gestures(e.backdrop_blur(12.0).fill(self.floating).border(1.0, self.border).shadow(8.0, 20.0, self.shadow))
            .on_press(|_: &mut crate::state::App| {})
            .on_drag(|_: &mut crate::state::App, _: &mut rune::Drag, _: &mut rune::Tx| {})
    }

    /// The primary button's fill: `--primary-lighter` falling to `--primary`.
    pub fn primary_button(&self, e: El) -> El {
        e.gradient(self.primary_lighter, self.primary).border(1.0, self.primary).shadow(1.0, 3.0, oklcha(0.0, 0.0, 0.0, 0.32))
    }
}

/// Wheel and pinch over `e` stop at it: input goes to what's under the pointer. A scroll view
/// inside `e` still hears the wheel first (handlers only run up to the nearest scroll view).
pub fn own_gestures(e: El) -> El {
    e.on_wheel(|_: &mut crate::state::App, _, _| true).on_magnify(|_: &mut crate::state::App, _, _| true)
}
