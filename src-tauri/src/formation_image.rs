//! The images of a decision page (A-41, #1153): an `image` block names `{root, path, caption}` and the file is read one at a time when the screen draws it, never put in the page's JSON (a page is 700 KiB, a frame of the server 1 MiB).
//!
//! A file over `IMAGE_LIMIT` is made smaller as the earlier feature-dev did: re-encoded as a JPEG of quality 85 at the widths 2400, 1600, 1200 and 800 pixels in turn, the first that fits being kept. One that fits none, and an SVG over the limit (it cannot be made smaller), is refused. The prepared image is kept for the next read (the server sends it in chunks of `CHUNK` bytes, one frame each).

use std::{
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, PoisonError},
    time::SystemTime,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageReader, Limits, RgbImage,
};

use crate::formation_page::{locate, read_bounded};

/// An image the screen gets, at most (bytes): a larger file is made smaller or refused.
pub const IMAGE_LIMIT: usize = 3 * 1024 * 1024;
/// A file that is read to be made smaller, at most (bytes).
const FILE_LIMIT: u64 = 64 * 1024 * 1024;
/// The widths a file over `IMAGE_LIMIT` is tried at, as a JPEG.
const WIDTHS: [u32; 4] = [2400, 1600, 1200, 800];
const JPEG_QUALITY: u8 = 85;
/// The side of an image that is decoded, at most (pixels).
const SIDE_LIMIT: u32 = 20_000;
/// The bytes of an image that one reply of the server carries (the reply holds them as base64 in a frame of 1 MiB).
pub const CHUNK: usize = 512 * 1024;
/// The types the screen is given, as `data:` URIs.
pub const MIMES: [&str; 5] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
];
const EXTENSIONS_TEXT: &str = "png、jpg、jpeg、gif、webp、svg の画像にしてください";

/// An image as the screen gets it.
#[derive(Debug, PartialEq)]
pub struct Prepared {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

/// The type of an image by the extension of `path`; `None` for any other file.
pub fn mime_of(path: &str) -> Option<&'static str> {
    let (_, extension) = path.rsplit_once('.')?;
    match extension.to_ascii_lowercase().as_str() {
        "png" => Some(MIMES[0]),
        "jpg" | "jpeg" => Some(MIMES[1]),
        "gif" => Some(MIMES[2]),
        "webp" => Some(MIMES[3]),
        "svg" => Some(MIMES[4]),
        _ => None,
    }
}

/// `mime_of`, or the violation of a path that is no image.
pub fn require_mime(path: &str) -> Result<&'static str, String> {
    mime_of(path).ok_or_else(|| EXTENSIONS_TEXT.to_owned())
}

fn too_large(size: usize) -> String {
    format!(
        "画像が大きすぎます（{} KiB。{} KiB までに縮められませんでした）",
        size.div_ceil(1024),
        IMAGE_LIMIT / 1024
    )
}

/// `bytes` of an image of type `mime`, as the screen gets it: as they are up to `IMAGE_LIMIT`, else a JPEG that fits (`shrink`). A file that cannot be read as a picture, and an SVG, are refused when over the limit.
pub fn prepare(bytes: Vec<u8>, mime: &'static str) -> Result<Prepared, String> {
    if bytes.len() <= IMAGE_LIMIT {
        return Ok(Prepared { mime, bytes });
    }
    if mime == "image/svg+xml" {
        return Err(too_large(bytes.len()));
    }
    let size = bytes.len();
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| too_large(size))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(SIDE_LIMIT);
    limits.max_image_height = Some(SIDE_LIMIT);
    reader.limits(limits);
    let picture = reader.decode().map_err(|_| too_large(size))?;
    match shrink(&picture) {
        Some(bytes) => Ok(Prepared {
            mime: MIMES[1],
            bytes,
        }),
        None => Err(too_large(size)),
    }
}

/// `picture` as a JPEG under `IMAGE_LIMIT`: at each of `WIDTHS` in turn (the picture's own width where it is narrower), the first that fits; `None` when none does.
pub fn shrink(picture: &DynamicImage) -> Option<Vec<u8>> {
    let flat = flatten(picture);
    let (width, height) = flat.dimensions();
    let mut tried = Vec::new();
    for target in WIDTHS.map(|w| w.min(width)) {
        if tried.contains(&target) {
            continue;
        }
        tried.push(target);
        let mut out = Vec::new();
        let encoder = JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
        let done = if target == width {
            flat.write_with_encoder(encoder)
        } else {
            let high = (u64::from(height) * u64::from(target) / u64::from(width)).max(1);
            let scaled = image::imageops::resize(&flat, target, high as u32, FilterType::Triangle);
            scaled.write_with_encoder(encoder)
        };
        if done.is_ok() && out.len() <= IMAGE_LIMIT {
            return Some(out);
        }
    }
    None
}

/// `picture` on white, which a JPEG needs for the transparent parts.
fn flatten(picture: &DynamicImage) -> RgbImage {
    let rgba = picture.to_rgba8();
    let mut flat = RgbImage::new(rgba.width(), rgba.height());
    for (from, to) in rgba.pixels().zip(flat.pixels_mut()) {
        let alpha = u32::from(from[3]);
        for i in 0..3 {
            let mixed = u32::from(from[i]) * alpha + 255 * (255 - alpha);
            to[i] = u8::try_from(mixed / 255).unwrap_or(u8::MAX);
        }
    }
    flat
}

/// The part of `image` from `offset` that one reply carries.
pub fn chunk(image: &Prepared, offset: usize) -> &[u8] {
    let start = offset.min(image.bytes.len());
    &image.bytes[start..image.bytes.len().min(start.saturating_add(CHUNK))]
}

/// The image as a `data:` URI.
pub fn data_uri(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

/// The prepared image of a file read last: the next chunk of the same file is not made again.
struct Kept {
    real: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    image: Arc<Prepared>,
}

static KEPT: Mutex<Option<Kept>> = Mutex::new(None);

/// The file `relative` of `root` (a real path) as the screen gets it. The path is checked as every path of a page is: clean, inside `root` whatever links lie on the way, no `.git` and no `.env`.
pub fn file(root: &Path, relative: &str) -> Result<Arc<Prepared>, String> {
    let mime = require_mime(relative)?;
    let real = locate(root, relative)?;
    let meta = std::fs::metadata(&real).map_err(|_| "ファイルを読めません")?;
    let (size, modified) = (meta.len(), meta.modified().ok());
    if let Some(kept) = KEPT.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
        if kept.real == real && kept.size == size && kept.modified == modified {
            return Ok(kept.image.clone());
        }
    }
    let image = Arc::new(prepare(read_bounded(&real, FILE_LIMIT)?, mime)?);
    *KEPT.lock().unwrap_or_else(PoisonError::into_inner) = Some(Kept {
        real,
        size,
        modified,
        image: image.clone(),
    });
    Ok(image)
}

/// Whether the screen can be given the file `relative` of `root`: it is there and fits `IMAGE_LIMIT`, or can be made to. A file that fits is not read.
pub fn check(root: &Path, relative: &str) -> Result<(), String> {
    require_mime(relative)?;
    let real = locate(root, relative)?;
    let meta = std::fs::metadata(&real).map_err(|_| "ファイルを読めません")?;
    if !meta.is_file() {
        return Err("ファイルではありません".into());
    }
    if meta.len() <= IMAGE_LIMIT as u64 {
        return Ok(());
    }
    file(root, relative).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgba, RgbaImage};

    /// A picture of noise that no format makes small: the same values for the same size.
    fn noise(width: u32, height: u32) -> DynamicImage {
        let mut seed = 0x2545_f491_u32;
        let mut picture = RgbaImage::new(width, height);
        for pixel in picture.pixels_mut() {
            let mut next = || {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                (seed >> 8) as u8
            };
            *pixel = Rgba([next(), next(), next(), 255]);
        }
        DynamicImage::ImageRgba8(picture)
    }

    fn encoded(picture: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        picture.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    #[test]
    fn the_type_follows_the_extension() {
        assert_eq!(mime_of("a/b.PNG"), Some("image/png"));
        assert_eq!(mime_of("a.jpg"), Some("image/jpeg"));
        assert_eq!(mime_of("a.jpeg"), Some("image/jpeg"));
        assert_eq!(mime_of("a.gif"), Some("image/gif"));
        assert_eq!(mime_of("a.webp"), Some("image/webp"));
        assert_eq!(mime_of("a.svg"), Some("image/svg+xml"));
        assert_eq!(mime_of("a.txt"), None);
        assert_eq!(mime_of("png"), None);
        assert!(require_mime("a.html").is_err());
    }

    #[test]
    fn an_image_that_fits_is_kept_as_it_is_even_when_it_is_no_picture() {
        let bytes = b"not a picture".to_vec();
        let prepared = prepare(bytes.clone(), MIMES[0]).unwrap();
        assert_eq!(
            prepared,
            Prepared {
                mime: MIMES[0],
                bytes
            }
        );
        let at_limit = vec![0; IMAGE_LIMIT];
        assert_eq!(
            prepare(at_limit, MIMES[2]).unwrap().bytes.len(),
            IMAGE_LIMIT
        );
    }

    #[test]
    fn a_large_png_is_made_a_jpeg_that_fits() {
        let picture = noise(1400, 900);
        let png = encoded(&picture, ImageFormat::Png);
        assert!(png.len() > IMAGE_LIMIT, "{}", png.len());
        let prepared = prepare(png, MIMES[0]).unwrap();
        assert_eq!(prepared.mime, "image/jpeg");
        assert!(prepared.bytes.len() <= IMAGE_LIMIT);
        let back = image::load_from_memory(&prepared.bytes).unwrap();
        assert!(back.width() <= 1400);
    }

    #[test]
    fn a_wide_picture_is_scaled_down_in_steps_until_it_fits() {
        let picture = noise(3000, 1500);
        let jpeg = shrink(&picture).unwrap();
        assert!(jpeg.len() <= IMAGE_LIMIT);
        let width = image::load_from_memory(&jpeg).unwrap().width();
        assert!(WIDTHS.contains(&width), "{width}");
    }

    #[test]
    fn what_fits_no_width_is_refused() {
        let picture = noise(800, 9000);
        assert!(shrink(&picture).is_none());
        let png = encoded(&picture, ImageFormat::Png);
        let error = prepare(png, MIMES[0]).unwrap_err();
        assert!(error.contains("大きすぎます"), "{error}");
    }

    #[test]
    fn a_large_file_that_is_no_picture_and_a_large_svg_are_refused() {
        assert!(prepare(vec![7; IMAGE_LIMIT + 1], MIMES[0]).is_err());
        assert!(prepare(vec![b' '; IMAGE_LIMIT + 1], MIMES[4]).is_err());
    }

    #[test]
    fn transparent_parts_are_put_on_white() {
        let mut picture = RgbaImage::new(2, 1);
        picture.put_pixel(0, 0, Rgba([10, 20, 30, 0]));
        picture.put_pixel(1, 0, Rgba([10, 20, 30, 255]));
        let flat = flatten(&DynamicImage::ImageRgba8(picture));
        assert_eq!(flat.get_pixel(0, 0).0, [255, 255, 255]);
        assert_eq!(flat.get_pixel(1, 0).0, [10, 20, 30]);
    }

    #[test]
    fn the_chunks_cover_the_image_once() {
        let image = Prepared {
            mime: MIMES[0],
            bytes: (0..CHUNK * 2 + 10).map(|n| n as u8).collect(),
        };
        let mut joined = Vec::new();
        loop {
            let part = chunk(&image, joined.len());
            if part.is_empty() {
                break;
            }
            assert!(part.len() <= CHUNK);
            joined.extend_from_slice(part);
        }
        assert_eq!(joined, image.bytes);
        assert!(chunk(&image, usize::MAX).is_empty());
    }

    #[test]
    fn the_data_uri_names_the_type() {
        assert_eq!(data_uri("image/png", b"ab"), "data:image/png;base64,YWI=");
    }
}
