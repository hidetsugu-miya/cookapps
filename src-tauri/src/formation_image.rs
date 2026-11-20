//! The images of a decision page (A-41, #1153): an `image` block names `{root, path, caption}` and the file is read one at a time when the screen draws it, never put in the page's JSON (a page is 700 KiB, a frame of the server 1 MiB).
//!
//! A file over `IMAGE_LIMIT` is made smaller as the earlier feature-dev did: re-encoded as a JPEG of quality 85 at the widths 2400, 1600, 1200 and 800 pixels in turn, the first that fits being kept. One that fits none, and an SVG over the limit (it cannot be made smaller), is refused. The prepared images are kept for the next read: the last `KEPT_MAX` of them (the server sends one in chunks of `CHUNK` bytes, one frame each, and reads of several images run at once).

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
/// The pixels of an image that is decoded, at most: width times height. The decoded picture takes 4 bytes a pixel, and the white-flattened copy 3 more.
const PIXEL_LIMIT: u64 = 25_000_000;
/// What the decoder may allocate, at most (bytes).
const DECODE_ALLOC_LIMIT: u64 = 256 * 1024 * 1024;
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
    let reader = || {
        ImageReader::new(Cursor::new(bytes.as_slice()))
            .with_guessed_format()
            .map_err(|_| too_large(size))
    };
    // The size is read from the header first, so that a picture of too many pixels is never decoded.
    let (width, height) = reader()?.into_dimensions().map_err(|_| too_large(size))?;
    check_pixels(width, height)?;
    let mut reader = reader()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(SIDE_LIMIT);
    limits.max_image_height = Some(SIDE_LIMIT);
    limits.max_alloc = Some(DECODE_ALLOC_LIMIT);
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

/// Whether a picture of `width` by `height` pixels may be decoded: each side up to `SIDE_LIMIT` and the pixels up to `PIXEL_LIMIT`.
fn check_pixels(width: u32, height: u32) -> Result<(), String> {
    if width > SIDE_LIMIT
        || height > SIDE_LIMIT
        || u64::from(width) * u64::from(height) > PIXEL_LIMIT
    {
        return Err(format!(
            "画像の画素数が多すぎます（{width}×{height}。{} 万画素までです）",
            PIXEL_LIMIT / 10_000
        ));
    }
    Ok(())
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

/// A prepared image and the file it was made from.
struct Kept {
    real: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    image: Arc<Prepared>,
}

/// How many prepared images are kept: at most 4 of `IMAGE_LIMIT` each, so 12 MiB.
const KEPT_MAX: usize = 4;
const _: () = assert!(KEPT_MAX * IMAGE_LIMIT <= 12 * 1024 * 1024);

/// The prepared images of the files read last, the newest first: the next chunk of a file, and an image that is read again, are not made again, and reads of several files at once do not push each other out.
struct Cache(Vec<Kept>);

impl Cache {
    /// The image of the file `real` of that size and time of change, which becomes the newest.
    fn get(
        &mut self,
        real: &Path,
        size: u64,
        modified: Option<SystemTime>,
    ) -> Option<Arc<Prepared>> {
        let at = self
            .0
            .iter()
            .position(|k| k.real == real && k.size == size && k.modified == modified)?;
        let kept = self.0.remove(at);
        let image = kept.image.clone();
        self.0.insert(0, kept);
        Some(image)
    }

    /// Keeps `kept` as the newest, in place of any earlier image of the same file, and lets the oldest go beyond `KEPT_MAX`.
    fn put(&mut self, kept: Kept) {
        self.0.retain(|k| k.real != kept.real);
        self.0.insert(0, kept);
        self.0.truncate(KEPT_MAX);
    }
}

static KEPT: Mutex<Cache> = Mutex::new(Cache(Vec::new()));

/// The file `relative` of `root` (a real path) as the screen gets it. The path is checked as every path of a page is: clean, inside `root` whatever links lie on the way, no `.git` and no `.env`.
pub fn file(root: &Path, relative: &str) -> Result<Arc<Prepared>, String> {
    let mime = require_mime(relative)?;
    let real = locate(root, relative)?;
    let meta = std::fs::metadata(&real).map_err(|_| "ファイルを読めません")?;
    let (size, modified) = (meta.len(), meta.modified().ok());
    if let Some(image) = KEPT
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&real, size, modified)
    {
        return Ok(image);
    }
    let image = Arc::new(prepare(read_bounded(&real, FILE_LIMIT)?, mime)?);
    KEPT.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .put(Kept {
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

    fn kept(name: &str, size: u64) -> Kept {
        Kept {
            real: PathBuf::from(name),
            size,
            modified: None,
            image: Arc::new(Prepared {
                mime: MIMES[0],
                bytes: vec![],
            }),
        }
    }

    #[test]
    fn the_cache_keeps_the_last_images_and_lets_the_oldest_go() {
        let mut cache = Cache(Vec::new());
        for n in 0..KEPT_MAX {
            cache.put(kept(&format!("/{n}"), 1));
        }
        // Reading "/0" makes it the newest, so the next one in goes past "/1".
        assert!(cache.get(Path::new("/0"), 1, None).is_some());
        cache.put(kept("/new", 1));
        assert!(cache.get(Path::new("/1"), 1, None).is_none());
        for name in ["/0", "/2", "/3", "/new"] {
            assert!(cache.get(Path::new(name), 1, None).is_some(), "{name}");
        }
        // A file that changed (another size or time) is not the image that was kept.
        assert!(cache.get(Path::new("/0"), 2, None).is_none());
        assert!(cache
            .get(Path::new("/0"), 1, Some(SystemTime::UNIX_EPOCH))
            .is_none());
        // The new state of a file takes the place of the old one.
        cache.put(kept("/0", 2));
        assert_eq!(
            cache.0.iter().filter(|k| k.real == Path::new("/0")).count(),
            1
        );
        assert!(cache.get(Path::new("/0"), 1, None).is_none());
        assert_eq!(cache.0.len(), KEPT_MAX);
    }

    #[test]
    fn a_picture_of_too_many_pixels_is_refused_by_its_size_alone() {
        assert!(check_pixels(5000, 5000).is_ok());
        assert!(check_pixels(SIDE_LIMIT, 1250).is_ok());
        assert!(check_pixels(5001, 5000).unwrap_err().contains("画素数"));
        assert!(check_pixels(SIDE_LIMIT + 1, 1).is_err());
        assert!(check_pixels(u32::MAX, u32::MAX).is_err());
    }

    /// The CRC-32 that a PNG chunk ends with.
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = u32::MAX;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    #[test]
    fn a_large_file_is_checked_for_its_pixels_before_it_is_decoded() {
        // A PNG whose header says 30000 by 30000 and that holds nothing else: the size is read, and the refusal is about the pixels, not about a picture that could not be decoded.
        let mut header = b"IHDR".to_vec();
        header.extend_from_slice(&30_000u32.to_be_bytes());
        header.extend_from_slice(&30_000u32.to_be_bytes());
        header.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
        png.extend_from_slice(&header);
        png.extend_from_slice(&crc32(&header).to_be_bytes());
        png.extend_from_slice(&[0, 0, 0, 0]);
        png.extend_from_slice(b"IDAT");
        png.extend_from_slice(&crc32(b"IDAT").to_be_bytes());
        png.resize(IMAGE_LIMIT + 1, 0);
        let error = prepare(png, MIMES[0]).unwrap_err();
        assert!(error.contains("画素数"), "{error}");
    }

    #[test]
    fn the_data_uri_names_the_type() {
        assert_eq!(data_uri("image/png", b"ab"), "data:image/png;base64,YWI=");
    }
}
