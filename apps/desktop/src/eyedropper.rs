//! The colour picker's eyedropper (the web's EyeDropper API): the system's screen colour sampler,
//! AppKit's `NSColorSampler` on macOS. The answer arrives on the main thread and goes through the
//! loader's inbox, so the next poll applies it to the open picker. Elsewhere there is none, and
//! the picker leaves the button out, as the web does without the API.

use crate::media::Loader;

/// The platform has a screen colour sampler.
pub const AVAILABLE: bool = cfg!(target_os = "macos");

/// Show the system sampler; its pick (or a cancel) reaches `loader`.
#[cfg(target_os = "macos")]
pub fn sample(loader: &Loader) {
    use objc2_app_kit::{NSColor, NSColorSampler, NSColorSpace};
    let loader = loader.clone();
    let handler = block2::RcBlock::new(move |c: *mut NSColor| {
        // SAFETY: AppKit passes a valid colour or nil, alive for the handler's call.
        let color = unsafe { c.as_ref() };
        let rgba = color.and_then(|c| c.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())).map(|c| {
            let k = |v: f64| (v as f32).clamp(0.0, 1.0);
            [k(c.redComponent()), k(c.greenComponent()), k(c.blueComponent()), k(c.alphaComponent())]
        });
        loader.sampled(rgba);
    });
    let sampler = NSColorSampler::new();
    // SAFETY: called on the main thread (UI handlers run there); the sampler retains itself and
    // the handler until the session ends.
    unsafe { sampler.showSamplerWithSelectionHandler(&handler) };
}

#[cfg(not(target_os = "macos"))]
pub fn sample(_: &Loader) {}
