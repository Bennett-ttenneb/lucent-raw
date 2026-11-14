//! Writing a RAW file as a DNG (the open RAW format): "Copy as DNG" on import and the DNG choice on export. The picture data is not
//! changed, only kept in a different wrapping that every program can read; the original file can be embedded inside it.

use rawler::dng::convert::{convert_raw_file, ConvertParams};
use std::fs;
use std::io::BufWriter;
use std::path::Path;

/// Write `raw` as a DNG at `dest` (made new; a half-written file is removed if the conversion fails). With `embed`, the original RAW file
/// is packed inside the DNG too, so it can be got back. The pictures are stored without loss.
pub fn convert(raw: &Path, dest: &Path, embed: bool) -> Result<(), String> {
    let params = ConvertParams { embedded: embed, software: "Lucent Raw".into(), ..ConvertParams::default() };
    let file = fs::File::create(dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    let mut out = BufWriter::new(file);
    let result = convert_raw_file(raw, &mut out, &params);
    let flushed = std::io::Write::flush(&mut out);
    drop(out);
    match (result, flushed) {
        (Ok(_), Ok(())) => Ok(()),
        (Err(e), _) => {
            let _ = fs::remove_file(dest);
            Err(format!("{} could not be converted to DNG: {e}", raw.file_name().and_then(|n| n.to_str()).unwrap_or("The file")))
        }
        (_, Err(e)) => {
            let _ = fs::remove_file(dest);
            Err(format!("{}: {e}", dest.display()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_that_is_not_a_raw_file_is_refused_in_words_and_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("fake.cr2");
        fs::write(&src, b"this is not a raw file at all").unwrap();
        let out = dir.path().join("fake.dng");
        let e = convert(&src, &out, false).unwrap_err();
        assert!(e.contains("fake.cr2 could not be converted to DNG"), "{e}");
        assert!(!out.exists(), "a failed conversion leaves no file");
    }
}
