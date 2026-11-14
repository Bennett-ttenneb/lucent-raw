//! A small PDF writer, just enough for photo books: pages of any size, filled rectangles, JPEG pictures and lines of text in
//! the standard Helvetica fonts (which every PDF reader has, so no font is stored in the file).
//!
//! Coordinates in this file are in points (1/72 inch) from the TOP LEFT of the page, as the page layout thinks of them; the
//! writer turns them into PDF's bottom-left ones.

use std::fmt::Write as _;

pub const MM_PER_POINT: f32 = 25.4 / 72.0;

pub fn mm_to_pt(mm: f32) -> f32 {
    mm / MM_PER_POINT
}

/// Helvetica's glyph widths (thousandths of the type size) for the characters of the Windows Latin-1 set. Accented letters
/// are as wide as their plain letter.
fn base_width(c: char) -> u32 {
    match c {
        ' ' | '!' | ',' | '.' | '/' | ':' | ';' | '[' | '\\' | ']' | 'I' | 'f' | 't' => 278,
        '"' => 355,
        '#' | '$' | '0'..='9' | '?' | '_' | 'L' | 'a' | 'b' | 'd' | 'e' | 'g' | 'h' | 'n' | 'o' | 'p' | 'q' | 'u' => 556,
        '%' => 889,
        '&' | 'A' | 'B' | 'E' | 'K' | 'P' | 'S' | 'V' | 'X' | 'Y' => 667,
        '\'' => 191,
        '(' | ')' | '-' | 'r' | '`' => 333,
        '*' => 389,
        '+' | '<' | '=' | '>' | '~' => 584,
        '^' => 469,
        '@' => 1015,
        'C' | 'D' | 'H' | 'N' | 'R' | 'U' | 'w' => 722,
        'G' | 'O' | 'Q' => 778,
        'J' | 'c' | 'k' | 's' | 'v' | 'x' | 'y' | 'z' => 500,
        'M' => 833,
        'F' | 'T' | 'Z' => 611,
        'W' => 944,
        'i' | 'j' | 'l' => 222,
        'm' => 833,
        '{' | '}' => 334,
        '|' => 260,
        '\u{2026}' | '\u{2014}' | '\u{2122}' => 1000,
        '\u{2022}' => 350,
        '\u{2018}' | '\u{2019}' => 222,
        '\u{201C}' | '\u{201D}' => 333,
        c if c.is_ascii() => 556,
        _ => 556,
    }
}

/// The width of `c` in points at `size` points; bold type is a little wider.
pub fn char_width(c: char, size: f32, bold: bool) -> f32 {
    let w = base_width(c) as f32 * size / 1000.0;
    if bold { w * 1.07 } else { w }
}

pub fn text_width(s: &str, size: f32, bold: bool) -> f32 {
    s.chars().map(|c| char_width(c, size, bold)).sum()
}

/// The byte a character has in Windows Latin-1 (what the fonts are asked to use), or a question mark.
pub fn win_ansi(c: char) -> u8 {
    match c {
        ' '..='~' => c as u8,
        '\u{A0}'..='\u{FF}' => c as u32 as u8,
        '\u{20AC}' => 0x80,
        '\u{201A}' => 0x82,
        '\u{0192}' => 0x83,
        '\u{201E}' => 0x84,
        '\u{2026}' => 0x85,
        '\u{2020}' => 0x86,
        '\u{2021}' => 0x87,
        '\u{02C6}' => 0x88,
        '\u{2030}' => 0x89,
        '\u{0160}' => 0x8A,
        '\u{2039}' => 0x8B,
        '\u{0152}' => 0x8C,
        '\u{017D}' => 0x8E,
        '\u{2018}' => 0x91,
        '\u{2019}' => 0x92,
        '\u{201C}' => 0x93,
        '\u{201D}' => 0x94,
        '\u{2022}' => 0x95,
        '\u{2013}' => 0x96,
        '\u{2014}' => 0x97,
        '\u{02DC}' => 0x98,
        '\u{2122}' => 0x99,
        '\u{0161}' => 0x9A,
        '\u{203A}' => 0x9B,
        '\u{0153}' => 0x9C,
        '\u{017E}' => 0x9E,
        '\u{0178}' => 0x9F,
        _ => b'?',
    }
}

/// `text` broken into lines no wider than `width` points (a long word is broken where it must be); a newline starts a new line.
pub fn wrap(text: &str, width: f32, size: f32, bold: bool) -> Vec<String> {
    let mut lines = Vec::new();
    for para in text.split('\n') {
        let mut line = String::new();
        for word in para.split_whitespace() {
            let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
            if text_width(&candidate, size, bold) <= width {
                line = candidate;
                continue;
            }
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
            }
            // a word that is wider than the line is broken
            let mut piece = String::new();
            for ch in word.chars() {
                if text_width(&format!("{piece}{ch}"), size, bold) > width && !piece.is_empty() {
                    lines.push(std::mem::take(&mut piece));
                }
                piece.push(ch);
            }
            line = piece;
        }
        lines.push(line);
    }
    lines
}

fn num(v: f32) -> String {
    let s = format!("{v:.3}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// What goes on one page.
pub struct PageContent {
    width: f32,
    height: f32,
    ops: String,
    images: Vec<(String, usize)>,
}

impl PageContent {
    pub fn new(width: f32, height: f32) -> PageContent {
        PageContent { width, height, ops: String::new(), images: Vec::new() }
    }

    pub fn fill_rect(&mut self, x: f32, y: f32, w: f32, h: f32, rgb: [f32; 3]) {
        let _ = writeln!(self.ops, "q {} {} {} rg {} {} {} {} re f Q", num(rgb[0]), num(rgb[1]), num(rgb[2]), num(x), num(self.height - y - h), num(w), num(h));
    }

    /// Put a picture (an object from Pdf::add_jpeg) in the rectangle.
    pub fn image(&mut self, object: usize, x: f32, y: f32, w: f32, h: f32) {
        let name = format!("Im{}", self.images.len() + 1);
        let _ = writeln!(self.ops, "q {} 0 0 {} {} {} cm /{name} Do Q", num(w), num(h), num(x), num(self.height - y - h));
        self.images.push((name, object));
    }

    /// One line of text whose baseline is at `y` (from the top).
    pub fn text_line(&mut self, text: &str, x: f32, y: f32, size: f32, bold: bool, rgb: [f32; 3]) {
        // hexadecimal, so no byte needs an escape
        let hex: String = text.chars().map(|c| format!("{:02X}", win_ansi(c))).collect();
        let font = if bold { "F2" } else { "F1" };
        let _ = writeln!(self.ops, "q {} {} {} rg BT /{font} {} Tf {} {} Td <{hex}> Tj ET Q", num(rgb[0]), num(rgb[1]), num(rgb[2]), num(size), num(x), num(self.height - y));
    }

    pub fn size(&self) -> (f32, f32) {
        (self.width, self.height)
    }
}

pub struct Pdf {
    objects: Vec<Vec<u8>>,
    pages: Vec<usize>,
    title: String,
}

const CATALOG: usize = 1;
const PAGES: usize = 2;

impl Pdf {
    pub fn new(title: &str) -> Pdf {
        let mut p = Pdf { objects: Vec::new(), pages: Vec::new(), title: title.to_string() };
        p.objects.push(Vec::new()); // 1: the catalog, written at the end
        p.objects.push(Vec::new()); // 2: the list of pages, written at the end
        p.add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_vec()); // 3
        p.add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>".to_vec()); // 4
        p
    }

    /// Add an object and give back its number.
    pub fn add_object(&mut self, body: Vec<u8>) -> usize {
        self.objects.push(body);
        self.objects.len()
    }

    /// A JPEG picture (as the file holds it) of `w` x `h` pixels.
    pub fn add_jpeg(&mut self, jpeg: &[u8], w: u32, h: u32) -> usize {
        let mut body = format!("<< /Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n", jpeg.len()).into_bytes();
        body.extend_from_slice(jpeg);
        body.extend_from_slice(b"\nendstream");
        self.add_object(body)
    }

    pub fn add_page(&mut self, page: PageContent) {
        let mut stream = format!("<< /Length {} >>\nstream\n", page.ops.len()).into_bytes();
        stream.extend_from_slice(page.ops.as_bytes());
        stream.extend_from_slice(b"endstream");
        let content = self.add_object(stream);
        let xobjects: String = page.images.iter().map(|(n, o)| format!("/{n} {o} 0 R ")).collect();
        let body = format!(
            "<< /Type /Page /Parent {PAGES} 0 R /MediaBox [0 0 {} {}] /Contents {content} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << {xobjects}>> >> >>",
            num(page.width),
            num(page.height)
        );
        let id = self.add_object(body.into_bytes());
        self.pages.push(id);
    }

    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    pub fn finish(mut self) -> Vec<u8> {
        let kids: String = self.pages.iter().map(|p| format!("{p} 0 R ")).collect();
        self.objects[PAGES - 1] = format!("<< /Type /Pages /Kids [{kids}] /Count {} >>", self.pages.len()).into_bytes();
        self.objects[CATALOG - 1] = format!("<< /Type /Catalog /Pages {PAGES} 0 R >>").into_bytes();
        let title_hex: String = self.title.chars().map(|c| format!("{:02X}", win_ansi(c))).collect();
        let info = self.add_object(format!("<< /Title <{title_hex}> /Producer (Lucent Raw) /Creator (Lucent Raw) >>").into_bytes());
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in self.objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", self.objects.len() + 1).as_bytes());
        for o in &offsets {
            out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(format!("trailer\n<< /Size {} /Root {CATALOG} 0 R /Info {info} 0 R >>\nstartxref\n{xref}\n%%EOF\n", self.objects.len() + 1).as_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_widths_follow_helvetica_and_wrapping_never_goes_over_the_width() {
        assert_eq!(text_width("", 10.0, false), 0.0);
        assert!((text_width("Hello", 10.0, false) - (722.0 + 556.0 + 222.0 + 222.0 + 556.0) / 100.0).abs() < 1e-3);
        assert!(text_width("Hello", 10.0, true) > text_width("Hello", 10.0, false));
        assert_eq!(char_width('\u{E9}', 10.0, false), char_width('e', 10.0, false) + 0.0, "an accented letter is as wide as its plain one");
        let lines = wrap("The quick brown fox jumps over the lazy dog", 90.0, 12.0, false);
        assert!(lines.len() > 1);
        for l in &lines {
            assert!(text_width(l, 12.0, false) <= 90.0 + 0.01, "{l:?}");
        }
        assert_eq!(lines.join(" "), "The quick brown fox jumps over the lazy dog");
        // a long word is broken, a newline is kept, and empty text is one empty line
        let long = wrap("Supercalifragilisticexpialidocious", 60.0, 12.0, false);
        assert!(long.len() > 1 && long.iter().all(|l| text_width(l, 12.0, false) <= 60.01));
        assert_eq!(long.concat(), "Supercalifragilisticexpialidocious");
        assert_eq!(wrap("a\nb", 100.0, 10.0, false), ["a", "b"]);
        assert_eq!(wrap("", 100.0, 10.0, false), [""]);
    }

    #[test]
    fn characters_become_the_bytes_the_fonts_expect() {
        assert_eq!(win_ansi('A'), b'A');
        assert_eq!(win_ansi('\u{E9}'), 0xE9);
        assert_eq!(win_ansi('\u{2019}'), 0x92, "a curly apostrophe");
        assert_eq!(win_ansi('\u{20AC}'), 0x80);
        assert_eq!(win_ansi('\u{4E2D}'), b'?', "a letter the fonts do not have");
        assert_eq!(win_ansi('\n'), b'?');
    }

    /// Every object's offset in the cross-reference table points at "N 0 obj", and the page count is right.
    fn check_structure(pdf: &[u8], pages: usize) {
        let text = String::from_utf8_lossy(pdf);
        assert!(text.starts_with("%PDF-1.4"));
        assert!(text.trim_end().ends_with("%%EOF"));
        let start: usize = text.rsplit("startxref\n").next().unwrap().lines().next().unwrap().parse().unwrap();
        assert!(text[start..].starts_with("xref\n0 "));
        let count: usize = text[start + 5..].split_whitespace().nth(1).unwrap().parse().unwrap();
        let rows: Vec<&str> = text[start..].lines().skip(3).take(count - 1).collect();
        for (i, row) in rows.iter().enumerate() {
            let off: usize = row[..10].parse().unwrap();
            assert!(text[off..].starts_with(&format!("{} 0 obj", i + 1)), "object {} is not where the table says", i + 1);
        }
        assert!(text.contains(&format!("/Count {pages}")));
        assert_eq!(text.matches("/Type /Page ").count(), pages);
    }

    #[test]
    fn a_document_has_the_right_structure_with_pictures_text_and_shapes() {
        let mut pdf = Pdf::new("My book");
        let jpeg = b"JPEGDATA".to_vec(); // stands in for a picture; plain text keeps the file easy to read in this test
        let img = pdf.add_jpeg(&jpeg, 2, 2);
        for p in 0..3 {
            let mut page = PageContent::new(595.0, 842.0);
            page.fill_rect(0.0, 0.0, 595.0, 842.0, [1.0, 1.0, 1.0]);
            if p > 0 {
                page.image(img, 40.0, 40.0, 200.0, 100.0);
            }
            page.text_line("Page (one) \u{2014} caf\u{E9}", 40.0, 700.0, 12.0, p == 2, [0.0, 0.0, 0.0]);
            pdf.add_page(page);
        }
        assert_eq!(pdf.page_count(), 3);
        let bytes = pdf.finish();
        check_structure(&bytes, 3);
        let text = String::from_utf8_lossy(&bytes);
        assert_eq!(text.matches("/Subtype /Image").count(), 1, "a picture used twice is stored once");
        assert_eq!(text.matches("/Im1 Do").count(), 2);
        assert!(text.contains("/BaseFont /Helvetica ") && text.contains("/BaseFont /Helvetica-Bold "));
        assert!(text.contains("/Title <4D7920626F6F6B>"), "the title");
        // the picture is placed from the top: a 100 high picture 40 from the top of an 842 high page starts at 702
        assert!(text.contains("200 0 0 100 40 702 cm"), "{}", text.lines().find(|l| l.contains(" cm")).unwrap_or(""));
    }

    #[test]
    fn a_document_with_no_pages_is_still_well_formed() {
        let bytes = Pdf::new("Empty").finish();
        check_structure(&bytes, 0);
    }

    #[test]
    fn sizes_convert_from_millimetres_to_points() {
        assert!((mm_to_pt(25.4) - 72.0).abs() < 1e-3);
        assert!((mm_to_pt(210.0) - 595.28).abs() < 0.05, "an A4 sheet is 595 points wide");
    }
}
