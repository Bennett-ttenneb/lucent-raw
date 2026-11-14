//! Export: the file formats, file names, output sharpening, a watermark, and a border with a caption of the camera settings.
//!
//! One photo goes through, in this order: the edits and the size (see `media::edited_picture`), output sharpening, the
//! watermark (on the photo), the border and its caption (round the photo), then the colour space and the file format.
//! Sizes of the watermark and the border are percentages of the picture's long edge, so a small preview and a full-size
//! export look the same.
//!
//! Text is drawn with a font that is already on the computer (Segoe UI, Arial, Calibri ...); none is shipped.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use ab_glyph::{point, Font, FontVec, PxScale, ScaleFont};
use image::{ImageEncoder, Rgb, RgbImage};
use serde::{Deserialize, Serialize};

use crate::colour::{self, Space};
use crate::develop::{self, Detail, Recipe};
use crate::media::{self, Meta};
use crate::upscale::{self, Enlarge};

// ---- the settings --------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    #[default]
    Jpeg,
    Png,
    Tiff,
    /// Lossless.
    Webp,
    /// The photo's own file, copied as it is: no edits, size, sharpening, watermark or border. Its extension is the photo's.
    Original,
    /// The photo's RAW file written as a DNG (the open RAW format): the picture data is not changed and edits are not applied.
    Dng,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Jpeg => "jpg",
            Format::Png => "png",
            Format::Tiff => "tif",
            Format::Webp => "webp",
            Format::Original => "", // the photo's own, found when it is exported
            Format::Dng => "dng",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Sharpen {
    #[default]
    None,
    Screen,
    Print,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Anchor {
    TopLeft,
    Top,
    TopRight,
    Left,
    Centre,
    Right,
    BottomLeft,
    Bottom,
    #[default]
    BottomRight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WatermarkKind {
    #[default]
    None,
    Text,
    Image,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Watermark {
    pub kind: WatermarkKind,
    pub text: String,
    /// A PNG, JPEG or WebP file with the logo; a transparent PNG works best.
    pub image_path: String,
    pub anchor: Anchor,
    /// Percent of the long edge: the height of the text, or the width of the logo.
    pub size: f32,
    /// 0 to 100.
    pub opacity: f32,
    /// Percent of the long edge, between the watermark and the edge of the photo.
    pub margin: f32,
    pub colour: [u8; 3],
    /// A soft dark shadow behind the text, so it can be read on light and dark parts.
    pub shadow: bool,
}

impl Default for Watermark {
    fn default() -> Self {
        Watermark { kind: WatermarkKind::None, text: "© Your name".into(), image_path: String::new(), anchor: Anchor::BottomRight, size: 3.0, opacity: 70.0, margin: 2.0, colour: [255, 255, 255], shadow: true }
    }
}

/// Which camera settings the caption under the photo shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Caption {
    pub show: bool,
    pub camera: bool,
    pub lens: bool,
    pub focal: bool,
    pub aperture: bool,
    pub shutter: bool,
    pub iso: bool,
    pub date: bool,
    /// A line of your own above the settings, for a title or a credit.
    pub note: String,
    pub layout: CaptionLayout,
    pub separator: CaptionSeparator,
    /// Spaces on each side of the separator, 0 to 12 (with no separator, three spaces for each).
    #[serde(deserialize_with = "lenient_spacing")]
    pub spacing: u8,
    pub weight: CaptionWeight,
    /// The size of the letters as a share of the photo's long edge, in percent (0.8 to 4). The text is made smaller if a line does not fit.
    #[serde(deserialize_with = "lenient_size")]
    pub size: f32,
}

/// A number from 0 to 12. Earlier versions saved the words tight, normal and wide; those, and anything else odd, become a number too.
fn lenient_spacing<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u8, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(match v {
        serde_json::Value::Number(n) => n.as_f64().filter(|x| x.is_finite()).map(|x| x.round().clamp(0.0, 12.0) as u8).unwrap_or(2),
        serde_json::Value::String(w) => match w.as_str() {
            "tight" => 1,
            "wide" => 4,
            _ => 2,
        },
        _ => 2,
    })
}

fn lenient_size<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f32, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(v.as_f64().filter(|x| x.is_finite()).map(|x| (x as f32).clamp(0.8, 4.0)).unwrap_or(1.6))
}

/// How the camera settings are set out under the photo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionLayout {
    /// Camera and lens on one line, the exposure settings on the next.
    #[default]
    Grouped,
    /// Everything on one line.
    Single,
    /// Every item on a line of its own.
    Items,
}

/// What stands between the items of a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionSeparator {
    #[default]
    Dot,
    Bar,
    Slash,
    /// Only space.
    Gap,
}

/// The weight of the letters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionWeight {
    Light,
    #[default]
    Regular,
    Semibold,
    Bold,
}

impl Caption {
    /// What goes between two items on a line.
    fn joiner(&self) -> String {
        let inner = self.spacing.min(12) as usize;
        let gap = (inner * 3).max(1);
        let pad = " ".repeat(inner);
        match self.separator {
            CaptionSeparator::Dot => format!("{pad}·{pad}"),
            CaptionSeparator::Bar => format!("{pad}|{pad}"),
            CaptionSeparator::Slash => format!("{pad}/{pad}"),
            CaptionSeparator::Gap => " ".repeat(gap),
        }
    }
}

impl Default for Caption {
    fn default() -> Self {
        Caption {
            show: false,
            camera: true,
            lens: true,
            focal: true,
            aperture: true,
            shutter: true,
            iso: true,
            date: false,
            note: String::new(),
            layout: CaptionLayout::default(),
            separator: CaptionSeparator::default(),
            spacing: 2,
            weight: CaptionWeight::default(),
            size: 1.6,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Border {
    pub enabled: bool,
    /// Percent of the long edge, on every side (the caption makes the bottom deeper).
    pub width: f32,
    pub colour: [u8; 3],
    pub caption: Caption,
    /// The colour of the caption; black or white, whichever reads on the border, when not set.
    pub caption_colour: Option<[u8; 3]>,
}

impl Default for Border {
    fn default() -> Self {
        Border { enabled: false, width: 4.0, colour: [255, 255, 255], caption: Caption::default(), caption_colour: None }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportSettings {
    pub format: Format,
    /// JPEG only, 10 to 100.
    pub quality: u8,
    /// Longest side in pixels; 0 keeps the size.
    pub long_edge: u32,
    /// How the size is asked for: by the longest side (`long_edge`), by a box (`width` and `height`), by a percentage of the edited size
    /// or by a number of megapixels.
    pub size_mode: SizeMode,
    /// For `SizeMode::Dimensions`: the picture is made to fit inside this box, keeping its shape. 0 leaves that direction free.
    pub width: u32,
    pub height: u32,
    /// For `SizeMode::Percent`: 100 keeps the size.
    pub percent: f32,
    /// For `SizeMode::Megapixels`.
    pub megapixels: f32,
    /// The resolution written into the file (pixels per inch, 36 to 2400): for a printer or a layout program, the pixels are the same.
    pub dpi: u32,
    pub colour_space: String,
    /// {name} {date} {seq} {camera}
    pub name_template: String,
    pub sharpen: Sharpen,
    pub watermark: Watermark,
    pub border: Border,
    /// What to do when the longest side asked for is more than the picture has: nothing, a smooth enlargement, or the AI one.
    pub enlarge: Enlarge,
    /// JPEG only: put the camera, lens, exposure and date in the file (never where it was taken).
    pub camera_info: bool,
    /// The details of the photo written into the file (JPEG and PNG): "none" (the default), "copyright" (creator, copyright, credit, source,
    /// usage terms) or "all" (also title, caption, headline, place and keywords). Private keywords are never written.
    pub metadata: String,
}

impl Default for ExportSettings {
    fn default() -> Self {
        ExportSettings { format: Format::Jpeg, quality: 85, long_edge: 2048, size_mode: SizeMode::LongEdge, width: 2048, height: 2048, percent: 50.0, megapixels: 4.0, dpi: 300, colour_space: "srgb".into(), name_template: "{name}".into(), sharpen: Sharpen::None, watermark: Watermark::default(), border: Border::default(), enlarge: Enlarge::None, camera_info: true, metadata: "none".into() }
    }
}

/// How the size of an exported picture is asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SizeMode {
    #[default]
    LongEdge,
    Dimensions,
    Percent,
    Megapixels,
}

/// The longest side an export should have for a picture that, after its edits and crop, is `w` x `h`; 0 keeps the size.
pub fn export_long_edge(s: &ExportSettings, w: u32, h: u32) -> u32 {
    let (w, h) = (w.max(1) as f64, h.max(1) as f64);
    let long = w.max(h);
    let side = match s.size_mode {
        SizeMode::LongEdge => return s.long_edge,
        SizeMode::Dimensions => {
            // fit inside the box, keeping the shape; a direction left at 0 is free
            let kw = if s.width > 0 { s.width as f64 / w } else { f64::INFINITY };
            let kh = if s.height > 0 { s.height as f64 / h } else { f64::INFINITY };
            let k = kw.min(kh);
            if !k.is_finite() {
                return 0;
            }
            long * k
        }
        SizeMode::Percent => long * s.percent as f64 / 100.0,
        SizeMode::Megapixels => long * ((s.megapixels as f64 * 1_000_000.0) / (w * h)).sqrt(),
    };
    (side.round() as u32).clamp(1, 20000)
}

impl ExportSettings {
    /// Every value brought into its range, so a bad call cannot ask for something silly.
    pub fn sanitized(&self) -> ExportSettings {
        let c = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
        let mut s = self.clone();
        s.quality = s.quality.clamp(10, 100);
        s.long_edge = s.long_edge.min(20000);
        s.width = s.width.min(20000);
        s.height = s.height.min(20000);
        s.percent = c(s.percent, 1.0, 1000.0, 50.0);
        s.megapixels = c(s.megapixels, 0.1, 500.0, 4.0);
        s.dpi = s.dpi.clamp(crate::dpi::MIN_DPI, crate::dpi::MAX_DPI);
        s.name_template = s.name_template.chars().take(120).collect();
        if s.name_template.trim().is_empty() {
            s.name_template = "{name}".into();
        }
        s.watermark.text = s.watermark.text.chars().take(200).collect();
        s.watermark.size = c(s.watermark.size, 0.5, 60.0, 3.0);
        s.watermark.opacity = c(s.watermark.opacity, 0.0, 100.0, 70.0);
        s.watermark.margin = c(s.watermark.margin, 0.0, 20.0, 2.0);
        s.border.width = c(s.border.width, 0.0, 30.0, 4.0);
        s.border.caption.note = s.border.caption.note.chars().take(200).collect();
        if !matches!(s.metadata.as_str(), "copyright" | "all") {
            s.metadata = "none".into();
        }
        s
    }
}

// ---- file names ------------------------------------------------------------------------------------

/// Replace what a file name cannot hold, and keep it a sensible length.
fn clean_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '-' } else { c }).collect();
    let cleaned = cleaned.trim().trim_matches('.').trim().to_string();
    cleaned.chars().take(120).collect()
}

/// The file name (without the extension) for a photo: the template with {name} (the original name), {date} (when it was
/// taken, YYYY-MM-DD), {time} (HH-MM-SS), {year} {month} {day}, {seq} (1, 2, 3 ... at least three digits; {seq:5} makes it five), {camera},
/// {lens} and {iso} filled in.
pub fn expand_name(template: &str, src: &Path, meta: &Meta, seq: usize) -> String {
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("photo");
    let date = meta.captured_local.as_deref().filter(|c| c.len() >= 10).map(|c| c[0..10].to_string()).unwrap_or_else(|| "undated".into());
    let camera = camera_name(meta).unwrap_or_else(|| "camera".into());
    let when = meta.captured_local.as_deref().filter(|c| c.len() >= 19);
    let part = |from: usize, to: usize, none: &str| when.map(|c| c[from..to].to_string()).unwrap_or_else(|| none.to_string());
    let time = when.map(|c| c[11..19].replace(':', "-")).unwrap_or_else(|| "untimed".into());
    let lens = meta.lens.as_deref().map(str::trim).filter(|l| !l.is_empty()).unwrap_or("lens");
    let iso = meta.iso.map(|i| format!("ISO{i}")).unwrap_or_else(|| "ISO".into());
    let mut name = template
        .replace("{name}", stem)
        .replace("{date}", &date)
        .replace("{time}", &time)
        .replace("{year}", &part(0, 4, "0000"))
        .replace("{month}", &part(5, 7, "00"))
        .replace("{day}", &part(8, 10, "00"))
        .replace("{camera}", &camera)
        .replace("{lens}", lens)
        .replace("{iso}", &iso);
    // {seq} is at least three digits; {seq:5} is five (1 to 9 digits)
    for width in 1..=9usize {
        name = name.replace(&format!("{{seq:{width}}}"), &format!("{seq:0width$}"));
    }
    let name = name.replace("{seq}", &format!("{seq:03}"));
    let name = clean_name(&name);
    if name.is_empty() {
        clean_name(stem)
    } else {
        name
    }
}

// ---- the camera settings as text ----------------------------------------------------------------------

/// "Canon EOS R6": the model, with the make in front unless the model already starts with it.
pub fn camera_name(m: &Meta) -> Option<String> {
    let model = m.model.as_deref()?.trim();
    if model.is_empty() {
        return None;
    }
    let make = m.make.as_deref().map(str::trim).filter(|s| !s.is_empty());
    Some(match make {
        Some(mk) if !model.to_lowercase().starts_with(&mk.split_whitespace().next().unwrap_or(mk).to_lowercase()) => format!("{mk} {model}"),
        _ => model.to_string(),
    })
}

fn trimmed(v: f64, digits: usize) -> String {
    let s = format!("{v:.digits$}");
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}

pub fn fmt_aperture(a: f64) -> String {
    format!("f/{}", trimmed(a, 1))
}
pub fn fmt_shutter(s: f64) -> String {
    if s >= 1.0 {
        format!("{} s", trimmed(s, 1))
    } else {
        format!("1/{} s", (1.0 / s).round() as i64)
    }
}
pub fn fmt_focal(f: f64) -> String {
    format!("{} mm", f.round() as i64)
}
pub fn fmt_date(captured_local: &str) -> Option<String> {
    chrono::NaiveDate::parse_from_str(captured_local.get(0..10)?, "%Y-%m-%d").ok().map(|d| d.format("%-d %b %Y").to_string())
}

/// The lines of the caption: your note, then the camera and lens and the settings, set out as `layout` says. An item the file does not
/// have is left out, and a line with nothing in it is left out.
pub fn caption_lines(m: &Meta, c: &Caption) -> Vec<String> {
    let mut lines = Vec::new();
    if !c.note.trim().is_empty() {
        lines.push(c.note.trim().to_string());
    }
    let mut gear = Vec::new();
    if c.camera {
        gear.extend(camera_name(m));
    }
    if c.lens {
        gear.extend(m.lens.as_deref().map(str::trim).filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("unknown")).map(String::from));
    }
    let mut shot = Vec::new();
    if c.focal {
        shot.extend(m.focal_mm.filter(|v| *v > 0.0).map(fmt_focal));
    }
    if c.aperture {
        shot.extend(m.aperture.filter(|v| *v > 0.0).map(fmt_aperture));
    }
    if c.shutter {
        shot.extend(m.shutter_s.filter(|v| *v > 0.0).map(fmt_shutter));
    }
    if c.iso {
        shot.extend(m.iso.filter(|v| *v > 0).map(|v| format!("ISO {v}")));
    }
    if c.date {
        shot.extend(m.captured_local.as_deref().and_then(fmt_date));
    }
    let join = c.joiner();
    match c.layout {
        CaptionLayout::Grouped => {
            if !gear.is_empty() {
                lines.push(gear.join(&join));
            }
            if !shot.is_empty() {
                lines.push(shot.join(&join));
            }
        }
        CaptionLayout::Single => {
            let all: Vec<String> = gear.into_iter().chain(shot).collect();
            if !all.is_empty() {
                lines.push(all.join(&join));
            }
        }
        CaptionLayout::Items => lines.extend(gear.into_iter().chain(shot)),
    }
    lines
}

// ---- text ------------------------------------------------------------------------------------------------

fn find_font(files: &[&str]) -> Option<FontVec> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(w) = std::env::var("WINDIR") {
        dirs.push(Path::new(&w).join("Fonts"));
    }
    dirs.push(PathBuf::from("C:\\Windows\\Fonts"));
    dirs.extend(["/usr/share/fonts/truetype/dejavu", "/Library/Fonts", "/System/Library/Fonts/Supplemental"].map(PathBuf::from));
    for d in &dirs {
        for f in files {
            if let Ok(bytes) = std::fs::read(d.join(f)) {
                if let Ok(font) = FontVec::try_from_vec(bytes) {
                    return Some(font);
                }
            }
        }
    }
    None
}

fn font() -> Result<&'static FontVec, String> {
    font_weight(CaptionWeight::Regular)
}

/// The font for a weight: the matching file of the family the program uses (Segoe UI on Windows), or the next best family that has it,
/// or the regular weight when the computer has no such file (so a weight that is missing never stops an export).
fn font_weight(w: CaptionWeight) -> Result<&'static FontVec, String> {
    static FONTS: [OnceLock<Option<FontVec>>; 4] = [OnceLock::new(), OnceLock::new(), OnceLock::new(), OnceLock::new()];
    let (i, files): (usize, &[&str]) = match w {
        CaptionWeight::Light => (0, &["segoeuil.ttf", "calibril.ttf"]),
        CaptionWeight::Regular => (1, &["segoeui.ttf", "arial.ttf", "calibri.ttf", "tahoma.ttf", "verdana.ttf", "DejaVuSans.ttf", "Arial.ttf"]),
        CaptionWeight::Semibold => (2, &["seguisb.ttf", "segoeuib.ttf", "calibrib.ttf"]),
        CaptionWeight::Bold => (3, &["segoeuib.ttf", "arialbd.ttf", "calibrib.ttf", "DejaVuSans-Bold.ttf"]),
    };
    match FONTS[i].get_or_init(|| find_font(files)).as_ref() {
        Some(f) => Ok(f),
        None if i != 1 => font_weight(CaptionWeight::Regular),
        None => Err("No font was found on this computer to draw text with.".to_string()),
    }
}

fn text_width(f: &FontVec, px: f32, text: &str) -> f32 {
    let sc = f.as_scaled(PxScale::from(px));
    let (mut w, mut prev) = (0.0, None);
    for ch in text.chars() {
        let id = sc.glyph_id(ch);
        if let Some(p) = prev {
            w += sc.kern(p, id);
        }
        w += sc.h_advance(id);
        prev = Some(id);
    }
    w
}

fn line_height(f: &FontVec, px: f32) -> f32 {
    let sc = f.as_scaled(PxScale::from(px));
    sc.ascent() - sc.descent()
}

/// Draw one line of text with its top left at (x, y_top), blended in with `alpha` (0 to 1).
fn draw_text(img: &mut RgbImage, f: &FontVec, px: f32, text: &str, x: f32, y_top: f32, colour: [u8; 3], alpha: f32) {
    let scale = PxScale::from(px);
    let sc = f.as_scaled(scale);
    let baseline = y_top + sc.ascent();
    let (mut caret, mut prev) = (x, None);
    let (w, h) = (img.width() as i32, img.height() as i32);
    for ch in text.chars() {
        let id = sc.glyph_id(ch);
        if let Some(p) = prev {
            caret += sc.kern(p, id);
        }
        if let Some(og) = f.outline_glyph(id.with_scale_and_position(scale, point(caret, baseline))) {
            let b = og.px_bounds();
            og.draw(|gx, gy, cov| {
                let (ix, iy) = (b.min.x as i32 + gx as i32, b.min.y as i32 + gy as i32);
                if ix >= 0 && iy >= 0 && ix < w && iy < h {
                    let a = (cov * alpha).clamp(0.0, 1.0);
                    let p = img.get_pixel_mut(ix as u32, iy as u32);
                    for k in 0..3 {
                        p[k] = (p[k] as f32 * (1.0 - a) + colour[k] as f32 * a + 0.5) as u8;
                    }
                }
            });
        }
        caret += sc.h_advance(id);
        prev = Some(id);
    }
}

// ---- where things go -----------------------------------------------------------------------------------

/// The top left of a box of `bw` x `bh` placed at `anchor` inside a picture of `w` x `h`, `margin` px from the edges.
pub fn place(anchor: Anchor, w: f32, h: f32, bw: f32, bh: f32, margin: f32) -> (f32, f32) {
    use Anchor::*;
    let x = match anchor {
        TopLeft | Left | BottomLeft => margin,
        Top | Centre | Bottom => (w - bw) / 2.0,
        TopRight | Right | BottomRight => w - bw - margin,
    };
    let y = match anchor {
        TopLeft | Top | TopRight => margin,
        Left | Centre | Right => (h - bh) / 2.0,
        BottomLeft | Bottom | BottomRight => h - bh - margin,
    };
    (x, y)
}

// ---- sharpening, watermark, border ----------------------------------------------------------------------

/// Sharpening for the size and the use of the file: a little for a screen, more for a print.
pub fn sharpen_output(img: &RgbImage, mode: Sharpen) -> RgbImage {
    let detail = match mode {
        Sharpen::None => return img.clone(),
        Sharpen::Screen => Detail { sharp_amount: 35.0, sharp_radius: 0.8, sharp_masking: 15.0, ..Detail::default() },
        Sharpen::Print => Detail { sharp_amount: 55.0, sharp_radius: 1.4, sharp_masking: 25.0, ..Detail::default() },
    };
    develop::apply_detail(img, &detail)
}

pub fn apply_watermark(img: &mut RgbImage, wm: &Watermark) -> Result<(), String> {
    let (w, h) = (img.width() as f32, img.height() as f32);
    let long = w.max(h);
    let (margin, alpha) = (wm.margin / 100.0 * long, wm.opacity / 100.0);
    if alpha <= 0.0 {
        return Ok(());
    }
    match wm.kind {
        WatermarkKind::None => Ok(()),
        WatermarkKind::Text => {
            let text = wm.text.trim();
            if text.is_empty() {
                return Ok(());
            }
            let f = font()?;
            let px = (wm.size / 100.0 * long).max(6.0);
            let (bw, bh) = (text_width(f, px, text), line_height(f, px));
            let (x, y) = place(wm.anchor, w, h, bw, bh, margin);
            if wm.shadow {
                let d = (px * 0.06).max(1.0);
                draw_text(img, f, px, text, x + d, y + d, [0, 0, 0], alpha * 0.6);
            }
            draw_text(img, f, px, text, x, y, wm.colour, alpha);
            Ok(())
        }
        WatermarkKind::Image => {
            if wm.image_path.trim().is_empty() {
                return Err("Choose a logo image for the watermark.".into());
            }
            let logo = image::open(&wm.image_path).map_err(|e| format!("The watermark image could not be read: {e}"))?.to_rgba8();
            let target_w = (wm.size / 100.0 * long).clamp(4.0, w.min(h * logo.width() as f32 / logo.height().max(1) as f32).max(4.0)).round() as u32;
            let target_h = ((logo.height() as f32 * target_w as f32 / logo.width().max(1) as f32).round() as u32).max(1);
            let logo = image::imageops::resize(&logo, target_w, target_h, image::imageops::FilterType::CatmullRom);
            let (x0, y0) = place(wm.anchor, w, h, target_w as f32, target_h as f32, margin);
            for (lx, ly, p) in logo.enumerate_pixels() {
                let (ix, iy) = (x0.round() as i32 + lx as i32, y0.round() as i32 + ly as i32);
                if ix < 0 || iy < 0 || ix >= img.width() as i32 || iy >= img.height() as i32 {
                    continue;
                }
                let a = p[3] as f32 / 255.0 * alpha;
                let q = img.get_pixel_mut(ix as u32, iy as u32);
                for k in 0..3 {
                    q[k] = (q[k] as f32 * (1.0 - a) + p[k] as f32 * a + 0.5) as u8;
                }
            }
            Ok(())
        }
    }
}

fn brightness(c: [u8; 3]) -> f32 {
    0.299 * c[0] as f32 + 0.587 * c[1] as f32 + 0.114 * c[2] as f32
}

/// The photo inside a border, with the caption under it when asked for (the bottom is deeper by the height of the caption).
pub fn add_border(img: &RgbImage, b: &Border, meta: &Meta) -> Result<RgbImage, String> {
    if !b.enabled {
        return Ok(img.clone());
    }
    let (w, h) = (img.width(), img.height());
    let long = w.max(h) as f32;
    let side = (b.width / 100.0 * long).round() as u32;
    let lines = if b.caption.show { caption_lines(meta, &b.caption) } else { Vec::new() };
    let (mut text_px, mut pad, mut block) = (0.0f32, 0.0f32, 0.0f32);
    let total_w = w + 2 * side;
    if !lines.is_empty() {
        let f = font_weight(b.caption.weight)?;
        text_px = (long * b.caption.size.clamp(0.8, 4.0) / 100.0).max(10.0);
        // every line must fit across the picture: shrink the text until the longest does
        let room = total_w as f32 * 0.94;
        let widest = |px: f32| lines.iter().map(|l| text_width(f, px, l)).fold(0.0f32, f32::max);
        while widest(text_px) > room && text_px > 7.0 {
            text_px *= 0.95;
        }
        pad = text_px * 0.6;
        block = lines.len() as f32 * line_height(f, text_px) * 1.2;
    }
    // under the photo: some space, the lines of the caption, then the border as everywhere else
    let bottom = if lines.is_empty() { side } else { (pad + block).round() as u32 + side };
    let mut out = RgbImage::from_pixel(total_w, side + h + bottom, Rgb(b.colour));
    image::imageops::replace(&mut out, img, side as i64, side as i64);
    if !lines.is_empty() {
        let f = font_weight(b.caption.weight)?;
        let colour = b.caption_colour.unwrap_or(if brightness(b.colour) > 140.0 { [30, 30, 30] } else { [235, 235, 235] });
        let lh = line_height(f, text_px) * 1.2;
        for (i, line) in lines.iter().enumerate() {
            let x = (total_w as f32 - text_width(f, text_px, line)) / 2.0;
            let y = (side + h) as f32 + pad + i as f32 * lh;
            draw_text(&mut out, f, text_px, line, x, y, colour, 1.0);
        }
    }
    Ok(out)
}

/// Sharpening, watermark and border for a picture that is already edited and sized.
pub fn finish(img: RgbImage, meta: &Meta, s: &ExportSettings) -> Result<RgbImage, String> {
    let mut img = sharpen_output(&img, s.sharpen);
    apply_watermark(&mut img, &s.watermark)?;
    add_border(&img, &s.border, meta)
}

// ---- writing the file ---------------------------------------------------------------------------------------

fn encode(rgb: &RgbImage, path: &Path, s: &ExportSettings, icc: Vec<u8>) -> Result<(), String> {
    let (w, h) = rgb.dimensions();
    let file = || File::create(path).map_err(|e| e.to_string());
    match s.format {
        Format::Jpeg => media::save_jpeg_tagged(rgb, path, s.quality, icc),
        Format::Png => {
            let mut enc = image::codecs::png::PngEncoder::new_with_quality(BufWriter::new(file()?), image::codecs::png::CompressionType::Default, image::codecs::png::FilterType::Adaptive);
            enc.set_icc_profile(icc).map_err(|e| e.to_string())?;
            enc.write_image(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8).map_err(|e| e.to_string())
        }
        Format::Tiff => {
            let mut enc = image::codecs::tiff::TiffEncoder::new(BufWriter::new(file()?));
            enc.set_icc_profile(icc).map_err(|e| e.to_string())?;
            enc.write_image(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8).map_err(|e| e.to_string())
        }
        Format::Webp => {
            let mut enc = image::codecs::webp::WebPEncoder::new_lossless(BufWriter::new(file()?));
            enc.set_icc_profile(icc).map_err(|e| e.to_string())?;
            enc.write_image(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8).map_err(|e| e.to_string())
        }
        Format::Original | Format::Dng => Err("The original file is copied or converted, not written.".into()),
    }
}


// ---- camera details in the file -------------------------------------------------------------------------

/// One entry of a TIFF directory: tag, type (2 text, 3 short, 4 long, 5 rational), how many, and the bytes.
struct Entry {
    tag: u16,
    kind: u16,
    count: u32,
    data: Vec<u8>,
}

fn text_entry(tag: u16, s: &str) -> Entry {
    let mut data: Vec<u8> = s.chars().map(|c| if c.is_ascii() && !c.is_control() { c as u8 } else { b'?' }).collect();
    data.push(0);
    Entry { tag, kind: 2, count: data.len() as u32, data }
}

fn rational_entry(tag: u16, num: u32, den: u32) -> Entry {
    let mut data = num.to_be_bytes().to_vec();
    data.extend(den.to_be_bytes());
    Entry { tag, kind: 5, count: 1, data }
}

fn directory_len(entries: &[Entry]) -> usize {
    2 + 12 * entries.len() + 4 + entries.iter().filter(|e| e.data.len() > 4).map(|e| e.data.len() + e.data.len() % 2).sum::<usize>()
}

/// The directory as bytes, placed at `start` in the TIFF block (values that do not fit in four bytes follow the directory).
fn write_directory(entries: &[Entry], start: usize) -> Vec<u8> {
    let mut out = (entries.len() as u16).to_be_bytes().to_vec();
    let mut tail: Vec<u8> = Vec::new();
    let data_start = start + 2 + 12 * entries.len() + 4;
    for e in entries {
        out.extend(e.tag.to_be_bytes());
        out.extend(e.kind.to_be_bytes());
        out.extend(e.count.to_be_bytes());
        if e.data.len() <= 4 {
            let mut v = e.data.clone();
            v.resize(4, 0);
            out.extend(v);
        } else {
            out.extend(((data_start + tail.len()) as u32).to_be_bytes());
            tail.extend(&e.data);
            if e.data.len() % 2 == 1 {
                tail.push(0);
            }
        }
    }
    out.extend(0u32.to_be_bytes());
    out.extend(tail);
    out
}

/// The camera details a photographer expects to find in a picture (make, model, lens, exposure, aperture, ISO, focal length
/// and when it was taken), as the APP1 block of a JPEG. Where the picture was taken is never copied, and neither is the
/// orientation (the picture is already the right way up). Nothing, if there is nothing to say.
pub fn camera_info_segment(meta: &media::Meta) -> Option<Vec<u8>> {
    let when = meta.captured_local.as_deref().filter(|d| d.len() >= 19).map(|d| format!("{} {}", d[..10].replace('-', ":"), &d[11..19]));
    let mut main = vec![];
    if let Some(m) = &meta.make {
        main.push(text_entry(0x010F, m));
    }
    if let Some(m) = &meta.model {
        main.push(text_entry(0x0110, m));
    }
    let mut sub = vec![];
    if let Some(s) = meta.shutter_s.filter(|s| *s > 0.0 && s.is_finite()) {
        sub.push(if s < 1.0 { rational_entry(0x829A, 1, (1.0 / s).round().clamp(1.0, 4_000_000.0) as u32) } else { rational_entry(0x829A, (s * 10.0).round().min(4_000_000.0) as u32, 10) });
    }
    if let Some(a) = meta.aperture.filter(|a| *a > 0.0 && a.is_finite()) {
        sub.push(rational_entry(0x829D, (a * 100.0).round().min(4_000_000.0) as u32, 100));
    }
    if let Some(i) = meta.iso.filter(|i| *i > 0) {
        sub.push(Entry { tag: 0x8827, kind: 3, count: 1, data: (i.min(65535) as u16).to_be_bytes().to_vec() });
    }
    if let Some(w) = &when {
        sub.push(text_entry(0x9003, w));
    }
    if let Some(f) = meta.focal_mm.filter(|f| *f > 0.0 && f.is_finite()) {
        sub.push(rational_entry(0x920A, (f * 10.0).round().min(4_000_000.0) as u32, 10));
    }
    if let Some(l) = &meta.lens {
        sub.push(text_entry(0xA434, l));
    }
    if main.is_empty() && sub.is_empty() {
        return None;
    }
    let sub_at = if sub.is_empty() {
        0
    } else {
        main.push(Entry { tag: 0x8769, kind: 4, count: 1, data: vec![0; 4] });
        8 + directory_len(&main)
    };
    if let Some(p) = main.iter_mut().find(|e| e.tag == 0x8769) {
        p.data = (sub_at as u32).to_be_bytes().to_vec();
    }
    let mut tiff = b"MM\x00\x2A\x00\x00\x00\x08".to_vec();
    tiff.extend(write_directory(&main, 8));
    if !sub.is_empty() {
        tiff.extend(write_directory(&sub, sub_at));
    }
    let mut seg = vec![0xFF, 0xE1];
    seg.extend(((tiff.len() + 8) as u16).to_be_bytes());
    seg.extend(b"Exif\0\0");
    seg.extend(tiff);
    Some(seg)
}

/// Put the block straight after the start of the JPEG file just written.
fn add_camera_info(path: &Path, segment: &[u8]) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() < 2 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Ok(());
    }
    let mut out = Vec::with_capacity(bytes.len() + segment.len());
    out.extend(&bytes[..2]);
    out.extend(segment);
    out.extend(&bytes[2..]);
    std::fs::write(path, out).map_err(|e| e.to_string())
}

/// The XMP packet to embed for a photo: only the details `level` allows ("copyright" or "all"), never the rating, flag, label or this
/// program's own edits. None when there is nothing to say.
pub fn metadata_packet(sc: &crate::xmp::Sidecar, level: &str) -> Option<String> {
    let mut out = crate::xmp::Sidecar::default();
    out.creator = sc.creator.clone();
    out.copyright = sc.copyright.clone();
    out.credit = sc.credit.clone();
    out.source = sc.source.clone();
    out.usage_terms = sc.usage_terms.clone();
    if level == "all" {
        out.title = sc.title.clone();
        out.caption = sc.caption.clone();
        out.headline = sc.headline.clone();
        out.job_title = sc.job_title.clone();
        out.instructions = sc.instructions.clone();
        out.job_id = sc.job_id.clone();
        out.sublocation = sc.sublocation.clone();
        out.city = sc.city.clone();
        out.state = sc.state.clone();
        out.country = sc.country.clone();
        out.keywords = sc.keywords.clone();
    }
    if out == crate::xmp::Sidecar::default() {
        return None;
    }
    // the sidecar writer marks its own files: leave that out of a picture that goes to someone else
    let text = crate::xmp::write(&out);
    Some(text.replace(" lucent:Flag=\"none\"", "").replace(&format!(" xmlns:lucent=\"{}\"", crate::xmp::NS_LUCENT), ""))
}

/// Put an XMP packet into the picture file just written: a JPEG (after its JFIF header) or a PNG (an iTXt chunk after the header chunk).
/// Other kinds of file are left as they are. Returns whether anything was written.
pub fn embed_xmp(path: &Path, packet: &str) -> Result<bool, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.starts_with(&[0xFF, 0xD8]) {
        let mut body = b"http://ns.adobe.com/xap/1.0/\0".to_vec();
        body.extend(packet.as_bytes());
        if body.len() + 2 > 65_535 {
            return Err("The details are too long to be written into a JPEG file.".into());
        }
        let mut seg = vec![0xFF, 0xE1];
        seg.extend(((body.len() + 2) as u16).to_be_bytes());
        seg.extend(body);
        // after the JFIF header when there is one
        let at = if bytes.get(2..4) == Some(&[0xFF, 0xE0]) && bytes.get(6..11) == Some(b"JFIF\0") { 4 + u16::from_be_bytes([bytes[4], bytes[5]]) as usize } else { 2 };
        let at = at.min(bytes.len());
        let mut out = bytes[..at].to_vec();
        out.extend(seg);
        out.extend(&bytes[at..]);
        std::fs::write(path, out).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let ihdr_len = u32::from_be_bytes(bytes.get(8..12).ok_or("not a PNG")?.try_into().unwrap()) as usize;
        let after = (8 + 12 + ihdr_len).min(bytes.len());
        let mut data = b"XML:com.adobe.xmp\0".to_vec();
        data.extend([0u8, 0u8]); // not compressed
        data.extend(b"\0\0"); // no language, no translated keyword
        data.extend(packet.as_bytes());
        let mut body = b"iTXt".to_vec();
        body.extend(&data);
        let mut chunk = (data.len() as u32).to_be_bytes().to_vec();
        chunk.extend(&body);
        chunk.extend(crate::dpi::crc32(&body).to_be_bytes());
        let mut out = bytes[..after].to_vec();
        out.extend(chunk);
        out.extend(&bytes[after..]);
        std::fs::write(path, out).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

/// Export one photo. `seq` is its number in the batch (1, 2, 3 ...), for the {seq} in the name.
pub fn export_photo(src: &Path, dest_dir: &Path, recipe: Option<&Recipe>, settings: &ExportSettings, seq: usize) -> Result<PathBuf, String> {
    export_photo_with(src, dest_dir, recipe, settings, seq, &|_, _| {})
}

/// As export_photo, telling `progress(done, total)` how far the enlarging has got (in tiles; it is only called when the AI
/// enlargement is used).
pub fn export_photo_with(src: &Path, dest_dir: &Path, recipe: Option<&Recipe>, settings: &ExportSettings, seq: usize, progress: &(dyn Fn(usize, usize) + Sync)) -> Result<PathBuf, String> {
    export_photo_from(src, src, dest_dir, recipe, settings, seq, progress)
}

/// As `export_photo_with`, but the pixels come from `pixels` (the photo's smart preview when its original is offline) while the name
/// and the camera settings still come from `src`.
pub fn export_photo_from(pixels: &Path, src: &Path, dest_dir: &Path, recipe: Option<&Recipe>, settings: &ExportSettings, seq: usize, progress: &(dyn Fn(usize, usize) + Sync)) -> Result<PathBuf, String> {
    let s = settings.sanitized();
    if s.format == Format::Dng {
        // the photo's RAW file in the DNG wrapping
        if media::kind_of(src) != Some(media::Kind::Raw) {
            return Err(format!("{} is not a RAW photo, so it cannot be written as a DNG.", src.file_name().and_then(|n| n.to_str()).unwrap_or("The file")));
        }
        let meta = media::read_meta(src);
        let path = media::unique_path(dest_dir, &expand_name(&s.name_template, src, &meta, seq), "dng");
        crate::dngout::convert(src, &path, false)?;
        return Ok(path);
    }
    if s.format == Format::Original {
        // the photo's own file, as it is (and its sidecar beside it, when there is one)
        let meta = media::read_meta(src);
        let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
        let path = media::unique_path(dest_dir, &expand_name(&s.name_template, src, &meta, seq), &ext);
        std::fs::copy(src, &path).map_err(|e| format!("{}: {e}", src.display()))?;
        let raw = media::kind_of(src) == Some(media::Kind::Raw);
        let sidecar = crate::xmp::sidecar_path(src, raw);
        if sidecar.is_file() {
            let _ = std::fs::copy(&sidecar, crate::xmp::sidecar_path(&path, raw));
        }
        return Ok(path);
    }
    let (picture, long_edge) = media::edited_picture_with(pixels, &|w, h| export_long_edge(&s, w, h), recipe)?;
    let picture = picture.to_rgb8();
    // the edits are done at the picture's own size; a picture that is shorter than the size asked for is made bigger now
    let picture = upscale::enlarge(picture, long_edge, s.enlarge, progress)?;
    let meta = media::read_meta(src);
    let finished = finish(picture, &meta, &s)?;
    let path = media::unique_path(dest_dir, &expand_name(&s.name_template, src, &meta, seq), s.format.extension());
    let (rgb, icc) = colour::for_export(&finished, Space::from_name(&s.colour_space))?;
    encode(&rgb, &path, &s, icc)?;
    if s.camera_info && s.format == Format::Jpeg {
        if let Some(seg) = camera_info_segment(&meta) {
            add_camera_info(&path, &seg)?;
        }
    }
    // last, so the JFIF header with the resolution is the first thing in a JPEG whatever was added before it
    crate::dpi::set_dpi(&path, s.dpi)?;
    Ok(path)
}

/// A small JPEG of how the export would look, from the photo's preview: its edits, the watermark, the border and the caption.
/// `proxy` is the photo's preview, `src` the original (for the camera settings).
pub fn preview(proxy: &RgbImage, src: &Path, recipe: Option<&Recipe>, settings: &ExportSettings, max_edge: u32) -> Result<Vec<u8>, String> {
    let s = settings.sanitized();
    let sized = preview_base(proxy, recipe, &s, max_edge);
    preview_finish(sized, src, &s)
}

/// The edited, resized picture the preview is drawn on, before any watermark or border.
fn preview_base(proxy: &RgbImage, recipe: Option<&Recipe>, s: &ExportSettings, max_edge: u32) -> RgbImage {
    let edited = match recipe {
        Some(r) => develop::render(proxy, r),
        None => proxy.clone(),
    };
    let edge = preview_edge(s, max_edge);
    if edited.width().max(edited.height()) > edge {
        let k = edge as f32 / edited.width().max(edited.height()) as f32;
        image::imageops::resize(&edited, ((edited.width() as f32 * k).round() as u32).max(1), ((edited.height() as f32 * k).round() as u32).max(1), image::imageops::FilterType::Triangle)
    } else {
        edited
    }
}

fn preview_edge(s: &ExportSettings, max_edge: u32) -> u32 {
    if s.size_mode == SizeMode::LongEdge && s.long_edge > 0 {
        s.long_edge.min(max_edge)
    } else {
        max_edge
    }
}

fn preview_finish(sized: RgbImage, src: &Path, s: &ExportSettings) -> Result<Vec<u8>, String> {
    let shown = finish(sized, &media::read_meta(src), s)?;
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82).encode_image(&shown).map_err(|e| e.to_string())?;
    Ok(out)
}

/// The last preview's edited picture, kept so that moving a watermark or border slider only redraws the watermark and the border,
/// not the whole edit. The key names the photo and its edits; the size is added to it in preview_cached.
static PREVIEW_BASE: std::sync::Mutex<Option<(String, RgbImage)>> = std::sync::Mutex::new(None);

pub fn preview_cached(key: &str, load: impl FnOnce() -> Result<RgbImage, String>, src: &Path, recipe: Option<&Recipe>, settings: &ExportSettings, max_edge: u32) -> Result<Vec<u8>, String> {
    let s = settings.sanitized();
    let key = format!("{key}|{}", preview_edge(&s, max_edge));
    let cached = PREVIEW_BASE.lock().ok().and_then(|g| g.as_ref().filter(|(k, _)| *k == key).map(|(_, img)| img.clone()));
    let sized = match cached {
        Some(img) => img,
        None => {
            let img = preview_base(&load()?, recipe, &s, max_edge);
            if let Ok(mut g) = PREVIEW_BASE.lock() {
                *g = Some((key, img.clone()));
            }
            img
        }
    };
    preview_finish(sized, src, &s)
}

/// A folder name typed by the user, checked so that it can only make one folder inside the chosen destination.
pub fn folder_name(raw: &str) -> Result<String, String> {
    let name = raw.trim().trim_end_matches(['.', ' ']).to_string();
    if name.is_empty() {
        return Err("Give the new folder a name.".into());
    }
    if name.chars().count() > 100 {
        return Err("The folder name is too long (100 letters at most).".into());
    }
    if let Some(c) = name.chars().find(|c| c.is_control() || "<>:\"/\\|?*".contains(*c)) {
        return Err(format!("A folder name cannot contain {}.", if c.is_control() { "control characters".to_string() } else { format!("'{c}'") }));
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let numbered = (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem[3..].chars().all(|c| ('1'..='9').contains(&c));
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str()) || numbered {
        return Err(format!("'{name}' is a name Windows keeps for itself. Pick another."));
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_folder_name_makes_one_folder_and_nothing_else() {
        assert_eq!(folder_name("  Wedding 2026 ").unwrap(), "Wedding 2026");
        assert_eq!(folder_name("Day 1. ").unwrap(), "Day 1", "trailing dots and spaces are dropped, Windows would drop them anyway");
        assert_eq!(folder_name("Ünïcode ✓").unwrap(), "Ünïcode ✓");
        for bad in ["", "   ", "..", ".", "a/b", "a\\b", "C:x", "x*", "a?b", "a|b", "q\"", "<a>", "tab\there", "CON", "nul.txt", "com1", "LPT9"] {
            assert!(folder_name(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(folder_name("COM10").is_ok() && folder_name("CONSOLE").is_ok(), "only the real reserved names");
        assert!(folder_name(&"a".repeat(101)).is_err() && folder_name(&"a".repeat(100)).is_ok());
    }

    #[test]
    fn the_cached_preview_equals_the_uncached_one_and_follows_the_settings() {
        let proxy = photo(300, 200);
        let src = std::path::PathBuf::from("none.jpg");
        let plain = ExportSettings::default();
        let mut framed = plain.clone();
        framed.border.enabled = true;
        framed.border.width = 6.0;
        let a = preview_cached("k1", || Ok(proxy.clone()), &src, None, &plain, 900).unwrap();
        assert_eq!(a, preview(&proxy, &src, None, &plain, 900).unwrap());
        // the second time the picture is not loaded again, and a new setting still shows
        let b = preview_cached("k1", || Err("must not be loaded".into()), &src, None, &framed, 900).unwrap();
        assert_eq!(b, preview(&proxy, &src, None, &framed, 900).unwrap());
        assert_ne!(a, b);
        // another photo, or another size, is not served from the old picture
        assert!(preview_cached("k2", || Err("loaded".into()), &src, None, &plain, 900).is_err());
        assert!(preview_cached("k1", || Err("loaded".into()), &src, None, &ExportSettings { long_edge: 100, ..plain.clone() }, 900).is_err());
    }
    use image::{ImageBuffer, ImageDecoder, ImageReader};

    fn photo(w: u32, h: u32) -> RgbImage {
        ImageBuffer::from_fn(w, h, |x, y| Rgb([(60 + x * 100 / w.max(1)) as u8, (80 + y * 100 / h.max(1)) as u8, 110]))
    }
    fn flat(w: u32, h: u32, c: [u8; 3]) -> RgbImage {
        ImageBuffer::from_pixel(w, h, Rgb(c))
    }
    fn meta() -> Meta {
        Meta { captured_local: Some("2026-10-03T14:05:09".into()), make: Some("Canon".into()), model: Some("Canon EOS R6".into()), lens: Some("RF50mm F1.8 STM".into()), iso: Some(400), aperture: Some(1.8), shutter_s: Some(1.0 / 200.0), focal_mm: Some(50.0), ..Meta::default() }
    }
    /// The box (x0, y0, x1, y1) of pixels that differ between two pictures of the same size, if any.
    fn changed(a: &RgbImage, b: &RgbImage) -> Option<(u32, u32, u32, u32)> {
        let mut bb: Option<(u32, u32, u32, u32)> = None;
        for (x, y, p) in a.enumerate_pixels() {
            if p != b.get_pixel(x, y) {
                bb = Some(match bb {
                    None => (x, y, x, y),
                    Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
                });
            }
        }
        bb
    }
    fn dark_pixels(img: &RgbImage) -> usize {
        img.pixels().filter(|p| p[0] < 40 && p[1] < 40 && p[2] < 40).count()
    }
    fn text_mark(text: &str) -> Watermark {
        Watermark { kind: WatermarkKind::Text, text: text.into(), ..Watermark::default() }
    }

    // ---- settings and names

    #[test]
    fn settings_are_brought_into_range_and_missing_ones_take_their_defaults() {
        let wild = ExportSettings { quality: 3, long_edge: 999_999, name_template: "   ".into(), watermark: Watermark { size: f32::NAN, opacity: 900.0, margin: -4.0, text: "x".repeat(500), ..Watermark::default() }, border: Border { width: 99.0, ..Border::default() }, ..ExportSettings::default() }.sanitized();
        assert_eq!((wild.quality, wild.long_edge, wild.name_template.as_str()), (10, 20000, "{name}"));
        assert_eq!((wild.watermark.size, wild.watermark.opacity, wild.watermark.margin, wild.watermark.text.chars().count()), (3.0, 100.0, 0.0, 200));
        assert_eq!(wild.border.width, 30.0);
        let loaded: ExportSettings = serde_json::from_str(r#"{"format":"png","watermark":{"kind":"text","anchor":"topLeft"},"border":{"enabled":true}}"#).unwrap();
        assert_eq!((loaded.format, loaded.quality, loaded.long_edge), (Format::Png, 85, 2048));
        assert_eq!((loaded.watermark.kind, loaded.watermark.anchor, loaded.watermark.opacity), (WatermarkKind::Text, Anchor::TopLeft, 70.0));
        assert!(loaded.border.enabled && !loaded.border.caption.show);
        assert_eq!(Format::Webp.extension(), "webp");
        assert_eq!(Format::Tiff.extension(), "tif");
    }

    #[test]
    fn file_names_fill_in_the_template_and_never_hold_characters_a_file_cannot() {
        let m = meta();
        let src = Path::new("C:/photos/IMG_0042.CR2");
        assert_eq!(expand_name("{name}", src, &m, 1), "IMG_0042");
        assert_eq!(expand_name("{date}_{name}_{seq}", src, &m, 7), "2026-10-03_IMG_0042_007");
        assert_eq!(expand_name("{camera} {seq}", src, &m, 12), "Canon EOS R6 012");
        assert_eq!(expand_name("wedding/{name}: final?", src, &m, 1), "wedding-IMG_0042- final-");
        assert_eq!(expand_name("{date}", src, &Meta::default(), 1), "undated");
        assert_eq!(expand_name("...", src, &m, 1), "IMG_0042", "a name of nothing falls back to the photo's own");
        assert!(expand_name(&"a".repeat(300), src, &m, 1).chars().count() <= 120);
    }

    // ---- the camera settings as text

    #[test]
    fn camera_settings_read_the_way_photographers_write_them() {
        assert_eq!(fmt_aperture(1.8), "f/1.8");
        assert_eq!(fmt_aperture(8.0), "f/8");
        assert_eq!(fmt_aperture(5.6), "f/5.6");
        assert_eq!(fmt_shutter(1.0 / 200.0), "1/200 s");
        assert_eq!(fmt_shutter(1.0 / 8000.0), "1/8000 s");
        assert_eq!(fmt_shutter(2.5), "2.5 s");
        assert_eq!(fmt_shutter(30.0), "30 s");
        assert_eq!(fmt_focal(49.6), "50 mm");
        assert_eq!(fmt_date("2026-10-03T14:05:09").as_deref(), Some("3 Oct 2026"));
        assert_eq!(fmt_date("nonsense"), None);
        // the make is not repeated when the model already starts with it
        assert_eq!(camera_name(&meta()).as_deref(), Some("Canon EOS R6"));
        let bare = Meta { make: Some("SONY".into()), model: Some("ILCE-7M3".into()), ..Meta::default() };
        assert_eq!(camera_name(&bare).as_deref(), Some("SONY ILCE-7M3"));
        assert_eq!(camera_name(&Meta::default()), None);
    }

    #[test]
    fn the_caption_can_be_one_line_or_one_line_per_item_with_the_separator_and_spacing_chosen() {
        let on = Caption { show: true, ..Caption::default() };
        // the plain layout is what it always was
        assert_eq!(caption_lines(&meta(), &on), ["Canon EOS R6  ·  RF50mm F1.8 STM", "50 mm  ·  f/1.8  ·  1/200 s  ·  ISO 400"]);
        let one = Caption { layout: CaptionLayout::Single, ..on.clone() };
        assert_eq!(caption_lines(&meta(), &one), ["Canon EOS R6  ·  RF50mm F1.8 STM  ·  50 mm  ·  f/1.8  ·  1/200 s  ·  ISO 400"]);
        let items = Caption { layout: CaptionLayout::Items, ..on.clone() };
        assert_eq!(caption_lines(&meta(), &items), ["Canon EOS R6", "RF50mm F1.8 STM", "50 mm", "f/1.8", "1/200 s", "ISO 400"]);
        // your own line stays a line of its own in every layout
        let noted = Caption { note: "Studio".into(), layout: CaptionLayout::Single, ..on.clone() };
        assert_eq!(caption_lines(&meta(), &noted)[0], "Studio");
        assert_eq!(caption_lines(&meta(), &noted).len(), 2);
        let wide_bar = Caption { layout: CaptionLayout::Single, separator: CaptionSeparator::Bar, spacing: 4, camera: false, lens: false, focal: false, ..on.clone() };
        assert_eq!(caption_lines(&meta(), &wide_bar), ["f/1.8    |    1/200 s    |    ISO 400"]);
        let tight_slash = Caption { layout: CaptionLayout::Single, separator: CaptionSeparator::Slash, spacing: 1, camera: false, lens: false, focal: false, ..on.clone() };
        assert_eq!(caption_lines(&meta(), &tight_slash), ["f/1.8 / 1/200 s / ISO 400"]);
        let gap = Caption { layout: CaptionLayout::Single, separator: CaptionSeparator::Gap, camera: false, lens: false, focal: false, ..on.clone() };
        assert_eq!(caption_lines(&meta(), &gap), ["f/1.8      1/200 s      ISO 400"]);
        // older saved settings have none of the new fields and load as the plain layout
        let old: Caption = serde_json::from_str(r#"{"show":true,"camera":true}"#).unwrap();
        assert_eq!((old.layout, old.separator, old.spacing, old.weight, old.size), (CaptionLayout::Grouped, CaptionSeparator::Dot, 2, CaptionWeight::Regular, 1.6));
        // the words of the earlier version still load, and numbers are held to their range
        let words: Caption = serde_json::from_str(r#"{"spacing":"wide","size":"big"}"#).unwrap();
        assert_eq!((words.spacing, words.size), (4, 1.6));
        let wild: Caption = serde_json::from_str(r#"{"spacing":99,"size":50}"#).unwrap();
        assert_eq!((wild.spacing, wild.size), (12, 4.0));
        let new: Caption = serde_json::from_str(r#"{"layout":"items","separator":"gap","spacing":7,"weight":"semibold"}"#).unwrap();
        assert_eq!((new.layout, new.weight), (CaptionLayout::Items, CaptionWeight::Semibold));
    }

    #[test]
    fn a_bigger_letter_size_makes_a_deeper_caption_and_the_spacing_slider_widens_the_line() {
        let img = RgbImage::from_pixel(1200, 800, Rgb([120, 120, 120]));
        let deep = |size: f32| {
            let b = Border { enabled: true, width: 4.0, caption: Caption { show: true, size, layout: CaptionLayout::Single, camera: false, lens: false, ..Caption::default() }, ..Border::default() };
            add_border(&img, &b, &meta()).unwrap().height()
        };
        assert!(deep(3.0) > deep(1.6) && deep(1.6) > deep(0.8), "{} {} {}", deep(0.8), deep(1.6), deep(3.0));
        let one = |spacing: u8| caption_lines(&meta(), &Caption { show: true, layout: CaptionLayout::Single, spacing, ..Caption::default() })[0].chars().count();
        assert!(one(0) < one(2) && one(2) < one(12));
    }

    #[test]
    fn every_weight_draws_and_a_heavier_weight_takes_more_room_than_a_lighter_one() {
        let img = RgbImage::from_pixel(600, 400, Rgb([120, 120, 120]));
        let widths: Vec<u32> = [CaptionWeight::Light, CaptionWeight::Regular, CaptionWeight::Semibold, CaptionWeight::Bold]
            .iter()
            .map(|w| {
                let b = Border { enabled: true, width: 4.0, caption: Caption { show: true, weight: *w, layout: CaptionLayout::Single, ..Caption::default() }, ..Border::default() };
                let out = add_border(&img, &b, &meta()).unwrap();
                // the number of dark pixels in the caption area is a measure of how heavy the letters are
                (0..out.width()).flat_map(|x| (410..out.height()).map(move |y| (x, y))).filter(|&(x, y)| out.get_pixel(x, y).0[0] < 200).count() as u32
            })
            .collect();
        assert!(widths.iter().all(|n| *n > 0), "every weight draws something: {widths:?}");
        assert!(widths[3] >= widths[0], "bold is at least as heavy as light: {widths:?}");
    }

    #[test]
    fn the_caption_shows_what_is_ticked_and_leaves_out_what_the_file_does_not_have() {
        let all = Caption { show: true, date: true, note: "  Studio session  ".into(), ..Caption::default() };
        assert_eq!(caption_lines(&meta(), &all), ["Studio session", "Canon EOS R6  ·  RF50mm F1.8 STM", "50 mm  ·  f/1.8  ·  1/200 s  ·  ISO 400  ·  3 Oct 2026"]);
        let only_exposure = Caption { show: true, camera: false, lens: false, focal: false, date: false, ..Caption::default() };
        assert_eq!(caption_lines(&meta(), &only_exposure), ["f/1.8  ·  1/200 s  ·  ISO 400"]);
        let nothing = Caption { show: true, camera: false, lens: false, focal: false, aperture: false, shutter: false, iso: false, date: false, note: String::new(), ..Caption::default() };
        assert!(caption_lines(&meta(), &nothing).is_empty());
        // a photo with no camera data (a scan, a screenshot) gives no lines rather than blanks
        assert!(caption_lines(&Meta::default(), &Caption { show: true, ..Caption::default() }).is_empty());
        let partial = Meta { iso: Some(100), lens: Some("unknown".into()), ..Meta::default() };
        assert_eq!(caption_lines(&partial, &Caption { show: true, ..Caption::default() }), ["ISO 100"]);
    }

    #[test]
    fn a_box_goes_where_its_anchor_says_inside_the_margin() {
        let at = |a| place(a, 1000.0, 600.0, 100.0, 50.0, 20.0);
        assert_eq!(at(Anchor::TopLeft), (20.0, 20.0));
        assert_eq!(at(Anchor::Top), (450.0, 20.0));
        assert_eq!(at(Anchor::TopRight), (880.0, 20.0));
        assert_eq!(at(Anchor::Left), (20.0, 275.0));
        assert_eq!(at(Anchor::Centre), (450.0, 275.0));
        assert_eq!(at(Anchor::Right), (880.0, 275.0));
        assert_eq!(at(Anchor::BottomLeft), (20.0, 530.0));
        assert_eq!(at(Anchor::Bottom), (450.0, 530.0));
        assert_eq!(at(Anchor::BottomRight), (880.0, 530.0));
    }

    // ---- watermark

    #[test]
    fn a_text_watermark_sits_at_its_corner_and_touches_nothing_else() {
        let base = flat(1200, 800, [90, 90, 90]);
        for (anchor, in_right, in_bottom) in [(Anchor::BottomRight, true, true), (Anchor::TopLeft, false, false), (Anchor::BottomLeft, false, true), (Anchor::TopRight, true, false)] {
            let mut img = base.clone();
            apply_watermark(&mut img, &Watermark { anchor, ..text_mark("© Example Studio") }).unwrap();
            let (x0, y0, x1, y1) = changed(&base, &img).expect("something was drawn");
            assert_eq!(x0 > 600 && x1 > 600, in_right, "{anchor:?} horizontally: {x0}..{x1}");
            assert_eq!(y0 > 400 && y1 > 400, in_bottom, "{anchor:?} vertically: {y0}..{y1}");
            assert!(x1 < 1200 && y1 < 800 && x1 - x0 > 60, "a text of some width inside the picture");
        }
    }

    #[test]
    fn nothing_is_drawn_for_no_watermark_an_empty_text_or_no_opacity() {
        let base = flat(600, 400, [90, 90, 90]);
        for wm in [Watermark::default(), text_mark("   "), Watermark { opacity: 0.0, ..text_mark("hello") }] {
            let mut img = base.clone();
            apply_watermark(&mut img, &wm).unwrap();
            assert_eq!(img, base);
        }
    }

    #[test]
    fn the_text_has_its_colour_the_opacity_blends_it_and_the_shadow_adds_dark_edges() {
        let base = flat(1200, 800, [100, 100, 100]);
        let draw = |wm: Watermark| {
            let mut img = base.clone();
            apply_watermark(&mut img, &wm).unwrap();
            img
        };
        let brightest = |img: &RgbImage| img.pixels().map(|p| p[0]).max().unwrap();
        let solid = draw(Watermark { opacity: 100.0, shadow: false, colour: [255, 255, 255], ..text_mark("WWWW") });
        let faint = draw(Watermark { opacity: 40.0, shadow: false, colour: [255, 255, 255], ..text_mark("WWWW") });
        assert_eq!(brightest(&solid), 255, "full opacity reaches the colour");
        assert!(brightest(&faint) > 100 && brightest(&faint) < 220, "40 per cent is a blend: {}", brightest(&faint));
        let red = draw(Watermark { opacity: 100.0, shadow: false, colour: [255, 0, 0], ..text_mark("WWWW") });
        assert!(red.pixels().any(|p| p[0] > 240 && p[1] < 20));
        let with_shadow = draw(Watermark { opacity: 100.0, shadow: true, ..text_mark("WWWW") });
        let without = draw(Watermark { opacity: 100.0, shadow: false, ..text_mark("WWWW") });
        assert!(dark_pixels(&with_shadow) + 0 >= dark_pixels(&without));
        assert!(with_shadow.pixels().any(|p| p[0] < 90), "the shadow darkens the grey behind the letters");
        assert!(!without.pixels().any(|p| p[0] < 100), "no shadow, nothing darker than the picture");
    }

    #[test]
    fn the_watermark_is_the_same_share_of_the_picture_at_any_size() {
        let h = |w: u32| {
            let base = flat(w, w * 2 / 3, [90, 90, 90]);
            let mut img = base.clone();
            apply_watermark(&mut img, &text_mark("Example")).unwrap();
            let (x0, y0, x1, y1) = changed(&base, &img).unwrap();
            ((x1 - x0) as f32 / w as f32, (y1 - y0) as f32 / w as f32)
        };
        let (small, big) = (h(900), h(1800));
        assert!((small.0 - big.0).abs() < 0.01 && (small.1 - big.1).abs() < 0.01, "{small:?} vs {big:?}");
        let larger = {
            let base = flat(1200, 800, [90, 90, 90]);
            let mut img = base.clone();
            apply_watermark(&mut img, &Watermark { size: 6.0, ..text_mark("Example") }).unwrap();
            changed(&base, &img).unwrap()
        };
        let normal = {
            let base = flat(1200, 800, [90, 90, 90]);
            let mut img = base.clone();
            apply_watermark(&mut img, &text_mark("Example")).unwrap();
            changed(&base, &img).unwrap()
        };
        assert!(larger.2 - larger.0 > (normal.2 - normal.0) * 3 / 2, "twice the size is clearly wider");
    }

    #[test]
    fn an_image_watermark_is_placed_scaled_and_blended_and_bad_files_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        // a 40 x 20 logo: left half opaque red, right half fully transparent
        let logo = image::RgbaImage::from_fn(40, 20, |x, _| if x < 20 { image::Rgba([255, 0, 0, 255]) } else { image::Rgba([0, 255, 0, 0]) });
        let path = dir.path().join("logo.png");
        logo.save(&path).unwrap();
        let base = flat(1000, 600, [100, 100, 100]);
        let wm = |opacity: f32, anchor| Watermark { kind: WatermarkKind::Image, image_path: path.to_string_lossy().into_owned(), anchor, size: 10.0, opacity, margin: 2.0, ..Watermark::default() };
        let mut full = base.clone();
        apply_watermark(&mut full, &wm(100.0, Anchor::BottomLeft)).unwrap();
        let (x0, y0, x1, y1) = changed(&base, &full).unwrap();
        assert!(x0 < 60 && y1 > 540, "bottom left: {x0},{y0} to {x1},{y1}");
        assert!((x1 - x0 + 1) <= 52 && (x1 - x0 + 1) >= 40, "half of a logo 100 px wide: {}", x1 - x0 + 1); // only the opaque half changes
        assert_eq!(full.get_pixel(x0 + 5, y0 + 5).0, [255, 0, 0]);
        let mut half = base.clone();
        apply_watermark(&mut half, &wm(50.0, Anchor::BottomLeft)).unwrap();
        let blended = half.get_pixel(x0 + 5, y0 + 5);
        assert!(blended[0] > 150 && blended[0] < 220 && blended[1] > 40 && blended[1] < 100, "half red over grey: {blended:?}");
        let mut img = base.clone();
        let err = apply_watermark(&mut img, &Watermark { kind: WatermarkKind::Image, image_path: String::new(), ..Watermark::default() }).unwrap_err();
        assert!(err.contains("Choose a logo"), "{err}");
        let broken = dir.path().join("broken.png");
        std::fs::write(&broken, b"not an image").unwrap();
        assert!(apply_watermark(&mut img, &Watermark { kind: WatermarkKind::Image, image_path: broken.to_string_lossy().into_owned(), ..Watermark::default() }).unwrap_err().contains("could not be read"));
        assert!(apply_watermark(&mut img, &Watermark { kind: WatermarkKind::Image, image_path: dir.path().join("missing.png").to_string_lossy().into_owned(), ..Watermark::default() }).is_err());
        assert_eq!(img, base, "a failed watermark leaves the picture alone");
    }

    // ---- border and caption

    #[test]
    fn a_border_goes_round_the_photo_in_its_colour_and_the_photo_is_untouched() {
        let img = photo(1000, 600);
        let b = Border { enabled: true, width: 5.0, colour: [20, 40, 60], ..Border::default() };
        let out = add_border(&img, &b, &meta()).unwrap();
        assert_eq!((out.width(), out.height()), (1100, 700)); // 5 per cent of 1000 is 50 px each side
        for (x, y) in [(0, 0), (1099, 0), (0, 699), (1099, 699), (49, 300), (1050, 300), (500, 49), (500, 650)] {
            assert_eq!(out.get_pixel(x, y).0, [20, 40, 60], "border at {x},{y}");
        }
        assert_eq!(image::imageops::crop_imm(&out, 50, 50, 1000, 600).to_image(), img);
        assert_eq!(add_border(&img, &Border { enabled: false, ..b.clone() }, &meta()).unwrap(), img, "off means untouched");
    }

    #[test]
    fn a_caption_makes_the_bottom_deeper_and_is_drawn_to_be_read() {
        let img = photo(1000, 600);
        let plain = Border { enabled: true, width: 4.0, colour: [255, 255, 255], ..Border::default() };
        let captioned = Border { caption: Caption { show: true, ..Caption::default() }, ..plain.clone() };
        let (a, b) = (add_border(&img, &plain, &meta()).unwrap(), add_border(&img, &captioned, &meta()).unwrap());
        assert_eq!(a.width(), b.width());
        assert!(b.height() > a.height() + 40, "deeper at the bottom: {} vs {}", b.height(), a.height());
        // dark text on the white border, none above the photo
        let strip = image::imageops::crop_imm(&b, 0, 40 + 600, b.width(), b.height() - 640).to_image();
        assert!(strip.pixels().filter(|p| p[0] < 100).count() > 100, "text pixels in the caption strip");
        assert!(image::imageops::crop_imm(&b, 0, 0, b.width(), 40).to_image().pixels().all(|p| p.0 == [255, 255, 255]));
        // on a dark border the text turns light
        let dark = add_border(&img, &Border { colour: [10, 10, 10], ..captioned.clone() }, &meta()).unwrap();
        let strip = image::imageops::crop_imm(&dark, 0, 640, dark.width(), dark.height() - 640).to_image();
        assert!(strip.pixels().filter(|p| p[0] > 150).count() > 100);
        // a colour of your own
        let red = add_border(&img, &Border { caption_colour: Some([200, 0, 0]), ..captioned.clone() }, &meta()).unwrap();
        assert!(image::imageops::crop_imm(&red, 0, 640, red.width(), red.height() - 640).to_image().pixels().any(|p| p[0] > 180 && p[1] < 60));
    }

    #[test]
    fn a_caption_with_nothing_to_say_adds_no_empty_band_and_the_note_alone_is_enough() {
        let img = photo(1000, 600);
        let base = Border { enabled: true, width: 4.0, ..Border::default() };
        let none = Caption { show: true, camera: false, lens: false, focal: false, aperture: false, shutter: false, iso: false, date: false, note: String::new(), ..Caption::default() };
        let plain = add_border(&img, &base, &meta()).unwrap();
        assert_eq!(add_border(&img, &Border { caption: none.clone(), ..base.clone() }, &meta()).unwrap().height(), plain.height());
        assert_eq!(add_border(&img, &Border { caption: Caption { show: true, ..Caption::default() }, ..base.clone() }, &Meta::default()).unwrap().height(), plain.height(), "no camera data, no band");
        let noted = add_border(&img, &Border { caption: Caption { note: "© Me 2026".into(), ..none }, ..base.clone() }, &Meta::default()).unwrap();
        assert!(noted.height() > plain.height() + 20);
    }

    #[test]
    fn a_long_caption_shrinks_to_fit_a_narrow_picture() {
        let img = photo(400, 300);
        let b = Border { enabled: true, width: 2.0, caption: Caption { show: true, date: true, note: "A rather long note to go with the settings of this photo".into(), ..Caption::default() }, ..Border::default() };
        let out = add_border(&img, &b, &meta()).unwrap();
        // text in the strip reaches neither side edge: it was shrunk to fit inside 94 per cent of the width
        let strip_top = 8 + 300;
        let strip = image::imageops::crop_imm(&out, 0, strip_top, out.width(), out.height() - strip_top).to_image();
        let xs: Vec<u32> = strip.enumerate_pixels().filter(|(_, _, p)| p[0] < 128).map(|(x, _, _)| x).collect();
        assert!(!xs.is_empty());
        assert!(*xs.iter().min().unwrap() >= 2 && *xs.iter().max().unwrap() <= out.width() - 3, "inside the picture: {}..{} of {}", xs.iter().min().unwrap(), xs.iter().max().unwrap(), out.width());
    }

    // ---- the original file

    #[test]
    fn details_can_be_written_into_a_jpeg_and_a_png_as_copyright_only_or_everything_and_the_file_still_opens() {
        let sc = crate::xmp::Sidecar {
            rating: Some(5),
            flag: Some(1),
            label: Some("red".into()),
            title: Some("Sunrise".into()),
            creator: Some("Bennett".into()),
            copyright: Some("© 2026 Bennett".into()),
            city: Some("Paarl".into()),
            keywords: vec![vec!["Places".into(), "Lake".into()]],
            ours: true,
            ..Default::default()
        };
        let copyright = metadata_packet(&sc, "copyright").unwrap();
        let all = metadata_packet(&sc, "all").unwrap();
        let back = crate::xmp::parse(&copyright).unwrap();
        assert_eq!((back.creator.as_deref(), back.copyright.as_deref(), back.title, back.city, back.keywords.len()), (Some("Bennett"), Some("© 2026 Bennett"), None, None, 0));
        assert!(back.rating.is_none() && back.flag.is_none() && back.label.is_none(), "no rating, flag or label goes out");
        assert!(!copyright.contains("lucent:"), "{copyright}");
        let full = crate::xmp::parse(&all).unwrap();
        assert_eq!((full.title.as_deref(), full.city.as_deref(), full.keywords), (Some("Sunrise"), Some("Paarl"), vec![vec!["Places".to_string(), "Lake".to_string()]]));
        // nothing to say: no packet
        assert!(metadata_packet(&crate::xmp::Sidecar { rating: Some(3), ..Default::default() }, "all").is_none());

        let dir = tempfile::tempdir().unwrap();
        let img = image::RgbImage::from_fn(40, 30, |x, y| image::Rgb([(x * 6) as u8, (y * 8) as u8, 90]));
        for name in ["a.jpg", "a.png"] {
            let path = dir.path().join(name);
            img.save(&path).unwrap();
            if name == "a.jpg" {
                crate::dpi::set_dpi(&path, 300).unwrap(); // the JFIF header goes first
            }
            assert!(embed_xmp(&path, &all).unwrap());
            assert_eq!(image::image_dimensions(&path).unwrap(), (40, 30), "{name} still opens");
            let bytes = std::fs::read(&path).unwrap();
            assert!(bytes.windows(28).any(|w| w == &b"http://ns.adobe.com/xap/1.0/"[..28]) || name == "a.png");
            let text = String::from_utf8_lossy(&bytes);
            assert!(text.contains("<dc:creator>") && text.contains("Bennett"), "{name} carries the packet");
        }
        // the JPEG keeps its JFIF header first, and the packet is read back by the sidecar reader from the file
        let j = std::fs::read(dir.path().join("a.jpg")).unwrap();
        assert_eq!(&j[2..4], &[0xFF, 0xE0]);
        assert_eq!(&j[6..11], b"JFIF\0");
        let start = j.windows(5).position(|w| w == b"<?xpa").unwrap();
        let end = start + j[start..].windows(11).position(|w| w == b"<?xpacket e").unwrap() + 20;
        assert_eq!(crate::xmp::parse(&String::from_utf8_lossy(&j[start..end])).unwrap().creator.as_deref(), Some("Bennett"));
        // another kind of file is left alone
        let tiff = dir.path().join("a.tif");
        img.save(&tiff).unwrap();
        assert!(!embed_xmp(&tiff, &all).unwrap());
    }

    #[test]
    fn exporting_the_original_copies_the_file_and_its_sidecar_untouched_under_the_new_name() {
        let dir = tempfile::tempdir().unwrap();
        let src = source_photo(dir.path(), "IMG_9.jpg", 300, 200);
        let sc = crate::xmp::sidecar_path(&src, false);
        std::fs::write(&sc, "<x/>").unwrap();
        let out = tempfile::tempdir().unwrap();
        let s = ExportSettings { format: Format::Original, name_template: "shot_{seq}".into(), long_edge: 50, ..ExportSettings::default() };
        let p = export_photo(&src, out.path(), None, &s, 4).unwrap();
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "shot_004.jpg");
        assert_eq!(std::fs::read(&p).unwrap(), std::fs::read(&src).unwrap(), "byte for byte, whatever size was asked for");
        assert!(crate::xmp::sidecar_path(&p, false).is_file());
        // a second one with the same name gets a number added
        let again = export_photo(&src, out.path(), None, &s, 4).unwrap();
        assert_ne!(again, p);
    }

    // ---- file names

    #[test]
    fn name_templates_know_the_time_the_date_parts_the_lens_the_iso_and_a_sequence_of_any_width() {
        let meta = Meta { captured_local: Some("2026-10-19T14:05:09".into()), model: Some("Canon EOS R6".into()), lens: Some("RF 24-70mm".into()), iso: Some(400), ..Default::default() };
        let name = |t: &str, seq| expand_name(t, Path::new("D:/p/IMG_7.CR2"), &meta, seq);
        assert_eq!(name("{year}-{month}{day}_{time}_{name}", 3), "2026-1019_14-05-09_IMG_7");
        assert_eq!(name("{seq}", 7), "007");
        assert_eq!(name("{seq:5}", 7), "00007");
        assert_eq!(name("{seq:1}", 12), "12");
        assert_eq!(name("{lens} {iso} {camera}", 1), "RF 24-70mm ISO400 Canon EOS R6");
        let none = Meta::default();
        assert_eq!(expand_name("{date} {time} {year}", Path::new("a.jpg"), &none, 1), "undated untimed 0000");
    }

    // ---- sizing

    #[test]
    fn the_size_can_be_asked_for_by_a_box_a_percentage_or_megapixels() {
        let with = |size_mode, width, height, percent, megapixels| ExportSettings { size_mode, width, height, percent, megapixels, ..ExportSettings::default() };
        // 4000 x 3000
        assert_eq!(export_long_edge(&ExportSettings { long_edge: 1000, ..ExportSettings::default() }, 4000, 3000), 1000);
        assert_eq!(export_long_edge(&with(SizeMode::Dimensions, 2000, 2000, 50.0, 4.0), 4000, 3000), 2000, "fits a square box by its longer side");
        assert_eq!(export_long_edge(&with(SizeMode::Dimensions, 4000, 1500, 50.0, 4.0), 4000, 3000), 2000, "the height is what limits it: 1500 high is 2000 wide");
        assert_eq!(export_long_edge(&with(SizeMode::Dimensions, 0, 600, 50.0, 4.0), 4000, 3000), 800, "only a height given");
        assert_eq!(export_long_edge(&with(SizeMode::Dimensions, 0, 0, 50.0, 4.0), 4000, 3000), 0, "no box keeps the size");
        assert_eq!(export_long_edge(&with(SizeMode::Percent, 0, 0, 25.0, 4.0), 4000, 3000), 1000);
        assert_eq!(export_long_edge(&with(SizeMode::Megapixels, 0, 0, 50.0, 3.0), 4000, 3000), 2000, "3 megapixels in a 4:3 frame is 2000 x 1500");
        assert_eq!(export_long_edge(&with(SizeMode::Percent, 0, 0, 100000.0, 4.0).sanitized(), 4000, 3000), 20000, "held to 1000 per cent, and to 20000 pixels");
    }

    #[test]
    fn an_export_by_percentage_or_megapixels_has_that_size() {
        let dir = tempfile::tempdir().unwrap();
        let src = source_photo(dir.path(), "p.jpg", 1600, 900);
        let out = tempfile::tempdir().unwrap();
        let by = |s: ExportSettings| image::image_dimensions(export_photo(&src, out.path(), None, &ExportSettings { format: Format::Png, ..s }, 1).unwrap()).unwrap();
        assert_eq!(by(ExportSettings { size_mode: SizeMode::Percent, percent: 50.0, ..ExportSettings::default() }), (800, 450));
        assert_eq!(by(ExportSettings { size_mode: SizeMode::Dimensions, width: 400, height: 400, ..ExportSettings::default() }), (400, 225));
        let (w, h) = by(ExportSettings { size_mode: SizeMode::Megapixels, megapixels: 0.25, ..ExportSettings::default() });
        assert!((w as i64 * h as i64 - 250_000).abs() < 4000, "about a quarter of a megapixel: {w} x {h}");
    }

    // ---- sharpening

    #[test]
    fn output_sharpening_is_off_by_default_and_print_is_stronger_than_screen() {
        let edge = ImageBuffer::from_fn(400, 200, |x, _| if x < 200 { Rgb([60, 60, 60]) } else { Rgb([190, 190, 190]) });
        assert_eq!(sharpen_output(&edge, Sharpen::None), edge);
        let (screen, print) = (sharpen_output(&edge, Sharpen::Screen), sharpen_output(&edge, Sharpen::Print));
        let overshoot = |img: &RgbImage| (200..206).map(|x| img.get_pixel(x, 100)[0] as i32).max().unwrap() - 190;
        let undershoot = |img: &RgbImage| 60 - (194..200).map(|x| img.get_pixel(x, 100)[0] as i32).min().unwrap();
        assert!(overshoot(&screen) > 0 && undershoot(&screen) > 0, "the bright side of an edge is pushed brighter and the dark side darker");
        assert!(undershoot(&print) > undershoot(&screen));
        assert!(overshoot(&print) > overshoot(&screen), "print more than screen: {} vs {}", overshoot(&print), overshoot(&screen));
        assert_eq!(screen.get_pixel(20, 20), edge.get_pixel(20, 20), "flat areas stay as they were");
    }

    // ---- whole exports

    fn source_photo(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
        let p = dir.join(name);
        photo(w, h).save(&p).unwrap();
        p
    }

    #[test]
    fn every_format_writes_a_file_of_that_type_at_the_size_asked_for() {
        let dir = tempfile::tempdir().unwrap();
        let src = source_photo(dir.path(), "shot.jpg", 1600, 900);
        let out = tempfile::tempdir().unwrap();
        for (format, ext) in [(Format::Jpeg, "jpg"), (Format::Png, "png"), (Format::Tiff, "tif"), (Format::Webp, "webp")] {
            let s = ExportSettings { format, long_edge: 800, ..ExportSettings::default() };
            let path = export_photo(&src, out.path(), None, &s, 1).unwrap_or_else(|e| panic!("{format:?}: {e}"));
            assert_eq!(path.extension().unwrap(), ext);
            assert!(path.exists() && std::fs::metadata(&path).unwrap().len() > 500, "{format:?}");
            let back = ImageReader::open(&path).unwrap().with_guessed_format().unwrap().decode().unwrap_or_else(|e| panic!("{format:?} does not read back: {e}"));
            assert_eq!((back.width(), back.height()), (800, 450), "{format:?}");
        }
        // the full size when 0 is asked for
        let full = export_photo(&src, out.path(), None, &ExportSettings { format: Format::Png, long_edge: 0, ..ExportSettings::default() }, 2).unwrap();
        assert_eq!(image::image_dimensions(&full).unwrap(), (1600, 900));
    }

    #[test]
    fn a_small_picture_is_made_bigger_only_when_asked_and_never_smaller() {
        let dir = tempfile::tempdir().unwrap();
        let src = source_photo(dir.path(), "small.jpg", 200, 120);
        let out = tempfile::tempdir().unwrap();
        let size = |enlarge, long_edge| {
            let s = ExportSettings { format: Format::Png, long_edge, enlarge, ..ExportSettings::default() };
            image::image_dimensions(export_photo(&src, out.path(), None, &s, 1).unwrap()).unwrap()
        };
        assert_eq!(size(Enlarge::None, 600), (200, 120), "off: the picture keeps its size, as it always did");
        assert_eq!(size(Enlarge::Smooth, 600), (600, 360));
        assert_eq!(size(Enlarge::Smooth, 100), (100, 60), "asking for less is a shrink, whatever is chosen");
        assert_eq!(size(Enlarge::Smooth, 0), (200, 120), "0 keeps the size");
        let seen = std::sync::Mutex::new(0usize);
        let s = ExportSettings { format: Format::Png, long_edge: 400, enlarge: Enlarge::Ai, ..ExportSettings::default() };
        let p = export_photo_with(&src, out.path(), None, &s, 2, &|d, t| *seen.lock().unwrap() = d.max(t)).unwrap();
        assert_eq!(image::image_dimensions(&p).unwrap(), (400, 240), "the AI step reaches the size asked for");
        assert!(*seen.lock().unwrap() >= 1, "and reports its tiles");
        let again: ExportSettings = serde_json::from_str(r#"{"enlarge":"ai","longEdge":3000}"#).unwrap();
        assert_eq!((again.enlarge, again.long_edge), (Enlarge::Ai, 3000));
        assert_eq!(serde_json::from_str::<ExportSettings>("{}").unwrap().enlarge, Enlarge::None, "an older saved setting has no enlarge");
    }

    #[test]
    fn the_formats_say_which_colour_space_they_are_in() {
        let dir = tempfile::tempdir().unwrap();
        let src = source_photo(dir.path(), "shot.jpg", 400, 300);
        let out = tempfile::tempdir().unwrap();
        for format in [Format::Jpeg, Format::Png, Format::Tiff, Format::Webp] {
            let s = ExportSettings { format, long_edge: 0, colour_space: "displayP3".into(), ..ExportSettings::default() };
            match export_photo(&src, out.path(), None, &s, 1) {
                Ok(path) => {
                    let mut d = ImageReader::open(&path).unwrap().with_guessed_format().unwrap().into_decoder().unwrap();
                    let icc = d.icc_profile().unwrap_or(None);
                    eprintln!("{format:?}: wrote a file, profile read back: {}", icc.as_ref().map(|i| i.len()).unwrap_or(0));
                    assert!(icc.is_some(), "{format:?} wrote a Display P3 file without saying so");
                }
                Err(e) => eprintln!("{format:?}: refused a Display P3 export: {e}"),
            }
        }
    }

    #[test]
    fn the_name_template_the_border_and_the_watermark_all_reach_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let src = source_photo(dir.path(), "IMG_7.jpg", 1000, 600);
        let out = tempfile::tempdir().unwrap();
        let s = ExportSettings {
            long_edge: 0,
            name_template: "web_{name}_{seq}".into(),
            border: Border { enabled: true, width: 5.0, colour: [255, 255, 255], ..Border::default() },
            watermark: Watermark { kind: WatermarkKind::Text, text: "© Example".into(), anchor: Anchor::BottomRight, opacity: 100.0, ..Watermark::default() },
            ..ExportSettings::default()
        };
        let path = export_photo(&src, out.path(), None, &s, 3).unwrap();
        assert_eq!(path.file_name().unwrap(), "web_IMG_7_003.jpg");
        let back = image::open(&path).unwrap().to_rgb8();
        assert_eq!((back.width(), back.height()), (1100, 700), "the border is added after the size");
        assert_eq!(back.get_pixel(5, 5).0, [255, 255, 255]);
        // the watermark is on the photo, not on the border
        let on_photo = image::imageops::crop_imm(&back, 550, 350, 500, 300).to_image();
        let original = image::imageops::crop_imm(&photo(1000, 600), 500, 300, 500, 300).to_image();
        let differs = on_photo.pixels().zip(original.pixels()).filter(|(a, b)| (a[0] as i32 - b[0] as i32).abs() > 40).count();
        assert!(differs > 50, "the text is in the photo's lower right ({differs} pixels)");
        // exporting the same photo again does not overwrite it
        let again = export_photo(&src, out.path(), None, &s, 3).unwrap();
        assert_ne!(again, path);
    }

    #[test]
    fn a_watermark_that_cannot_be_drawn_stops_that_photo_instead_of_writing_it_bare() {
        let dir = tempfile::tempdir().unwrap();
        let src = source_photo(dir.path(), "a.jpg", 400, 300);
        let out = tempfile::tempdir().unwrap();
        let s = ExportSettings { watermark: Watermark { kind: WatermarkKind::Image, image_path: dir.path().join("none.png").to_string_lossy().into_owned(), ..Watermark::default() }, ..ExportSettings::default() };
        assert!(export_photo(&src, out.path(), None, &s, 1).is_err());
        assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0, "no half-made file is left behind");
    }

    #[test]
    fn the_preview_is_a_small_jpeg_with_the_border_and_the_watermark_in_it() {
        let dir = tempfile::tempdir().unwrap();
        let src = source_photo(dir.path(), "p.jpg", 1600, 1000);
        let proxy = photo(1600, 1000);
        let plain = preview(&proxy, &src, None, &ExportSettings::default(), 900).unwrap();
        let img = image::load_from_memory(&plain).unwrap();
        assert_eq!((img.width(), img.height()), (900, 563), "shrunk to the preview size, not the export size");
        let s = ExportSettings { border: Border { enabled: true, width: 5.0, ..Border::default() }, watermark: text_mark("© Me"), ..ExportSettings::default() };
        let framed = image::load_from_memory(&preview(&proxy, &src, None, &s, 900).unwrap()).unwrap();
        assert!(framed.width() > 900 && framed.height() > 563, "the border adds to it: {}x{}", framed.width(), framed.height());
        // the long edge asked for caps it when it is smaller than the preview
        let small = image::load_from_memory(&preview(&proxy, &src, None, &ExportSettings { long_edge: 400, ..ExportSettings::default() }, 900).unwrap()).unwrap();
        assert_eq!(small.width(), 400);
    }

    /// Export a real photo with a watermark, a border and a caption, to look at the result.
    /// PENUMBRA_EXPORT_SRC=<photo> PENUMBRA_EXPORT_OUT=<folder> cargo test try_export_look -- --ignored --nocapture
    #[test]
    #[ignore]
    fn try_export_look() {
        let src = PathBuf::from(std::env::var("PENUMBRA_EXPORT_SRC").expect("set PENUMBRA_EXPORT_SRC"));
        let out = PathBuf::from(std::env::var("PENUMBRA_EXPORT_OUT").expect("set PENUMBRA_EXPORT_OUT"));
        std::fs::create_dir_all(&out).unwrap();
        let s = ExportSettings {
            long_edge: 1400,
            sharpen: Sharpen::Screen,
            watermark: Watermark { kind: WatermarkKind::Text, text: "© Example Studio".into(), ..Watermark::default() },
            border: Border { enabled: true, width: 4.0, caption: Caption { show: true, date: true, note: "Sample portrait session".into(), ..Caption::default() }, ..Border::default() },
            ..ExportSettings::default()
        };
        let path = export_photo(&src, &out, None, &s, 1).unwrap();
        eprintln!("wrote {} ({:?}); caption lines: {:?}", path.display(), image::image_dimensions(&path).unwrap(), caption_lines(&media::read_meta(&src), &s.border.caption));
    }

    /// The same literal is in the page's tests (exportSettings.test.ts): the page and the core must agree on the starting settings.
    #[test]
    fn the_starting_settings_are_the_ones_the_page_starts_with() {
        let expected = serde_json::json!({
            "format": "jpeg", "quality": 85, "longEdge": 2048, "sizeMode": "longEdge", "width": 2048, "height": 2048, "percent": 50.0, "megapixels": 4.0, "dpi": 300, "colourSpace": "srgb", "nameTemplate": "{name}", "sharpen": "none", "enlarge": "none", "cameraInfo": true, "metadata": "none",
            "watermark": { "kind": "none", "text": "© Your name", "imagePath": "", "anchor": "bottomRight", "size": 3.0, "opacity": 70.0, "margin": 2.0, "colour": [255, 255, 255], "shadow": true },
            "border": { "enabled": false, "width": 4.0, "colour": [255, 255, 255],
                "caption": { "show": false, "camera": true, "lens": true, "focal": true, "aperture": true, "shutter": true, "iso": true, "date": false, "note": "", "layout": "grouped", "separator": "dot", "spacing": 2, "weight": "regular", "size": 1.6_f32 },
                "captionColour": null }
        });
        assert_eq!(serde_json::to_value(ExportSettings::default()).unwrap(), expected);
    }

    #[test]
    fn a_turned_photo_is_exported_turned_with_its_border_round_the_turned_picture() {
        use crate::geometry::Geometry;
        let dir = tempfile::tempdir().unwrap();
        let src = source_photo(dir.path(), "wide.jpg", 1000, 600);
        let out = tempfile::tempdir().unwrap();
        let recipe = Recipe { geometry: Geometry { quarter_turns: 1, ..Geometry::default() }, ..Recipe::default() };
        let s = ExportSettings { long_edge: 0, ..ExportSettings::default() };
        let path = export_photo(&src, out.path(), Some(&recipe), &s, 1).unwrap();
        assert_eq!(image::image_dimensions(&path).unwrap(), (600, 1000), "width and height swap");
        let framed = ExportSettings { border: Border { enabled: true, width: 5.0, ..Border::default() }, ..s };
        let path = export_photo(&src, out.path(), Some(&recipe), &framed, 2).unwrap();
        assert_eq!(image::image_dimensions(&path).unwrap(), (700, 1100), "5 per cent of the turned picture's long edge (1000) on each side");
        // the same photo mirrored keeps its size, and is the other way round
        let mirrored = Recipe { geometry: Geometry { mirror: true, ..Geometry::default() }, ..Recipe::default() };
        let path = export_photo(&src, out.path(), Some(&mirrored), &ExportSettings { long_edge: 0, format: Format::Png, ..ExportSettings::default() }, 3).unwrap();
        let (a, b) = (image::open(&path).unwrap().to_rgb8(), photo(1000, 600));
        assert_eq!(image::image_dimensions(&path).unwrap(), (1000, 600));
        assert!(a.get_pixel(0, 300)[0].abs_diff(b.get_pixel(999, 300)[0]) <= 2, "the left edge now shows what was on the right");
    }

    #[test]
    fn camera_details_go_into_a_jpeg_and_read_back_and_nothing_else_about_the_photo_does() {
        let meta = media::Meta { captured_local: Some("2026-05-07T18:42:09".into()), make: Some("Canon".into()), model: Some("EOS R6".into()), lens: Some("RF 24-70mm F2.8".into()), iso: Some(1600), aperture: Some(2.8), shutter_s: Some(1.0 / 250.0), focal_mm: Some(35.0), orientation: Some(6), ..Default::default() };
        let seg = camera_info_segment(&meta).unwrap();
        assert_eq!(&seg[..2], &[0xFF, 0xE1]);
        assert_eq!(u16::from_be_bytes([seg[2], seg[3]]) as usize, seg.len() - 2, "the length is right");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.jpg");
        let img = RgbImage::from_fn(64, 48, |x, y| image::Rgb([(x * 4) as u8, (y * 5) as u8, 90]));
        media::save_jpeg_tagged(&img, &path, 90, vec![]).unwrap();
        add_camera_info(&path, &seg).unwrap();
        let back = media::read_meta(&path);
        assert_eq!((back.make.as_deref(), back.model.as_deref(), back.lens.as_deref()), (Some("Canon"), Some("EOS R6"), Some("RF 24-70mm F2.8")));
        assert_eq!((back.iso, back.focal_mm, back.captured_local.as_deref()), (Some(1600), Some(35.0), Some("2026-05-07T18:42:09")));
        assert!((back.aperture.unwrap() - 2.8).abs() < 1e-6 && (back.shutter_s.unwrap() - 0.004).abs() < 1e-9, "{back:?}");
        assert_eq!(back.orientation, None, "the picture is already upright, so no turn is asked for");
        // the picture itself is untouched and still opens
        assert_eq!(image::open(&path).unwrap().to_rgb8().dimensions(), (64, 48));
        // no details at all, no block; text that is not plain letters cannot break it
        assert!(camera_info_segment(&media::Meta::default()).is_none());
        let odd = camera_info_segment(&media::Meta { make: Some("Cañon\u{7}".into()), ..Default::default() }).unwrap();
        assert!(odd.windows(5).any(|w| w == b"Ca?on"));
        // a long exposure is written as seconds
        let long = camera_info_segment(&media::Meta { shutter_s: Some(2.5), ..Default::default() }).unwrap();
        let p2 = dir.path().join("b.jpg");
        media::save_jpeg_tagged(&img, &p2, 90, vec![]).unwrap();
        add_camera_info(&p2, &long).unwrap();
        assert_eq!(media::read_meta(&p2).shutter_s, Some(2.5));
    }

    #[test]
    fn the_setting_is_on_by_default_and_an_old_saved_setting_without_it_gets_the_default() {
        assert!(ExportSettings::default().camera_info);
        let s: ExportSettings = serde_json::from_str(r#"{"quality":70}"#).unwrap();
        assert!(s.camera_info && s.quality == 70);
        assert!(serde_json::to_string(&ExportSettings::default()).unwrap().contains("\"cameraInfo\":true"));
    }
}
