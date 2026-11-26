//! Export: copy an entity's processed texture (native resolution) to a buffer, map it on a later
//! frame, and write the file on a worker thread. PNG keeps alpha; JPEG flattens it.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

use crate::media::Loader;

const WAITING: u8 = 0;
const MAPPED: u8 = 1;
const FAILED: u8 = 2;

struct Job {
    buffer: wgpu::Buffer,
    width: u32,
    height: u32,
    row: u32,
    path: Option<PathBuf>,
    loader: Loader,
    /// None until the copy has been submitted (the frame after `request`).
    state: Option<Arc<AtomicU8>>,
}

#[derive(Default)]
pub struct Exporter {
    jobs: Vec<Job>,
}

impl Exporter {
    pub fn busy(&self) -> bool {
        !self.jobs.is_empty()
    }

    /// Read `texture` back and write it to `path`, or to the clipboard as PNG when `None`.
    pub fn request(&mut self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, texture: &wgpu::Texture, path: Option<PathBuf>, loader: Loader) {
        let (width, height) = (texture.width(), texture.height());
        let row = (width * 4).div_ceil(256) * 256;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("voidmesh export"),
            size: u64::from(row) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        enc.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(height) } },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        self.jobs.push(Job { buffer, width, height, row, path, loader, state: None });
    }

    /// Start mapping submitted copies and finish mapped ones.
    pub fn poll(&mut self, device: &wgpu::Device) {
        if self.jobs.is_empty() {
            return;
        }
        let _ = device.poll(wgpu::PollType::Poll);
        self.jobs.retain_mut(|job| {
            let Some(state) = &job.state else {
                // Requested last frame, so its copy has been submitted: map it now.
                let flag = Arc::new(AtomicU8::new(WAITING));
                let f = flag.clone();
                job.buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| f.store(if r.is_ok() { MAPPED } else { FAILED }, Ordering::Release));
                job.state = Some(flag);
                return true;
            };
            match state.load(Ordering::Acquire) {
                WAITING => true,
                MAPPED => {
                    let pixels = match job.buffer.slice(..).get_mapped_range() {
                        Ok(range) => unpad(&range, job.width, job.height, job.row),
                        Err(_) => Vec::new(),
                    };
                    job.buffer.unmap();
                    let (w, h, path, loader) = (job.width, job.height, job.path.clone(), job.loader.clone());
                    std::thread::spawn(move || match path {
                        Some(path) => loader.notify(match save(&path, w, h, pixels) {
                            Ok(()) => format!("Saved {}", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()),
                            Err(e) => format!("Export failed: {e}"),
                        }),
                        None => match png(w, h, pixels) {
                            Ok(bytes) => loader.to_clipboard(bytes),
                            Err(e) => loader.notify(format!("Copy failed: {e}")),
                        },
                    });
                    false
                }
                _ => {
                    job.loader.notify("Export failed: couldn't read the image back".into());
                    false
                }
            }
        });
    }
}

/// Rows without padding, unpremultiplied (the processed texture is premultiplied).
fn unpad(data: &[u8], w: u32, h: u32, row: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        let start = (y * row) as usize;
        for px in data[start..start + (w * 4) as usize].as_chunks::<4>().0 {
            let a = px[3];
            if a == 0 {
                out.extend_from_slice(&[0, 0, 0, 0]);
            } else {
                let k = 255.0 / f32::from(a);
                out.extend_from_slice(&[(f32::from(px[0]) * k).round().min(255.0) as u8, (f32::from(px[1]) * k).round().min(255.0) as u8, (f32::from(px[2]) * k).round().min(255.0) as u8, a]);
            }
        }
    }
    out
}

fn png(w: u32, h: u32, rgba: Vec<u8>) -> Result<Vec<u8>, String> {
    let img = image::RgbaImage::from_raw(w, h, rgba).ok_or("bad image size")?;
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(out)
}

fn save(path: &std::path::Path, w: u32, h: u32, rgba: Vec<u8>) -> Result<(), String> {
    let img = image::RgbaImage::from_raw(w, h, rgba).ok_or("bad image size")?;
    let jpeg = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg"));
    if jpeg {
        // Flatten onto white, as a browser's JPEG encode of a transparent canvas does not; white
        // keeps transparent media legible.
        let rgb = image::RgbImage::from_fn(w, h, |x, y| {
            let p = img.get_pixel(x, y).0;
            let a = f32::from(p[3]) / 255.0;
            let mix = |c: u8| (f32::from(c) * a + 255.0 * (1.0 - a)).round() as u8;
            image::Rgb([mix(p[0]), mix(p[1]), mix(p[2])])
        });
        let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), 92);
        enc.encode_image(&rgb).map_err(|e| e.to_string())
    } else {
        img.save_with_format(path, image::ImageFormat::Png).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn unpad_drops_row_padding_and_unpremultiplies() {
        let row = [128u8, 0, 0, 128, 9, 9, 9, 9];
        let out = super::unpad(&row, 1, 1, 8);
        assert_eq!(out, vec![255, 0, 0, 128]);
    }
}
