//! The resolution of an exported picture: how many pixels to the inch a printer or a layout program should use. It does not change the pixels, only
//! a note in the file, so it is written into the finished file: the JFIF header of a JPEG, a `pHYs` chunk in a PNG, and the resolution tags of a TIFF.

use std::fs;
use std::path::Path;

/// The most and the least that can be asked for.
pub const MIN_DPI: u32 = 36;
pub const MAX_DPI: u32 = 2400;

/// Write the resolution into the file at `path` (a JPEG, PNG or TIFF, found from its content). Other kinds are left alone.
pub fn set_dpi(path: &Path, dpi: u32) -> Result<(), String> {
    let dpi = dpi.clamp(MIN_DPI, MAX_DPI);
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let out = if bytes.starts_with(&[0xFF, 0xD8]) {
        jpeg(&bytes, dpi)
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        png(&bytes, dpi)
    } else if bytes.starts_with(b"II*\0") {
        tiff(&bytes, dpi)
    } else {
        return Ok(());
    };
    match out {
        Some(new) => fs::write(path, new).map_err(|e| e.to_string()),
        None => Ok(()), // not in a form this can add to: left as it is
    }
}

fn jpeg(b: &[u8], dpi: u32) -> Option<Vec<u8>> {
    let d = (dpi as u16).to_be_bytes();
    // a JFIF header right after the start: units 1 (per inch), then the two densities
    if b.get(2..4)? == [0xFF, 0xE0] && b.get(6..11)? == b"JFIF\0" {
        let mut out = b.to_vec();
        out[13] = 1;
        out[14..16].copy_from_slice(&d);
        out[16..18].copy_from_slice(&d);
        return Some(out);
    }
    let mut seg = vec![0xFF, 0xE0, 0, 16];
    seg.extend(b"JFIF\0");
    seg.extend([1, 1, 1]); // version 1.01, units: per inch
    seg.extend(d);
    seg.extend(d);
    seg.extend([0, 0]); // no thumbnail
    let mut out = b[..2].to_vec();
    out.extend(seg);
    out.extend(&b[2..]);
    Some(out)
}

pub(crate) fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (n, slot) in table.iter_mut().enumerate() {
        let mut c = n as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

fn png(b: &[u8], dpi: u32) -> Option<Vec<u8>> {
    // chunks follow the 8 byte signature: IHDR first. A pHYs chunk goes right after it (any older one is dropped).
    let ihdr_len = u32::from_be_bytes(b.get(8..12)?.try_into().ok()?) as usize;
    let after_ihdr = 8 + 12 + ihdr_len;
    let per_metre = (dpi as f64 / 0.0254).round() as u32;
    let mut data = Vec::new();
    data.extend(per_metre.to_be_bytes());
    data.extend(per_metre.to_be_bytes());
    data.push(1); // the unit is the metre
    let mut chunk = Vec::new();
    chunk.extend(9u32.to_be_bytes());
    let mut body = b"pHYs".to_vec();
    body.extend(&data);
    chunk.extend(&body);
    chunk.extend(crc32(&body).to_be_bytes());
    let mut out = b[..after_ihdr].to_vec();
    out.extend(chunk);
    // the rest, without an older pHYs
    let mut at = after_ihdr;
    while at + 12 <= b.len() {
        let len = u32::from_be_bytes(b[at..at + 4].try_into().ok()?) as usize;
        let end = at + 12 + len;
        if end > b.len() {
            return None;
        }
        if &b[at + 4..at + 8] != b"pHYs" {
            out.extend(&b[at..end]);
        }
        at = end;
    }
    Some(out)
}

fn tiff(b: &[u8], dpi: u32) -> Option<Vec<u8>> {
    let u16le = |o: usize| b.get(o..o + 2).map(|x| u16::from_le_bytes([x[0], x[1]]));
    let u32le = |o: usize| b.get(o..o + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]));
    let ifd = u32le(4)? as usize;
    let n = u16le(ifd)? as usize;
    let mut entries: Vec<[u8; 12]> = Vec::new();
    for i in 0..n {
        let e = ifd + 2 + i * 12;
        let raw: [u8; 12] = b.get(e..e + 12)?.try_into().ok()?;
        let tag = u16::from_le_bytes([raw[0], raw[1]]);
        if tag != 282 && tag != 283 && tag != 296 {
            entries.push(raw); // the resolution tags are replaced below
        }
    }
    let next_ifd = u32le(ifd + 2 + n * 12)?;
    // a new copy of the table at the end of the file, with the three tags added in their place in the order; the two RATIONAL values follow it
    let mut out = b.to_vec();
    if out.len() % 2 == 1 {
        out.push(0);
    }
    let table_at = out.len();
    let count = entries.len() + 3;
    let data_at = table_at + 2 + count * 12 + 4;
    let entry = |tag: u16, kind: u16, cnt: u32, value: u32| {
        let mut e = [0u8; 12];
        e[0..2].copy_from_slice(&tag.to_le_bytes());
        e[2..4].copy_from_slice(&kind.to_le_bytes());
        e[4..8].copy_from_slice(&cnt.to_le_bytes());
        e[8..12].copy_from_slice(&value.to_le_bytes());
        e
    };
    entries.push(entry(282, 5, 1, data_at as u32)); // XResolution, a RATIONAL held in the data after the table
    entries.push(entry(283, 5, 1, (data_at + 8) as u32));
    entries.push(entry(296, 3, 1, 2)); // ResolutionUnit: inches
    entries.sort_by_key(|e| u16::from_le_bytes([e[0], e[1]]));
    out.extend((count as u16).to_le_bytes());
    for e in &entries {
        out.extend(e);
    }
    out.extend(next_ifd.to_le_bytes());
    for _ in 0..2 {
        out.extend(dpi.to_le_bytes());
        out.extend(1u32.to_le_bytes());
    }
    out[4..8].copy_from_slice(&(table_at as u32).to_le_bytes());
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn picture() -> ImageBuffer<Rgb<u8>, Vec<u8>> {
        ImageBuffer::from_fn(40, 30, |x, y| Rgb([(x * 6) as u8, (y * 8) as u8, 100]))
    }

    #[test]
    fn a_jpeg_gets_its_density_in_the_jfif_header_and_still_opens() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jpg");
        picture().save(&p).unwrap();
        set_dpi(&p, 300).unwrap();
        let b = fs::read(&p).unwrap();
        assert_eq!(&b[2..4], &[0xFF, 0xE0]);
        assert_eq!(&b[6..11], b"JFIF\0");
        assert_eq!((b[13], u16::from_be_bytes([b[14], b[15]]), u16::from_be_bytes([b[16], b[17]])), (1, 300, 300));
        assert_eq!(image::image_dimensions(&p).unwrap(), (40, 30));
        // and again with a different number
        set_dpi(&p, 72).unwrap();
        assert_eq!(u16::from_be_bytes([fs::read(&p).unwrap()[14], fs::read(&p).unwrap()[15]]), 72);
    }

    #[test]
    fn a_png_gets_a_phys_chunk_with_the_right_crc_and_only_one() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.png");
        picture().save(&p).unwrap();
        set_dpi(&p, 300).unwrap();
        set_dpi(&p, 300).unwrap(); // twice: still one chunk
        let b = fs::read(&p).unwrap();
        let count = b.windows(4).filter(|w| *w == b"pHYs").count();
        assert_eq!(count, 1);
        let at = b.windows(4).position(|w| w == b"pHYs").unwrap() - 4;
        assert_eq!(u32::from_be_bytes(b[at..at + 4].try_into().unwrap()), 9);
        let x = u32::from_be_bytes(b[at + 8..at + 12].try_into().unwrap());
        assert_eq!(x, 11811, "300 per inch is 11811 per metre");
        assert_eq!(b[at + 16], 1);
        let crc = u32::from_be_bytes(b[at + 17..at + 21].try_into().unwrap());
        assert_eq!(crc, crc32(&b[at + 4..at + 17]));
        assert_eq!(image::image_dimensions(&p).unwrap(), (40, 30));
        assert_eq!(image::open(&p).unwrap().to_rgb8(), picture());
    }

    #[test]
    fn a_tiff_gets_its_resolution_tags_and_the_picture_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.tif");
        picture().save(&p).unwrap();
        set_dpi(&p, 300).unwrap();
        let b = fs::read(&p).unwrap();
        let ifd = u32::from_le_bytes(b[4..8].try_into().unwrap()) as usize;
        let n = u16::from_le_bytes(b[ifd..ifd + 2].try_into().unwrap()) as usize;
        let mut tags = std::collections::HashMap::new();
        let mut last = 0u16;
        for i in 0..n {
            let e = ifd + 2 + i * 12;
            let tag = u16::from_le_bytes([b[e], b[e + 1]]);
            assert!(tag > last, "the tags are in order");
            last = tag;
            tags.insert(tag, u32::from_le_bytes(b[e + 8..e + 12].try_into().unwrap()));
        }
        assert_eq!(tags[&296], 2);
        let x = tags[&282] as usize;
        assert_eq!((u32::from_le_bytes(b[x..x + 4].try_into().unwrap()), u32::from_le_bytes(b[x + 4..x + 8].try_into().unwrap())), (300, 1));
        assert_eq!(image::open(&p).unwrap().to_rgb8(), picture());
        // other kinds of file are left alone, and a number outside the range is brought into it
        let w = dir.path().join("a.webp");
        fs::write(&w, b"RIFFxxxxWEBP").unwrap();
        set_dpi(&w, 300).unwrap();
        assert_eq!(fs::read(&w).unwrap(), b"RIFFxxxxWEBP");
        let j = dir.path().join("b.jpg");
        picture().save(&j).unwrap();
        set_dpi(&j, 5).unwrap();
        assert_eq!(u16::from_be_bytes([fs::read(&j).unwrap()[14], fs::read(&j).unwrap()[15]]), MIN_DPI as u16);
    }
}
