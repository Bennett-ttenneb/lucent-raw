//! The Book module's engine: what a photo book is (pages of frames that hold a photo or some text), keeping it tidy, and turning
//! it into a PDF.
//!
//! A frame's place is a rectangle in fractions of its page, so a book means the same at any page size. The page layouts the
//! person picks from (one big photo, two side by side, a photo with a caption, ...) are made in the page; what is stored is
//! only the rectangles and what is in them.

use crate::pdf::{self, PageContent, Pdf};
use image::{imageops::FilterType, RgbImage};
use serde::{Deserialize, Serialize};

pub const MAX_PAGES: usize = 200;
pub const MAX_FRAMES: usize = 12;
const MAX_TEXT: usize = 2000;
/// Pictures are made for 300 pixels to the inch, but never more than this on the long side, so a book stays a sensible size.
const MAX_PIXELS: f32 = 3200.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FrameKind {
    #[default]
    Photo,
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    /// The picture fills the frame, and what does not fit is cropped (round the focus point).
    #[default]
    Fill,
    /// The whole picture is shown, with room round it.
    Fit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    #[default]
    Left,
    Centre,
    Right,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Frame {
    pub kind: FrameKind,
    /// Left, top, width and height, as fractions of the page.
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub photo_id: Option<i64>,
    pub fit: Fit,
    /// Which part of the picture stays when it is cropped: 0 to 1 across and down (0.5 is the middle).
    pub focus_x: f32,
    pub focus_y: f32,
    pub text: String,
    pub size_pt: f32,
    pub align: Align,
    pub bold: bool,
    /// #RRGGBB
    pub colour: String,
}

impl Default for Frame {
    fn default() -> Self {
        Frame { kind: FrameKind::Photo, x: 0.1, y: 0.1, w: 0.8, h: 0.8, photo_id: None, fit: Fit::Fill, focus_x: 0.5, focus_y: 0.5, text: String::new(), size_pt: 12.0, align: Align::Left, bold: false, colour: "#222222".into() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Page {
    /// #RRGGBB
    pub background: String,
    pub frames: Vec<Frame>,
}

impl Default for Page {
    fn default() -> Self {
        Page { background: "#FFFFFF".into(), frames: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Book {
    pub name: String,
    pub width_mm: f32,
    pub height_mm: f32,
    pub page_numbers: bool,
    pub pages: Vec<Page>,
}

impl Default for Book {
    fn default() -> Self {
        Book { name: "Untitled book".into(), width_mm: 203.2, height_mm: 203.2, page_numbers: false, pages: vec![Page::default()] }
    }
}

/// `#RRGGBB` as red, green and blue from 0 to 1, or nothing if it is not that.
pub fn parse_colour(s: &str) -> Option<[f32; 3]> {
    let h = s.strip_prefix('#')?;
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let v = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).unwrap() as f32 / 255.0;
    Some([v(0), v(2), v(4)])
}

fn colour_or(s: &str, d: &str) -> String {
    if parse_colour(s).is_some() { s.to_ascii_uppercase() } else { d.to_string() }
}

fn unit(v: f32, d: f32) -> f32 {
    if v.is_finite() { v.clamp(0.0, 1.0) } else { d }
}

impl Frame {
    fn sanitized(&self) -> Frame {
        let (x, y) = (unit(self.x, 0.1), unit(self.y, 0.1));
        let size = if self.size_pt.is_finite() { self.size_pt.clamp(6.0, 120.0) } else { 12.0 };
        Frame {
            kind: self.kind,
            x,
            y,
            // a frame stays on its page
            w: if self.w.is_finite() { self.w.clamp(0.02, 1.0 - x) } else { 0.5 },
            h: if self.h.is_finite() { self.h.clamp(0.02, 1.0 - y) } else { 0.5 },
            photo_id: self.photo_id.filter(|id| *id > 0),
            fit: self.fit,
            focus_x: unit(self.focus_x, 0.5),
            focus_y: unit(self.focus_y, 0.5),
            text: self.text.chars().filter(|c| !c.is_control() || *c == '\n').take(MAX_TEXT).collect(),
            size_pt: size,
            align: self.align,
            bold: self.bold,
            colour: colour_or(&self.colour, "#222222"),
        }
    }
}

impl Book {
    /// Every value in range, the name tidy, and no more pages or frames than there is room for.
    pub fn sanitized(&self) -> Book {
        let name: String = self.name.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(100).collect();
        let size = |v: f32, d: f32| if v.is_finite() { v.clamp(50.0, 1000.0) } else { d };
        Book {
            name: if name.is_empty() { "Untitled book".into() } else { name },
            width_mm: size(self.width_mm, 203.2),
            height_mm: size(self.height_mm, 203.2),
            page_numbers: self.page_numbers,
            pages: self.pages.iter().take(MAX_PAGES).map(|p| Page { background: colour_or(&p.background, "#FFFFFF"), frames: p.frames.iter().take(MAX_FRAMES).map(Frame::sanitized).collect() }).collect(),
        }
    }
}

/// Where a picture of `iw` x `ih` pixels goes in a frame of `fw` x `fh`: the part of the picture that is used (left, top, width,
/// height in pixels) and where it is drawn (left, top, width, height inside the frame).
pub fn place(iw: f32, ih: f32, fw: f32, fh: f32, fit: Fit, focus: (f32, f32)) -> ([f32; 4], [f32; 4]) {
    match fit {
        Fit::Fill => {
            let want = fw / fh;
            let (cw, ch) = if iw / ih > want { (ih * want, ih) } else { (iw, iw / want) };
            ([(iw - cw) * focus.0, (ih - ch) * focus.1, cw, ch], [0.0, 0.0, fw, fh])
        }
        Fit::Fit => {
            let k = (fw / iw).min(fh / ih);
            let (dw, dh) = (iw * k, ih * k);
            ([0.0, 0.0, iw, ih], [(fw - dw) / 2.0, (fh - dh) / 2.0, dw, dh])
        }
    }
}

/// What a PDF export tells the person.
#[derive(Debug, Serialize)]
pub struct PdfResult {
    pub pages: usize,
    /// Photos that could not be put in, in words (a photo that is no longer in the catalog, or whose file is gone).
    pub warnings: Vec<String>,
}

/// Make the book a PDF. `load(photo_id, longest_side)` gives the photo as it is edited, about `longest_side` pixels long.
pub fn render_pdf(book: &Book, load: &dyn Fn(i64, u32) -> Result<RgbImage, String>, progress: &dyn Fn(usize, usize)) -> Result<(Vec<u8>, PdfResult), String> {
    let book = book.sanitized();
    let (pw, ph) = (pdf::mm_to_pt(book.width_mm), pdf::mm_to_pt(book.height_mm));
    let mut out = Pdf::new(&book.name);
    let mut warnings = Vec::new();
    let mut count = 0usize;
    for (n, page) in book.pages.iter().enumerate() {
        progress(n, book.pages.len());
        let mut c = PageContent::new(pw, ph);
        c.fill_rect(0.0, 0.0, pw, ph, parse_colour(&page.background).unwrap_or([1.0; 3]));
        for f in &page.frames {
            let (fx, fy, fw, fh) = (f.x * pw, f.y * ph, f.w * pw, f.h * ph);
            match f.kind {
                FrameKind::Photo => {
                    let Some(id) = f.photo_id else { continue };
                    let pixels = ((fw.max(fh) / 72.0) * 300.0).min(MAX_PIXELS).max(64.0) as u32;
                    let img = match load(id, pixels) {
                        Ok(i) => i,
                        Err(e) => {
                            warnings.push(format!("Page {}: a photo could not be used ({e})", n + 1));
                            c.fill_rect(fx, fy, fw, fh, [0.9, 0.9, 0.9]);
                            continue;
                        }
                    };
                    let (src, dst) = place(img.width() as f32, img.height() as f32, fw, fh, f.fit, (f.focus_x, f.focus_y));
                    let part = image::imageops::crop_imm(&img, src[0].round() as u32, src[1].round() as u32, (src[2].round() as u32).clamp(1, img.width()), (src[3].round() as u32).clamp(1, img.height())).to_image();
                    let jpeg = jpeg_of(&part)?;
                    let obj = out.add_jpeg(&jpeg, part.width(), part.height());
                    c.image(obj, fx + dst[0], fy + dst[1], dst[2], dst[3]);
                }
                FrameKind::Text => {
                    if f.text.trim().is_empty() {
                        continue;
                    }
                    let rgb = parse_colour(&f.colour).unwrap_or([0.13; 3]);
                    // the text is made smaller until it fits the frame
                    let mut size = f.size_pt;
                    let lines = loop {
                        let lines = pdf::wrap(&f.text, fw, size, f.bold);
                        if lines.len() as f32 * size * 1.25 <= fh || size <= 6.0 {
                            break lines;
                        }
                        size = (size - 0.5).max(6.0);
                    };
                    for (i, line) in lines.iter().enumerate() {
                        let w = pdf::text_width(line, size, f.bold);
                        let x = match f.align {
                            Align::Left => fx,
                            Align::Centre => fx + (fw - w) / 2.0,
                            Align::Right => fx + fw - w,
                        };
                        let y = fy + size * 1.0 + i as f32 * size * 1.25;
                        if y - size > fy + fh {
                            break;
                        }
                        c.text_line(line, x, y, size, f.bold, rgb);
                    }
                }
            }
        }
        if book.page_numbers {
            let label = (n + 1).to_string();
            let w = pdf::text_width(&label, 8.0, false);
            c.text_line(&label, (pw - w) / 2.0, ph - pdf::mm_to_pt(6.0), 8.0, false, [0.4, 0.4, 0.4]);
        }
        out.add_page(c);
        count += 1;
    }
    progress(count, book.pages.len());
    Ok((out.finish(), PdfResult { pages: count, warnings }))
}

fn jpeg_of(img: &RgbImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 90).encode_image(img).map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// The photo shrunk to about `edge` pixels on its long side (never enlarged).
pub fn shrink(img: RgbImage, edge: u32) -> RgbImage {
    let long = img.width().max(img.height());
    if long <= edge {
        return img;
    }
    let k = edge as f32 / long as f32;
    image::imageops::resize(&img, ((img.width() as f32 * k).round() as u32).max(1), ((img.height() as f32 * k).round() as u32).max(1), FilterType::Lanczos3)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    fn photo(w: u32, h: u32) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| Rgb([(x * 255 / w.max(1)) as u8, (y * 255 / h.max(1)) as u8, 90]))
    }
    fn frame(x: f32, y: f32, w: f32, h: f32, id: Option<i64>) -> Frame {
        Frame { x, y, w, h, photo_id: id, ..Default::default() }
    }

    #[test]
    fn colours_are_six_hex_digits_and_nothing_else() {
        assert_eq!(parse_colour("#FF0000"), Some([1.0, 0.0, 0.0]));
        assert_eq!(parse_colour("#080d12").map(|c| (c[0] * 255.0).round() as u8), Some(8));
        for bad in ["", "FF0000", "#FFF", "#GG0000", "#FF00000", "red", "#ff 000"] {
            assert_eq!(parse_colour(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_book_is_tidied_numbers_in_range_frames_on_the_page_text_clean_and_nothing_over_the_limits() {
        let wild = Book {
            name: "  A   very\tnice\n book ".into(),
            width_mm: f32::NAN,
            height_mm: 99999.0,
            page_numbers: true,
            pages: vec![Page { background: "red".into(), frames: vec![Frame { x: 0.9, y: -3.0, w: 5.0, h: f32::INFINITY, photo_id: Some(-4), focus_x: 9.0, focus_y: f32::NAN, size_pt: 1.0, colour: "nope".into(), text: "a\u{7}b\nc".into(), ..Default::default() }] }],
        }
        .sanitized();
        assert_eq!(wild.name, "A very nice book");
        assert_eq!((wild.width_mm, wild.height_mm), (203.2, 1000.0));
        let f = &wild.pages[0].frames[0];
        assert_eq!((f.x, f.y), (0.9, 0.0));
        assert!(f.x + f.w <= 1.0 + 1e-6 && f.y + f.h <= 1.0 + 1e-6, "{f:?}");
        assert_eq!((f.photo_id, f.focus_x, f.focus_y, f.size_pt), (None, 1.0, 0.5, 6.0));
        assert_eq!((f.colour.as_str(), f.text.as_str()), ("#222222", "ab\nc"));
        assert_eq!(wild.pages[0].background, "#FFFFFF");
        let many = Book { pages: vec![Page { frames: vec![Frame::default(); 40], ..Default::default() }; 250], ..Default::default() }.sanitized();
        assert_eq!((many.pages.len(), many.pages[0].frames.len()), (MAX_PAGES, MAX_FRAMES));
        assert_eq!(Book { name: "   ".into(), ..Default::default() }.sanitized().name, "Untitled book");
        let long = Frame { text: "x".repeat(5000), ..Default::default() }.sanitized();
        assert_eq!(long.text.len(), MAX_TEXT);
    }

    #[test]
    fn a_book_survives_json_and_an_older_or_short_one_is_filled_in() {
        let book = Book { name: "Trip".into(), pages: vec![Page { background: "#080D12".into(), frames: vec![frame(0.1, 0.1, 0.5, 0.5, Some(7))] }], ..Default::default() };
        let json = serde_json::to_string(&book).unwrap();
        assert!(json.contains("\"widthMm\"") && json.contains("\"photoId\":7") && json.contains("\"kind\":\"photo\"") && json.contains("\"fit\":\"fill\""), "{json}");
        assert_eq!(serde_json::from_str::<Book>(&json).unwrap(), book);
        let short: Book = serde_json::from_str(r#"{"name":"x"}"#).unwrap();
        assert_eq!((short.pages.len(), short.width_mm), (1, 203.2));
        let f: Frame = serde_json::from_str(r#"{"kind":"text","text":"hi","align":"centre"}"#).unwrap();
        assert_eq!((f.kind, f.align, f.size_pt), (FrameKind::Text, Align::Centre, 12.0));
        assert!(serde_json::from_str::<Frame>(r#"{"kind":"video"}"#).is_err());
    }

    #[test]
    fn fill_crops_round_the_focus_and_fit_shows_the_whole_picture_with_room() {
        // a wide picture (400 x 200) in a square frame: the crop is 200 x 200
        let (src, dst) = place(400.0, 200.0, 100.0, 100.0, Fit::Fill, (0.5, 0.5));
        assert_eq!(src, [100.0, 0.0, 200.0, 200.0]);
        assert_eq!(dst, [0.0, 0.0, 100.0, 100.0]);
        assert_eq!(place(400.0, 200.0, 100.0, 100.0, Fit::Fill, (0.0, 0.5)).0[0], 0.0, "the left edge stays");
        assert_eq!(place(400.0, 200.0, 100.0, 100.0, Fit::Fill, (1.0, 0.5)).0[0], 200.0, "the right edge stays");
        // a tall picture in a wide frame crops top and bottom
        let (src, _) = place(200.0, 400.0, 200.0, 100.0, Fit::Fill, (0.5, 0.0));
        assert_eq!(src, [0.0, 0.0, 200.0, 100.0]);
        // the frame's own shape is what is kept, for any picture
        for (iw, ih, fw, fh) in [(300.0, 200.0, 50.0, 80.0), (100.0, 300.0, 210.0, 297.0), (50.0, 50.0, 10.0, 90.0)] {
            let (s, _) = place(iw, ih, fw, fh, Fit::Fill, (0.3, 0.7));
            assert!((s[2] / s[3] - fw / fh).abs() < 1e-3 && s[0] >= -1e-3 && s[1] >= -1e-3 && s[0] + s[2] <= iw + 1e-3 && s[1] + s[3] <= ih + 1e-3);
        }
        // fit: the whole picture, centred, with room on two sides
        let (src, dst) = place(400.0, 200.0, 100.0, 100.0, Fit::Fit, (0.5, 0.5));
        assert_eq!(src, [0.0, 0.0, 400.0, 200.0]);
        assert_eq!(dst, [0.0, 25.0, 100.0, 50.0]);
    }

    /// The pdf as plain text (the pictures are JPEG bytes, so this is only for looking for words and structure).
    fn text_of(pdf: &[u8]) -> String {
        pdf.iter().map(|b| if b.is_ascii() { *b as char } else { '.' }).collect()
    }

    #[test]
    fn a_book_becomes_a_pdf_with_a_page_for_each_page_the_right_size_and_a_picture_for_each_photo() {
        let book = Book {
            name: "My trip".into(),
            width_mm: 210.0,
            height_mm: 297.0,
            page_numbers: true,
            pages: vec![
                Page { background: "#080D12".into(), frames: vec![frame(0.05, 0.05, 0.9, 0.6, Some(1)), Frame { kind: FrameKind::Text, x: 0.05, y: 0.7, w: 0.9, h: 0.2, text: "Sunrise at the lake".into(), size_pt: 18.0, ..Default::default() }] },
                Page { frames: vec![frame(0.1, 0.1, 0.4, 0.4, Some(2)), frame(0.5, 0.5, 0.4, 0.4, Some(3)), frame(0.0, 0.0, 0.1, 0.1, None)], ..Default::default() },
            ],
        };
        let asked = std::sync::Mutex::new(Vec::new());
        let load = |id: i64, edge: u32| -> Result<RgbImage, String> {
            asked.lock().unwrap().push((id, edge));
            Ok(photo(900, 600))
        };
        let (bytes, r) = render_pdf(&book, &load, &|_, _| {}).unwrap();
        assert_eq!((r.pages, r.warnings.len()), (2, 0));
        let t = text_of(&bytes);
        assert!(t.starts_with("%PDF-1.4"));
        assert!(t.contains("/Count 2") && t.contains("/MediaBox [0 0 595.276 841.89]"), "{}", t.lines().find(|l| l.contains("MediaBox")).unwrap_or(""));
        assert_eq!(t.matches("/Subtype /Image").count(), 3, "three photos, and the empty frame prints nothing");
        assert!(t.contains("/BaseFont /Helvetica-Bold") && t.contains("5375 6E72 697365") || t.contains("53756E72697365"), "the caption is in the page");
        assert!(t.contains("0.031 0.051 0.071 rg"), "the first page is Obsidian");
        // the pictures were asked for at a size that suits the frame: 0.9 of an A4 page is about 7.4 inches, so about 2200 pixels
        let first = asked.lock().unwrap()[0];
        assert_eq!(first.0, 1);
        assert!((2100..2300).contains(&first.1), "{first:?}");
        // page numbers are on both pages
        assert_eq!(t.matches("<31> Tj").count() + t.matches("<32> Tj").count(), 2);
    }

    #[test]
    fn a_photo_that_cannot_be_loaded_is_a_grey_box_and_a_warning_not_a_failed_book() {
        let book = Book { pages: vec![Page { frames: vec![frame(0.1, 0.1, 0.8, 0.8, Some(5)), frame(0.1, 0.1, 0.1, 0.1, Some(6))], ..Default::default() }], ..Default::default() };
        let load = |id: i64, _: u32| if id == 5 { Err("it is not in the catalog".to_string()) } else { Ok(photo(100, 100)) };
        let (bytes, r) = render_pdf(&book, &load, &|_, _| {}).unwrap();
        assert_eq!(r.warnings.len(), 1);
        assert!(r.warnings[0].contains("Page 1") && r.warnings[0].contains("not in the catalog"));
        assert_eq!(text_of(&bytes).matches("/Subtype /Image").count(), 1);
        assert_eq!(render_pdf(&Book { pages: vec![], ..Default::default() }, &load, &|_, _| {}).unwrap().1.pages, 0);
    }

    #[test]
    fn text_is_made_smaller_to_fit_its_frame_and_aligned_as_asked() {
        let long = "A caption that is rather long and goes on and on about the day we spent at the lake with the family. ".repeat(6);
        let book = Book { width_mm: 100.0, height_mm: 100.0, pages: vec![Page { frames: vec![Frame { kind: FrameKind::Text, x: 0.1, y: 0.1, w: 0.8, h: 0.15, text: long, size_pt: 40.0, ..Default::default() }, Frame { kind: FrameKind::Text, x: 0.1, y: 0.5, w: 0.8, h: 0.2, text: "Centred".into(), size_pt: 12.0, align: Align::Centre, ..Default::default() }], ..Default::default() }], ..Default::default() };
        let (bytes, _) = render_pdf(&book, &|_, _| Ok(photo(10, 10)), &|_, _| {}).unwrap();
        let t = text_of(&bytes);
        // the long text was set at a size that fits: find the size in the first Tf and check it is far below 40
        let size: f32 = t.split("/F1 ").nth(1).unwrap().split(" Tf").next().unwrap().parse().unwrap();
        assert!(size < 20.0 && size >= 6.0, "{size}");
        // centred text starts to the right of the frame's left edge (28.35 points)
        let centred = t.rsplit("/F1 12 Tf ").next().unwrap();
        let x: f32 = centred.split(' ').next().unwrap().parse().unwrap();
        assert!(x > 28.35 + 20.0, "{x}");
    }

    #[test]
    fn shrinking_never_enlarges() {
        assert_eq!(shrink(photo(100, 50), 400).dimensions(), (100, 50));
        assert_eq!(shrink(photo(1000, 500), 200).dimensions(), (200, 100));
    }

    /// Writes a real sample book when PENUMBRA_BOOK_SAMPLE names a file, so the PDF can be opened in a real PDF reader.
    #[test]
    fn sample_book_for_a_real_pdf_reader() {
        let Some(path) = std::env::var_os("PENUMBRA_BOOK_SAMPLE") else { return };
        let book = Book {
            name: "Sample trip".into(),
            width_mm: 210.0,
            height_mm: 297.0,
            page_numbers: true,
            pages: vec![
                Page { background: "#080D12".into(), frames: vec![frame(0.0, 0.0, 1.0, 0.75, Some(1)), Frame { kind: FrameKind::Text, x: 0.08, y: 0.8, w: 0.84, h: 0.12, text: "Sunrise at the lake (Cafe: 100% \\ ok)".into(), size_pt: 26.0, align: Align::Centre, colour: "#F5F6FC".into(), bold: true, ..Default::default() }] },
                Page { frames: vec![frame(0.06, 0.06, 0.88, 0.4, Some(2)), Frame { fit: Fit::Fit, ..frame(0.06, 0.5, 0.42, 0.4, Some(3)) }, frame(0.52, 0.5, 0.42, 0.4, Some(4))], ..Default::default() },
            ],
        };
        let load = |id: i64, _: u32| Ok(photo(1200 + id as u32 * 100, 800));
        let (bytes, _) = render_pdf(&book, &load, &|_, _| {}).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
        hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
    }
    fn number_after(hay: &[u8], key: &[u8], from: usize) -> usize {
        let at = find(hay, key, from).unwrap() + key.len();
        String::from_utf8_lossy(&hay[at..at + 12]).split(|c: char| !c.is_ascii_digit()).next().unwrap().parse().unwrap()
    }

    #[test]
    fn every_picture_in_the_pdf_is_a_whole_jpeg_of_the_size_it_says_and_the_cross_reference_table_points_at_every_object() {
        let book = Book {
            width_mm: 200.0,
            height_mm: 100.0,
            pages: vec![
                Page { frames: vec![frame(0.0, 0.0, 0.5, 1.0, Some(1)), Frame { fit: Fit::Fit, ..frame(0.5, 0.0, 0.5, 1.0, Some(2)) }], ..Default::default() },
                Page { frames: vec![Frame { focus_x: 0.0, ..frame(0.1, 0.1, 0.3, 0.8, Some(3)) }], ..Default::default() },
            ],
            ..Default::default()
        };
        let (bytes, _) = render_pdf(&book, &|id, _| Ok(photo(300 + id as u32 * 37, 200 + id as u32 * 11)), &|_, _| {}).unwrap();
        let mut at = 0;
        let mut n = 0;
        while let Some(p) = find(&bytes, b"/Subtype /Image", at) {
            let (w, h, len) = (number_after(&bytes, b"/Width ", p), number_after(&bytes, b"/Height ", p), number_after(&bytes, b"/Length ", p));
            let start = find(&bytes, b"stream\n", p).unwrap() + 7;
            let img = image::load_from_memory_with_format(&bytes[start..start + len], image::ImageFormat::Jpeg).expect("the picture decodes");
            assert_eq!((img.width() as usize, img.height() as usize), (w, h), "the size it says is the size it is");
            assert_eq!(&bytes[start + len..start + len + 10], b"\nendstream", "the length is exactly the picture");
            n += 1;
            at = start + len;
        }
        assert_eq!(n, 3);
        // the cross-reference table: the last startxref names the table, and every entry lands on "<n> 0 obj"
        let sx = find(&bytes, b"startxref\n", bytes.len() - 40).unwrap();
        let table = number_after(&bytes, b"startxref\n", sx - 1);
        assert_eq!(&bytes[table..table + 4], b"xref");
        let count = number_after(&bytes, b"xref\n0 ", table);
        let first = find(&bytes, b"\n", find(&bytes, b"xref\n0 ", table).unwrap() + 7).unwrap() + 1;
        for i in 1..count {
            let entry = &bytes[first + i * 20..first + i * 20 + 20];
            let off: usize = String::from_utf8_lossy(&entry[..10]).parse().unwrap();
            assert!(bytes[off..].starts_with(format!("{i} 0 obj").as_bytes()), "object {i} is where the table says");
        }
    }

    #[test]
    fn progress_is_told_page_by_page_and_ends_with_all_of_them() {
        let book = Book { pages: vec![Page::default(), Page::default(), Page::default()], ..Default::default() };
        let seen = std::sync::Mutex::new(Vec::new());
        render_pdf(&book, &|_, _| Ok(photo(10, 10)), &|d, t| seen.lock().unwrap().push((d, t))).unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![(0, 3), (1, 3), (2, 3), (3, 3)]);
    }
}
