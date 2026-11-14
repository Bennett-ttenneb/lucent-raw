//! File-level work: format detection, metadata, previews and export.
//! Never writes to the user's original files.

use crate::develop::{self, Recipe};
use image::{imageops::FilterType, DynamicImage, ImageDecoder, ImageReader};
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

/// RAW file types. "3fr" and "fff" are Hasselblad, "rwl" Leica, and "raw" is what Leica and Panasonic compact cameras write.
pub const RAW_EXTS: &[&str] = &["cr2", "cr3", "nef", "arw", "orf", "rw2", "raf", "dng", "pef", "srw", "3fr", "fff", "rwl", "raw"];
pub const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "tif", "tiff"];

pub const THUMB_EDGE: u32 = 360;
pub const STANDARD_EDGE: u32 = 2048;
/// An embedded RAW preview smaller than this is too soft for the loupe, so we develop instead.
const RAW_EMBEDDED_MIN_EDGE: u32 = 1600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Image,
    Raw,
}

pub fn kind_of(path: &Path) -> Option<Kind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if IMAGE_EXTS.contains(&ext.as_str()) {
        Some(Kind::Image)
    } else if RAW_EXTS.contains(&ext.as_str()) {
        Some(Kind::Raw)
    } else {
        None
    }
}

/// The `format` column value for the schema's check constraint.
pub fn format_name(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("jpg") | Some("jpeg") => "jpeg",
        Some("png") => "png",
        Some("tif") | Some("tiff") => "tiff",
        Some("dng") => "dng",
        Some(e) if RAW_EXTS.contains(&e) => "raw",
        _ => "other",
    }
}

#[derive(Debug, Default, Clone)]
pub struct Meta {
    pub captured_local: Option<String>, // "YYYY-MM-DDTHH:MM:SS", camera clock, no zone
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<i64>,
    pub aperture: Option<f64>,
    pub shutter_s: Option<f64>,
    pub focal_mm: Option<f64>,
    pub orientation: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

fn s(field: &exif::Field) -> Option<String> {
    let v = field.display_value().to_string();
    let v = v.trim().trim_matches('"').trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

fn rational(field: &exif::Field) -> Option<f64> {
    match &field.value {
        exif::Value::Rational(v) => v.first().map(|r| r.to_f64()),
        exif::Value::SRational(v) => v.first().map(|r| r.to_f64()),
        _ => None,
    }
}

/// Read EXIF. Missing or unreadable EXIF is normal (PNG, stripped files), so this never fails.
pub fn read_meta(path: &Path) -> Meta {
    let mut m = Meta::default();
    if let Ok(file) = File::open(path) {
        if let Ok(ex) = exif::Reader::new().read_from_container(&mut BufReader::new(file)) {
            if let Some(f) = ex.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
                // EXIF is "YYYY:MM:DD HH:MM:SS"
                let raw = f.display_value().to_string();
                let raw = raw.trim().trim_matches('"').to_string();
                if raw.len() >= 19 {
                    m.captured_local = Some(format!(
                        "{}-{}-{}T{}",
                        &raw[0..4],
                        &raw[5..7],
                        &raw[8..10],
                        &raw[11..19]
                    ));
                }
            }
            m.make = ex.get_field(exif::Tag::Make, exif::In::PRIMARY).and_then(s);
            m.model = ex.get_field(exif::Tag::Model, exif::In::PRIMARY).and_then(s);
            m.lens = ex.get_field(exif::Tag::LensModel, exif::In::PRIMARY).and_then(s);
            m.iso = ex
                .get_field(exif::Tag::PhotographicSensitivity, exif::In::PRIMARY)
                .and_then(|f| f.value.get_uint(0))
                .map(|v| v as i64);
            m.aperture = ex.get_field(exif::Tag::FNumber, exif::In::PRIMARY).and_then(rational);
            m.shutter_s = ex.get_field(exif::Tag::ExposureTime, exif::In::PRIMARY).and_then(rational);
            m.focal_mm = ex.get_field(exif::Tag::FocalLength, exif::In::PRIMARY).and_then(rational);
            m.orientation = ex
                .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                .and_then(|f| f.value.get_uint(0))
                .map(|v| v as i64);
        }
    }
    // many RAW files carry their details in a form EXIF readers do not find; the RAW library knows each camera's layout
    if kind_of(path) == Some(Kind::Raw) && m.make.is_none() && m.model.is_none() {
        fill_from_raw_library(path, &mut m);
    }
    if kind_of(path) == Some(Kind::Image) {
        if let Ok((w, h)) = image::image_dimensions(path) {
            m.width = Some(w as i64);
            m.height = Some(h as i64);
        }
    }
    m
}

/// Decode with EXIF orientation applied.
pub fn decode_oriented(path: &Path) -> Result<DynamicImage, String> {
    let mut decoder = ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .into_decoder()
        .map_err(|e| e.to_string())?;
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let icc = decoder.icc_profile().ok().flatten();
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    img.apply_orientation(orientation);
    // a photo with its own wide-gamut profile is brought into sRGB, the space everything here works in
    if let Some(rgb) = icc.and_then(|icc| crate::colour::embedded_to_srgb(&img.to_rgb8(), &icc)) {
        img = DynamicImage::ImageRgb8(rgb);
    }
    Ok(img)
}

fn fit(img: &DynamicImage, edge: u32, filter: FilterType) -> DynamicImage {
    if img.width().max(img.height()) <= edge {
        img.clone()
    } else {
        img.resize(edge, edge, filter)
    }
}

pub fn save_jpeg(img: &DynamicImage, out: &Path, quality: u8) -> Result<(), String> {
    let rgb = img.to_rgb8();
    let file = File::create(out).map_err(|e| e.to_string())?;
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), quality);
    enc.encode_image(&rgb).map_err(|e| e.to_string())
}

/// Save a JPEG that carries its colour profile.
pub fn save_jpeg_tagged(rgb: &image::RgbImage, out: &Path, quality: u8, icc: Vec<u8>) -> Result<(), String> {
    use image::ImageEncoder;
    let file = File::create(out).map_err(|e| e.to_string())?;
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), quality);
    enc.set_icc_profile(icc).map_err(|e| e.to_string())?;
    enc.encode_image(rgb).map_err(|e| e.to_string())
}

/// A small JPEG of a photo that is not in the catalog yet, for choosing what to import. Uses the camera's own
/// thumbnail when the file has one (fast) and decodes the picture otherwise.
pub fn source_thumb(path: &Path, edge: u32) -> Result<Vec<u8>, String> {
    let kind = kind_of(path).ok_or_else(|| "unsupported file type".to_string())?;
    let from_exif = if kind == Kind::Image { exif_thumbnail(path) } else { None };
    let img = match from_exif {
        Some(i) => i,
        None => decode_any(path, true)?,
    };
    let small = fit(&img, edge, FilterType::Triangle);
    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80);
    enc.encode_image(&small.to_rgb8()).map_err(|e| e.to_string())?;
    Ok(out)
}

/// The thumbnail a camera stores inside its JPEG, turned the right way up, if there is a usable one.
fn exif_thumbnail(path: &Path) -> Option<DynamicImage> {
    let file = File::open(path).ok()?;
    let ex = exif::Reader::new().read_from_container(&mut BufReader::new(file)).ok()?;
    let offset = ex.get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?.value.get_uint(0)? as usize;
    let length = ex.get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?.value.get_uint(0)? as usize;
    let bytes = ex.buf().get(offset..offset.checked_add(length)?)?;
    let mut img = image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).ok()?;
    if img.width().max(img.height()) < 100 {
        return None; // too small to be worth showing
    }
    let turn = ex.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)).and_then(|v| image::metadata::Orientation::from_exif(v as u8));
    if let Some(o) = turn {
        img.apply_orientation(o);
    }
    Some(img)
}

pub fn preview_path(previews_dir: &Path, id: i64, level: &str) -> PathBuf {
    previews_dir.join(format!("{id}_{level}.jpg"))
}

/// Camera, lens, exposure and date for a RAW file whose own details the plain EXIF reader could not find.
fn fill_from_raw_library(path: &Path, m: &mut Meta) {
    use rawler::{decoders::RawDecodeParams, rawsource::RawSource};
    let Ok(source) = RawSource::new(path) else { return };
    let Ok(decoder) = rawler::get_decoder(&source) else { return };
    let Ok(md) = decoder.raw_metadata(&source, &RawDecodeParams::default()) else { return };
    let text = |s: &str| Some(s.trim().to_string()).filter(|t| !t.is_empty());
    let ratio = |r: &rawler::formats::tiff::Rational| if r.d == 0 { None } else { Some(r.n as f64 / r.d as f64) };
    m.make = m.make.take().or_else(|| text(&md.make));
    m.model = m.model.take().or_else(|| text(&md.model));
    m.lens = m.lens.take().or_else(|| md.exif.lens_model.as_deref().and_then(text));
    m.iso = m.iso.or(md.exif.iso_speed.map(|v| v as i64)).or(md.exif.iso_speed_ratings.map(|v| v as i64));
    m.aperture = m.aperture.or(md.exif.fnumber.as_ref().and_then(ratio));
    m.shutter_s = m.shutter_s.or(md.exif.exposure_time.as_ref().and_then(ratio));
    m.focal_mm = m.focal_mm.or(md.exif.focal_length.as_ref().and_then(ratio));
    if m.orientation.is_none() {
        m.orientation = md.exif.orientation.map(|v| v as i64);
    }
    if m.captured_local.is_none() {
        // "YYYY:MM:DD HH:MM:SS"
        if let Some(raw) = md.exif.date_time_original.as_deref().or(md.exif.create_date.as_deref()).map(str::trim) {
            if raw.len() >= 19 && raw.as_bytes()[4] == b':' {
                m.captured_local = Some(format!("{}-{}-{}T{}", &raw[0..4], &raw[5..7], &raw[8..10], &raw[11..19]));
            }
        }
    }
}

/// The biggest JPEG picture stored inside a file (the preview many cameras keep in their RAW files), found by looking for
/// JPEG starts. For a camera the RAW library does not know, this is all that can be shown.
fn embedded_jpeg(path: &Path) -> Option<DynamicImage> {
    let len = std::fs::metadata(path).ok()?.len();
    if len > 400 * 1024 * 1024 {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let mut best: Option<DynamicImage> = None;
    let mut tried = 0;
    let mut i = 0;
    while i + 3 < bytes.len() && tried < 12 {
        if bytes[i] == 0xFF && bytes[i + 1] == 0xD8 && bytes[i + 2] == 0xFF {
            tried += 1;
            if let Ok(img) = image::load_from_memory_with_format(&bytes[i..], image::ImageFormat::Jpeg) {
                if img.width().max(img.height()) >= 600 && best.as_ref().map(|b| (img.width() as u64 * img.height() as u64) > (b.width() as u64 * b.height() as u64)).unwrap_or(true) {
                    best = Some(img);
                }
            }
        }
        i += 1;
    }
    best
}

/// Decode a camera RAW file with EXIF orientation applied. `for_preview` takes the camera's
/// embedded JPEG when it is large enough (10 to 170 ms); otherwise, and always for export,
/// the sensor data is demosaiced (about 1.5 s for 18 MP). For a camera the RAW library cannot
/// read, a preview shows the picture the camera stored inside the file; developing or exporting
/// cannot, and says so.
pub fn decode_raw(path: &Path, for_preview: bool) -> Result<DynamicImage, String> {
    match decode_raw_inner(path, for_preview) {
        Ok(img) => Ok(img),
        Err(e) if for_preview => embedded_jpeg(path).ok_or(e),
        Err(e) => Err(format!("This RAW file could not be developed ({e}). Its camera may not be supported yet.")),
    }
}

fn decode_raw_inner(path: &Path, for_preview: bool) -> Result<DynamicImage, String> {
    use rawler::{decoders::RawDecodeParams, imgop::develop::RawDevelop, rawsource::RawSource};
    fn err<E: ToString>(e: E) -> String {
        e.to_string()
    }
    let source = RawSource::new(path).map_err(err)?;
    let decoder = rawler::get_decoder(&source).map_err(err)?;
    let params = RawDecodeParams::default();
    // A "dummy" decode reads the metadata only, so this is cheap.
    let rawler_turn = decoder
        .raw_image(&source, &params, true)
        .map_err(err)?
        .orientation
        .to_u16();
    // Canon CR2 files come back from the RAW library as upright (1) even when the camera was turned; the file's own EXIF says so
    let orientation = if rawler_turn <= 1 { read_meta(path).orientation.map_or(1, |o| o as u16) } else { rawler_turn };
    let mut img = None;
    if for_preview {
        let embedded = decoder
            .preview_image(&source, &params)
            .ok()
            .flatten()
            .or_else(|| decoder.full_image(&source, &params).ok().flatten());
        img = embedded.filter(|i| i.width().max(i.height()) >= RAW_EMBEDDED_MIN_EDGE);
    }
    let mut img = match img {
        Some(i) => i,
        None => {
            let raw = decoder.raw_image(&source, &params, false).map_err(err)?;
            let developed = RawDevelop::default().develop_intermediate(&raw).map_err(err)?;
            developed.to_dynamic_image().ok_or("unsupported RAW pixel layout")?
        }
    };
    if let Some(o) = image::metadata::Orientation::from_exif(orientation as u8) {
        img.apply_orientation(o);
    }
    Ok(img)
}

/// Decode any supported file for preview or export.
pub fn decode_any(src: &Path, for_preview: bool) -> Result<DynamicImage, String> {
    match kind_of(src) {
        Some(Kind::Image) => decode_oriented(src),
        Some(Kind::Raw) => decode_raw(src, for_preview),
        None => Err("unsupported file type".into()),
    }
}

/// Build the thumb and standard previews. Returns an error string for unsupported or corrupt files.
pub fn build_previews(src: &Path, previews_dir: &Path, id: i64) -> Result<(), String> {
    let img = decode_any(src, true)?;
    let std_img = fit(&img, STANDARD_EDGE, FilterType::CatmullRom);
    save_jpeg(&std_img, &preview_path(previews_dir, id, "standard"), 88)?;
    let th = fit(&std_img, THUMB_EDGE, FilterType::Triangle);
    save_jpeg(&th, &preview_path(previews_dir, id, "thumb"), 80)
}

/// A 64 bit fingerprint of a picture (a "difference hash": whether each of 8 x 8 small grey patches is brighter than its neighbour).
/// Pictures that look alike have fingerprints that differ in few bits, whatever their size or a little change of exposure.
pub fn fingerprint(path: &Path) -> Option<u64> {
    let img = image::open(path).ok()?;
    let small = img.resize_exact(9, 8, FilterType::Triangle).to_luma8();
    let mut bits = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            bits = (bits << 1) | (small.get_pixel(x, y)[0] > small.get_pixel(x + 1, y)[0]) as u64;
        }
    }
    Some(bits)
}

/// The long side of a smart preview: big enough to edit and to export a screen-sized picture when the original is not at hand.
pub const SMART_EDGE: u32 = 2560;

/// Where a photo's smart preview is kept. It is not one of `PREVIEW_LEVELS`, so clearing or trimming the previews never touches it.
pub fn smart_path(previews_dir: &Path, id: i64) -> PathBuf {
    preview_path(previews_dir, id, "smart")
}

/// Make the smart preview from the original: the untouched picture, 2560 pixels on the long side.
pub fn build_smart(src: &Path, previews_dir: &Path, id: i64) -> Result<(), String> {
    let img = decode_any(src, false)?;
    save_jpeg(&fit(&img, SMART_EDGE, FilterType::CatmullRom), &smart_path(previews_dir, id), 90)
}

/// The levels of preview a photo can have. The "e" ones show the photo with its edits; the plain ones
/// are the untouched base that Develop starts from, so they must never be overwritten by an edit.
pub const PREVIEW_LEVELS: [&str; 4] = ["thumb", "standard", "ethumb", "estandard"];

/// Render the edited thumbnail and standard preview from the base preview. Nothing is written here,
/// so a caller can check it is still wanted before writing.
pub fn render_edited_previews(previews_dir: &Path, id: i64, recipe: &Recipe) -> Result<(DynamicImage, DynamicImage), String> {
    let base = image::open(preview_path(previews_dir, id, "standard")).map_err(|e| e.to_string())?;
    let std_img = DynamicImage::ImageRgb8(develop::render(&base.to_rgb8(), recipe));
    let thumb = fit(&std_img, THUMB_EDGE, FilterType::Triangle);
    Ok((std_img, thumb))
}

pub fn write_edited_previews(previews_dir: &Path, id: i64, std_img: &DynamicImage, thumb: &DynamicImage) -> Result<(), String> {
    save_jpeg(std_img, &preview_path(previews_dir, id, "estandard"), 88)?;
    save_jpeg(thumb, &preview_path(previews_dir, id, "ethumb"), 80)
}

pub fn clear_edited_previews(previews_dir: &Path, id: i64) {
    for level in ["ethumb", "estandard"] {
        let _ = std::fs::remove_file(preview_path(previews_dir, id, level));
    }
}

/// Pick a name that does not exist yet: `a.jpg`, `a-1.jpg`, `a-2.jpg`...
pub fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    for n in 1.. {
        let p = dir.join(format!("{stem}-{n}.{ext}"));
        if !p.exists() {
            return p;
        }
    }
    unreachable!()
}

/// A photo with its edits applied, at full size or shrunk to `long_edge` (0 keeps the size). Every format goes through this.
pub fn edited_picture(src: &Path, long_edge: u32, recipe: Option<&Recipe>) -> Result<DynamicImage, String> {
    edited_picture_with(src, &|_, _| long_edge, recipe).map(|(img, _)| img)
}

/// As `edited_picture`, but the size is worked out from the picture itself: `size(width, height)` is given the size of the picture after
/// the geometry and the crop (the size the person's edits leave it at) and answers the longest side wanted, 0 to keep it. Returns the
/// picture and the longest side that was asked for, so a picture that came out smaller than that can be enlarged.
pub fn edited_picture_with(src: &Path, size: &dyn Fn(u32, u32) -> u32, recipe: Option<&Recipe>) -> Result<(DynamicImage, u32), String> {
    let mut img = decode_any(src, false)?;
    let mut long_edge = 0;
    if let Some(r) = recipe {
        // geometry at full size, then shrink, then the per-pixel tone work on fewer pixels
        let r = r.sanitized();
        // lens corrections and transform first, then the crop, both at full size
        let rgb = img.to_rgb8();
        let bent = if r.geometry.is_identity() { rgb } else { crate::geometry::apply_geometry(&rgb, &r.geometry) };
        let cropped = develop::apply_crop(&bent, &r.crop);
        // spots work on the picture at full size, before it is shrunk
        let spotted = if crate::spots::any_visible(&r.spots) { crate::spots::apply_spots(&cropped, &r.spots) } else { cropped };
        let fixed = if crate::redeye::any(&r.red_eyes) { crate::redeye::apply_red_eyes(&spotted, &r.red_eyes) } else { spotted };
        img = DynamicImage::ImageRgb8(if crate::portrait::any(&r.portraits) { crate::portrait::apply_portraits(&fixed, &r.portraits) } else { fixed });
        long_edge = size(img.width(), img.height());
        img = if long_edge > 0 { fit(&img, long_edge, FilterType::CatmullRom) } else { img };
        let toned = develop::apply_tone(&img.to_rgb8(), &r);
        let masked = crate::masks::apply_masks(&toned, &r.masks, 0, 0, toned.width(), toned.height());
        let detailed = develop::apply_detail(&masked, &r.detail);
        img = DynamicImage::ImageRgb8(develop::apply_effects(&detailed, &r.effects, 0, 0, detailed.width(), detailed.height()));
    }
    if recipe.is_none() {
        long_edge = size(img.width(), img.height());
    }
    Ok((if long_edge > 0 { fit(&img, long_edge, FilterType::CatmullRom) } else { img }, long_edge))
}

#[cfg(test)]
pub fn export_jpeg(src: &Path, dest_dir: &Path, long_edge: u32, quality: u8, recipe: Option<&Recipe>, space: crate::colour::Space) -> Result<PathBuf, String> {
    let img = edited_picture(src, long_edge, recipe)?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("photo");
    let out = unique_path(dest_dir, stem, "jpg");
    // exports are always tagged with their profile, in sRGB too
    let (rgb, icc) = crate::colour::for_export(&img.to_rgb8(), space)?;
    save_jpeg_tagged(&rgb, &out, quality, icc)?;
    Ok(out)
}

#[cfg(test)]
mod colour_tests {
    use super::*;
    use crate::colour::Space;
    use image::{ImageBuffer, ImageDecoder, Rgb};

    fn photo(w: u32, h: u32) -> image::RgbImage {
        ImageBuffer::from_fn(w, h, |x, y| Rgb([(80 + x % 60) as u8, (140 + y % 60) as u8, 90]))
    }
    fn icc_of(path: &Path) -> Option<Vec<u8>> {
        let mut d = ImageReader::open(path).unwrap().with_guessed_format().unwrap().into_decoder().unwrap();
        d.icc_profile().unwrap()
    }
    fn mean_green_minus_red(img: &image::RgbImage) -> f32 {
        img.pixels().map(|p| p[1] as f32 - p[0] as f32).sum::<f32>() / (img.width() * img.height()) as f32
    }

    #[test]
    fn a_smart_preview_is_2560_wide_survives_clearing_and_stands_in_for_an_offline_original() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("IMG_1.jpg");
        photo(3200, 2000).save(&src).unwrap();
        let previews = dir.path().join("p");
        std::fs::create_dir_all(&previews).unwrap();
        build_smart(&src, &previews, 7).unwrap();
        assert_eq!(image::image_dimensions(smart_path(&previews, 7)).unwrap(), (2560, 1600));
        // an export with the original gone is made from the smart preview, and still takes its name from the original
        let out = dir.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::remove_file(&src).unwrap();
        let s = crate::export::ExportSettings::default();
        let done = crate::export::export_photo_from(&smart_path(&previews, 7), &src, &out, None, &s, 1, &|_, _| {}).unwrap();
        assert!(done.file_name().unwrap().to_string_lossy().starts_with("IMG_1"), "{done:?}");
        assert!(image::image_dimensions(&done).unwrap().0 <= 2560);
        // it is not one of the previews that clearing or trimming removes
        assert!(!PREVIEW_LEVELS.iter().any(|l| smart_path(&previews, 7).to_string_lossy().ends_with(&format!("_{l}.jpg"))));
    }

    #[test]
    fn a_photo_tagged_adobe_rgb_is_read_as_srgb_and_an_untagged_or_srgb_one_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let pic = photo(64, 48);
        let tag = |name: &str, space: Option<Space>| {
            let p = dir.path().join(name);
            match space {
                Some(s) => save_jpeg_tagged(&pic, &p, 95, s.profile().encode().unwrap()).unwrap(),
                None => save_jpeg(&DynamicImage::ImageRgb8(pic.clone()), &p, 95).unwrap(),
            }
            p
        };
        let plain = decode_oriented(&tag("plain.jpg", None)).unwrap().to_rgb8();
        let srgb = decode_oriented(&tag("srgb.jpg", Some(Space::Srgb))).unwrap().to_rgb8();
        let wide = decode_oriented(&tag("adobe.jpg", Some(Space::AdobeRgb))).unwrap().to_rgb8();
        assert_eq!(plain, srgb, "an sRGB tag changes nothing");
        assert!(mean_green_minus_red(&wide) > mean_green_minus_red(&plain) + 8.0, "Adobe RGB numbers become stronger sRGB ones");
    }

    #[test]
    fn exports_carry_the_profile_of_the_space_they_were_made_in() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.jpg");
        save_jpeg(&DynamicImage::ImageRgb8(photo(80, 60)), &src, 95).unwrap();
        let out = tempfile::tempdir().unwrap();
        for space in [Space::Srgb, Space::DisplayP3, Space::AdobeRgb, Space::ProPhoto] {
            let f = export_jpeg(&src, out.path(), 0, 92, None, space).unwrap();
            let icc = icc_of(&f).unwrap_or_else(|| panic!("{space:?}: no profile embedded"));
            let back = moxcms::ColorProfile::new_from_slice(&icc).unwrap();
            let want = space.profile();
            assert!((back.red_colorant.x - want.red_colorant.x).abs() < 0.003 && (back.green_colorant.y - want.green_colorant.y).abs() < 0.003, "{space:?}");
        }
    }

    #[test]
    fn a_wide_gamut_export_is_the_same_picture_when_read_back_through_its_profile() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src.jpg");
        save_jpeg(&DynamicImage::ImageRgb8(photo(80, 60)), &src, 98).unwrap();
        let out = tempfile::tempdir().unwrap();
        let srgb = decode_oriented(&export_jpeg(&src, out.path(), 0, 98, None, Space::Srgb).unwrap()).unwrap().to_rgb8();
        // decode_oriented applies the embedded profile, so a P3 export comes back as sRGB numbers again
        let p3 = decode_oriented(&export_jpeg(&src, out.path(), 0, 98, None, Space::DisplayP3).unwrap()).unwrap().to_rgb8();
        let worst = srgb.pixels().zip(p3.pixels()).flat_map(|(a, b)| (0..3).map(move |k| (a[k] as i32 - b[k] as i32).abs())).max().unwrap();
        assert!(worst <= 6, "differs by {worst}");
        // but the file's own numbers differ: it really is stored in the other space
        let raw = image::open(export_jpeg(&src, out.path(), 0, 98, None, Space::DisplayP3).unwrap()).unwrap().to_rgb8();
        assert!(mean_green_minus_red(&raw) < mean_green_minus_red(&srgb) - 3.0, "stored numbers are less saturated in P3");
    }

    /// Not run by default. `PENUMBRA_RAW_DIR=<folder> cargo test --release --lib raw_files_in_a_folder -- --ignored --nocapture`
    /// tries every file in a folder (and the folders in it) and says, for each, whether it can be read, how big it is, and how long it took.
    #[test]
    #[ignore]
    fn raw_files_in_a_folder_are_read_or_say_why_not() {
        let Some(dir) = std::env::var_os("PENUMBRA_RAW_DIR") else { return };
        let mut files: Vec<PathBuf> = walkdir::WalkDir::new(dir).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()).map(|e| e.into_path()).collect();
        files.sort();
        let mut bad = 0;
        for f in &files {
            let name = f.file_name().unwrap().to_string_lossy().into_owned();
            let t = std::time::Instant::now();
            let preview = decode_raw(f, true).map(|i| (i.width(), i.height()));
            let tp = t.elapsed();
            let t = std::time::Instant::now();
            let full = decode_raw(f, false).map(|i| (i.width(), i.height()));
            let tf = t.elapsed();
            let meta = read_meta(f);
            println!("{name}: preview {preview:?} in {tp:?}; developed {full:?} in {tf:?}; meta make={:?} model={:?} iso={:?} when={:?}", meta.make, meta.model, meta.iso, meta.captured_local);
            if preview.is_err() && full.is_err() {
                bad += 1;
            }
        }
        println!("{} files, {} that cannot be read", files.len(), bad);
    }

    #[test]
    fn hasselblad_and_leica_file_types_are_raw_and_other_things_are_not() {
        for n in ["a.3fr", "A.3FR", "b.fff", "c.rwl", "d.RAW", "e.dng", "f.cr3"] {
            assert_eq!(kind_of(Path::new(n)), Some(Kind::Raw), "{n}");
        }
        for n in ["a.ppm", "b.txt", "c.psd", "d"] {
            assert_eq!(kind_of(Path::new(n)), None, "{n}");
        }
    }

    fn a_jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 255) as u8, (y % 255) as u8, 90]));
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&img).unwrap();
        out
    }

    #[test]
    fn for_a_camera_the_library_does_not_know_the_preview_is_the_picture_stored_inside_and_developing_says_why_not() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("unknown.3fr");
        // a file that is not any RAW format the library knows, with a small and a big picture inside, among other bytes
        let mut bytes = vec![7u8; 5000];
        bytes.extend(a_jpeg(300, 200));
        bytes.extend(vec![9u8; 3000]);
        bytes.extend(a_jpeg(1200, 800));
        bytes.extend(vec![1u8; 2000]);
        std::fs::write(&path, &bytes).unwrap();
        let preview = decode_raw(&path, true).unwrap();
        assert_eq!((preview.width(), preview.height()), (1200, 800), "the biggest picture inside");
        let err = decode_raw(&path, false).unwrap_err();
        assert!(err.contains("could not be developed") && err.contains("may not be supported"), "{err}");
        // a file with no picture inside gives the library's own reason, for a preview too
        let plain = dir.path().join("nothing.3fr");
        std::fs::write(&plain, vec![3u8; 4000]).unwrap();
        assert!(decode_raw(&plain, true).is_err());
        // pictures that are only thumbnails are not taken for a preview
        let tiny = dir.path().join("tiny.fff");
        let mut b2 = vec![0u8; 100];
        b2.extend(a_jpeg(160, 120));
        std::fs::write(&tiny, &b2).unwrap();
        assert!(decode_raw(&tiny, true).is_err());
        // a file that is not there is an error, not a crash
        assert!(decode_raw(&dir.path().join("gone.3fr"), true).is_err());
    }

    #[test]
    fn camera_details_of_a_file_the_library_cannot_read_are_just_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.3fr");
        std::fs::write(&path, vec![5u8; 2000]).unwrap();
        let m = read_meta(&path);
        assert!(m.make.is_none() && m.model.is_none() && m.iso.is_none() && m.captured_local.is_none());
    }
}
